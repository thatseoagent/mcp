/**
 * One reading of a robots.txt, for everything that needs one.
 *
 * There were six. `robots-analyzer` had a parser, `crawlability-analyzer` had a
 * parser, `geo-analyzer` split the file with a regex, `site-crawler` built
 * regexes from disallow lines, and `ai-visibility-tools` split it on blank
 * lines. Four different matching algorithms over one file, and they disagreed on
 * inputs as ordinary as this:
 *
 *     User-agent: GPTBot
 *     Disallow: /admin/
 *
 * One audit reported "GPTBot blocked" in its robots section and "GPTBot is
 * allowed" in its GEO and AI-visibility sections, from the same bytes, because
 * `robots-analyzer` counted any disallow rule as a block while the other two
 * only looked for a literal `Disallow: /`.
 *
 * The crawler's copy was worse than inconsistent, it was wrong:
 *
 *   - `$` was escaped as a literal, so `Disallow: /*.pdf$` never matched and it
 *     fetched files the crawlability audit reported as blocked.
 *   - `Allow:` lines were not parsed at all, so every page under an
 *     `Allow`-carved exception was silently missing from `crawl_site`.
 *   - Group selection unioned the `*` block with our own, so a site whose
 *     robots.txt invited ThatSEOAgentBot by name was refused anyway.
 *
 * Google's rules, implemented once: most-specific user-agent wins, repeated
 * blocks for one agent merge, the longest matching path wins, ties go to
 * `allow`, and `*` and `$` are the only two wildcards — everything else in a
 * pattern is a literal, which matters because real files are full of `?`, `.`
 * and `(` that a naive conversion would reinterpret.
 */

export interface RobotsRule {
  type: "allow" | "disallow";
  pattern: string;
}

export interface RobotsGroup {
  userAgent: string;
  rules: RobotsRule[];
}

export interface RobotsIssue {
  type: "syntax" | "conflict" | "warning";
  message: string;
  line?: number;
}

/** Google's stated ceiling; everything past it is ignored. */
const ROBOTS_MAX_BYTES = 500 * 1024;

/**
 * Fields that are real elsewhere and ignored by Google. Naming them beats
 * "Unknown directive", which told an author nothing about who does honour it.
 */
const HONOURED_ELSEWHERE: Record<string, string> = {
  "crawl-delay":
    "Crawl-delay is ignored by Google (it supports only user-agent, allow, disallow and sitemap). Other crawlers may honour it. To slow Googlebot, use Search Console's crawl rate setting.",
  host: "Host is not supported by Google (Yandex uses it).",
  "clean-param": "Clean-param is not supported by Google (Yandex uses it).",
  "request-rate": "Request-rate is not supported by Google (other engines may use it).",
  "visit-time": "Visit-time is not supported by Google (other engines may use it).",
};

// ── Matching ─────────────────────────────────────────────────────────────────

/**
 * A robots.txt path pattern as a regular expression.
 *
 * `*` is "0 or more of any character" and a trailing `$` anchors to the end of
 * the URL. Every other character is a literal, escaped so that `/search?q=` does
 * not quietly become an optional `h`.
 */
function patternToRegExp(pattern: string): RegExp {
  const anchoredToEnd = pattern.endsWith("$");
  const body = anchoredToEnd ? pattern.slice(0, -1) : pattern;

  const source = body
    .split("*")
    .map((literal) => literal.replace(/[.+?^${}()|[\]\\]/g, "\\$&"))
    .join(".*");

  return new RegExp(`^${source}${anchoredToEnd ? "$" : ""}`);
}

/** Pattern length, for precedence. Google decides conflicts by rule-path length. */
function specificity(pattern: string): number {
  return pattern.replace(/\$$/, "").length;
}

/**
 * The rules that apply to this crawler, with every block for it merged.
 *
 * Google picks "the group with the most specific user agent that matches", so an
 * explicit `Googlebot` section wins over `*` even when `*` is more restrictive
 * and appears later. A file may address one crawler in several blocks and Google
 * treats them as one set; taking only the first fails open, which is how a rule
 * in a second `User-agent: *` section used to vanish.
 */
export function groupFor(groups: RobotsGroup[], userAgent: string): RobotsGroup | null {
  const target = userAgent.toLowerCase();

  let bestLength = -1;
  let bestAgent: string | null = null;

  for (const group of groups) {
    const declared = group.userAgent.toLowerCase();
    const matches = declared === "*" ? true : target.startsWith(declared);
    if (!matches) continue;

    // `*` is the fallback, never the most specific, so it scores zero rather
    // than its single character.
    const length = declared === "*" ? 0 : declared.length;
    if (length > bestLength) {
      bestLength = length;
      bestAgent = declared;
    }
  }

  if (bestAgent === null) return null;

  const rules = groups
    .filter((group) => group.userAgent.toLowerCase() === bestAgent)
    .flatMap((group) => group.rules);

  return { userAgent: bestAgent, rules };
}

/**
 * Is `path` crawlable by `userAgent`?
 *
 * `path` is the URL path plus query, which is what patterns are written against.
 * With no matching group, or no matching rule, the answer is yes: robots.txt is
 * an opt-out and anything it does not name is allowed.
 */
export function isPathAllowed(
  groups: RobotsGroup[],
  path: string,
  userAgent = "Googlebot"
): boolean {
  const group = groupFor(groups, userAgent);
  if (!group) return true;

  let verdict: "allow" | "disallow" | null = null;
  let winning = -1;

  for (const rule of group.rules) {
    // An empty Disallow means "allow everything" and matches nothing.
    if (rule.type === "disallow" && rule.pattern === "") continue;
    if (!patternToRegExp(rule.pattern).test(path)) continue;

    const length = specificity(rule.pattern);
    if (length > winning) {
      winning = length;
      verdict = rule.type;
    } else if (length === winning && rule.type === "allow") {
      // Equal specificity: Google "uses the least restrictive rule".
      verdict = "allow";
    }
  }

  return verdict !== "disallow";
}

// ── The ruleset ──────────────────────────────────────────────────────────────

export interface RobotsRuleset {
  /** False when the site serves no robots.txt. Nothing is disallowed. */
  readonly exists: boolean;
  readonly groups: RobotsGroup[];
  readonly sitemaps: string[];
  readonly issues: RobotsIssue[];

  /** Can this crawler fetch this path? */
  allows(path: string, userAgent?: string): boolean;

  /**
   * Is this crawler shut out of the site altogether?
   *
   * The site root, and only the root. `Disallow: /admin/` restricts a crawler;
   * it does not block it, and reporting otherwise is what made one audit
   * contradict itself in three places.
   */
  blocksEntirely(userAgent: string): boolean;

  /** The disallow patterns in force for this crawler, for reporting. */
  restrictionsFor(userAgent: string): string[];
}

/** A site with no robots.txt: everything is crawlable. */
export const NO_ROBOTS: RobotsRuleset = makeRuleset(false, [], [], []);

function makeRuleset(
  exists: boolean,
  groups: RobotsGroup[],
  sitemaps: string[],
  issues: RobotsIssue[]
): RobotsRuleset {
  return {
    exists,
    groups,
    sitemaps,
    issues,
    allows: (path, userAgent) => isPathAllowed(groups, path, userAgent),
    blocksEntirely: (userAgent) => !isPathAllowed(groups, "/", userAgent),
    restrictionsFor: (userAgent) =>
      (groupFor(groups, userAgent)?.rules ?? [])
        .filter((r) => r.type === "disallow" && r.pattern !== "")
        .map((r) => r.pattern),
  };
}

/**
 * Read a robots.txt.
 *
 * Reports what Google will ignore as well as what it will obey, because a rule
 * that looks like it works and does not is worse than one that is obviously
 * absent — `Noindex:` being the standard example.
 */
export function parseRobots(text: string): RobotsRuleset {
  const groups: RobotsGroup[] = [];
  const sitemaps: string[] = [];
  const issues: RobotsIssue[] = [];

  const bytes = Buffer.byteLength(text, "utf8");
  if (bytes > ROBOTS_MAX_BYTES) {
    issues.push({
      type: "warning",
      message: `robots.txt is ${Math.round(bytes / 1024)} KiB. Google enforces a 500 KiB limit and ignores everything after it, so any rule past that point has no effect.`,
    });
  }

  let current: RobotsGroup | null = null;
  // Consecutive User-agent lines share one set of rules, which is how a file
  // addresses several crawlers at once. Starting a fresh group per line would
  // hand the rules to the last one only.
  let startedRules = false;

  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].split("#")[0].trim();
    const lineNumber = i + 1;
    if (!line) continue;

    const colon = line.indexOf(":");
    if (colon === -1) {
      issues.push({ type: "syntax", message: `Invalid syntax (missing colon): ${line}`, line: lineNumber });
      continue;
    }

    const field = line.slice(0, colon).trim().toLowerCase();
    const value = line.slice(colon + 1).trim();

    // An empty Disallow is the standard "allow everything" idiom, not an error.
    // It was reported as a syntax error and dropped, which both misinformed the
    // author and lost the rule.
    if (!value && field !== "disallow") {
      issues.push({ type: "syntax", message: `Empty value for ${field}`, line: lineNumber });
      continue;
    }

    if (field === "user-agent") {
      if (!current || startedRules) {
        current = { userAgent: value, rules: [] };
        groups.push(current);
        startedRules = false;
      } else {
        groups.push({ userAgent: value, rules: current.rules });
      }
      continue;
    }

    if (field === "allow" || field === "disallow") {
      if (!current) {
        issues.push({
          type: "syntax",
          message: `${field === "allow" ? "Allow" : "Disallow"} directive before User-agent`,
          line: lineNumber,
        });
        continue;
      }
      current.rules.push({ type: field, pattern: value });
      startedRules = true;
      continue;
    }

    if (field === "sitemap") {
      sitemaps.push(value);
      continue;
    }

    // `Noindex:` and `Nofollow:` read like they work. Google has never supported
    // either, and they are usually paired with a Disallow that then stops the
    // real noindex from ever being seen.
    if (field === "noindex" || field === "nofollow") {
      issues.push({
        type: "conflict",
        message: `"${field}" is not a robots.txt directive and Google ignores it. Robots.txt is not a mechanism for keeping a page out of Google — use a noindex meta tag or X-Robots-Tag header on the page itself, and make sure the page is not also disallowed here.`,
        line: lineNumber,
      });
      continue;
    }

    const elsewhere = HONOURED_ELSEWHERE[field];
    issues.push({
      type: "warning",
      message: elsewhere ?? `Unknown directive: ${field}`,
      line: lineNumber,
    });
  }

  return makeRuleset(true, groups, sitemaps, issues);
}

/**
 * What an HTTP status for `/robots.txt` actually tells you.
 *
 * Three outcomes, and the first two are both **answers**:
 *
 * - `read` — there is a file; parse it.
 * - `absent` — 404 or 410. A definite answer: no file means no rules, so every
 *   crawler is allowed. Treat it as an empty ruleset, not as a failure.
 * - `unavailable` — anything else, including a 5xx and a request that never
 *   completed. We did not find out, and saying "allowed" from that invents a fact.
 *
 * Extracted so the classification can be tested without a network, and named here
 * because this module already owns one reading of robots.txt for every consumer.
 * `crawlability-analyzer.isCrawlAllowed` has drawn the same line inline since before
 * this existed; `checkAiBotAccess` did not, and tested only for "no response at all",
 * so a 5xx that served a body reported a clean pass and a timeout of ours cost the
 * site 8 points (#337).
 *
 * A status of 0 means the request never completed and is therefore `unavailable`.
 */
export function classifyRobotsStatus(status: number): "read" | "absent" | "unavailable" {
  if (status === 404 || status === 410) return "absent";
  if (status >= 200 && status < 300) return "read";
  return "unavailable";
}
