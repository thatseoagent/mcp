/**
 * Do the links an `llms.txt` declares actually go anywhere?
 *
 * `seo_llms_txt` counted them and stopped: "Content links: 12 absolute URLs
 * found" was printed about a file whose twelve links all 404. From the reader's
 * side that sentence is an endorsement, and it was unearned — the same reasoning
 * error `docs/research/checks-that-cannot-run.md` and #337 are about, in a new
 * place: **empty reading as clean.** Twelve links nobody fetched read exactly like
 * twelve links that work.
 *
 * The severity is what makes it worth requests: `llms.txt` is a navigation index.
 * An agent that reads it and follows a dead link treats the dead end as a dead end
 * for the whole site, not for one URL.
 *
 * ## A 200 is not a pass
 *
 * The case a naive `res.ok` gets wrong, and the reason this module exists rather
 * than three lines in the handler: a single-page app answers **every** unknown
 * path with its shell at status 200. Following each link and asserting `res.ok`
 * passes every dead link in the file. So the homepage is fetched once and each
 * response is compared against it — a body that is the homepage, or a redirect
 * that lands on the homepage, is a dead link wearing a 200.
 *
 * ## Three outcomes, and the third is not a failure
 *
 * A timeout is not a dead link. `resolves` / `broken` are answers; `unreachable`
 * is `not-evaluated`, and the caller is expected to say the coverage was partial
 * rather than average over it (`lib/analyzers/scored-checks.ts`).
 */

import { fetchAnyStatus } from "./http-client";
import { RobotsDisallowedError } from "./robots-gate";
import { PAGE_AUDIT_USER_AGENT } from "./bot-identity";

/**
 * How many declared links are probed in one run.
 *
 * A bound, because a 140-line `llms.txt` must not turn one tool call into 140
 * requests against someone's server. Five is enough to tell a file whose links
 * work from one whose links do not, and the number is **printed with the
 * finding**: a silent cap reads as full coverage, which is the failure this repo
 * has already paid for once (#400).
 */
export const LINK_SAMPLE = 5;

/** Per-request budget for a link probe. */
const LINK_TIMEOUT = 8_000;

export type LinkProbe =
  | { url: string; outcome: "resolves"; status: number }
  | { url: string; outcome: "broken"; status: number; reason: string }
  /**
   * `blockedByRobots` because the two no-answers deserve different advice: a
   * timeout is worth a retry, a `Disallow` is the site's own instruction and
   * retrying it would mean ignoring it.
   */
  | { url: string; outcome: "unreachable"; reason: string; blockedByRobots?: boolean };

export type LinkAudit = {
  /**
   * Whether the homepage could be read, which is what the shell comparison needs.
   *
   * When it could not, a link answering 200 with the app shell is indistinguishable
   * from one answering 200 with real content, and every probe silently falls back
   * to `res.ok` — the exact check #390 exists to replace. The caller says so rather
   * than reporting a pass it did not earn.
   */
  shellCheckRan: boolean;
  /** Absolute links the file declares. */
  declared: number;
  /** How many of them we asked for. Always ≤ {@link LINK_SAMPLE}. */
  probed: number;
  /** Probes that reached real content. */
  resolves: number;
  /** Probes that reached a 4xx/5xx, or the homepage wearing a 200. */
  broken: Extract<LinkProbe, { outcome: "broken" }>[];
  /** Probes that produced no answer. These are `not-evaluated`, not failures. */
  unreachable: Extract<LinkProbe, { outcome: "unreachable" }>[];
};

export type ParsedLinks = {
  /** Distinct absolute URLs, in file order. What gets probed. */
  absolute: string[];
  /** Link lines whose target is not absolute. Reported as its own issue. */
  relative: number;
  /** Every markdown link line, before de-duplication. */
  lines: number;
};

/**
 * Every link an `llms.txt` declares, parsed once.
 *
 * One parse, because two nearly-identical regexes in two files is how the counts
 * disagree: the handler used to derive its relative-link count by subtracting the
 * absolute count from the line count, and de-duplicating the absolute list here
 * made a file that repeats one URL report a relative link it does not have.
 *
 * Markdown link lines only — `- [Title](https://…): description` — which is the
 * shape `llmstxt.org` specifies. Relative links are counted and not resolved:
 * resolving them would mean guessing a base the file never stated.
 */
export function parseLinks(content: string): ParsedLinks {
  const absolute: string[] = [];
  let lines = 0;
  let relative = 0;

  for (const line of content.split(/\r?\n/)) {
    const link = line.match(/^\s*-\s+\[.*?\]\(([^)\s]+)/);
    if (!link) continue;
    lines += 1;
    if (/^https?:\/\//i.test(link[1])) absolute.push(link[1]);
    else relative += 1;
  }

  return { absolute: [...new Set(absolute)], relative, lines };
}

/**
 * Is this URL the site's front door, whatever host or scheme spells it?
 *
 * The exemption the shell comparison needs: a file may legitimately link its own
 * homepage, and that link is not "a page that turns out to be the homepage". Asked
 * of the path rather than of the whole URL, so `https://www.example.com/` and
 * `https://example.com` are both the front door without a list of host variants to
 * keep in step.
 */
function isFrontDoor(url: string): boolean {
  try {
    return new URL(url).pathname.replace(/\/+$/, "") === "";
  } catch {
    return false;
  }
}

/**
 * The part of a document that identifies it, for comparison against another.
 *
 * Not the raw bytes. A shell carries a CSP nonce, a build id, an inline analytics
 * timestamp, a Next.js flight payload naming the requested path — all inside
 * `<script>`, all different per request, and any of them defeats a byte comparison
 * on a page that is otherwise the same shell. Scripts, styles and comments come
 * out; what is left is the markup a reader would see.
 *
 * Still an equality test, so a shell that injects a per-route `<title>` or
 * canonical outside a script is not caught. That limit is stated in the finding
 * rather than papered over: this check produces evidence, and its silence is not
 * evidence of the opposite.
 */
function signature(html: string): string {
  return html
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, "")
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, "")
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, MAX_BODY_CHARS);
}

/**
 * How much of a body is kept for comparison.
 *
 * Two documents that agree for this many characters are the same document as far
 * as this check is concerned, and the cap keeps a probe of someone's 5 MB page
 * from becoming 5 MB of ours.
 */
const MAX_BODY_CHARS = 200_000;

/**
 * Fetch the homepage once, for the shell comparison.
 *
 * Returns `null` when we could not read it, and the caller then declines to make
 * the shell claim at all rather than guessing: "this link is the homepage" is a
 * statement about a document we would not have.
 */
async function readHomepage(origin: string): Promise<string | null> {
  try {
    const { response } = await fetchAnyStatus(origin, { timeout: LINK_TIMEOUT });
    if (!response.ok) return null;
    return signature(await response.text());
  } catch {
    return null;
  }
}

async function probeLink(url: string, origin: string, homepage: string | null): Promise<LinkProbe> {
  try {
    const { response, finalUrl } = await fetchAnyStatus(url, { timeout: LINK_TIMEOUT });

    if (!response.ok) {
      return { url, outcome: "broken", status: response.status, reason: `HTTP ${response.status}` };
    }

    // A link that declares a page and lands on the front door is a dead end. The
    // front door linking to itself is not, which is what the second clause spares.
    if (isFrontDoor(finalUrl) && !isFrontDoor(url)) {
      return {
        url,
        outcome: "broken",
        status: response.status,
        reason: `HTTP ${response.status}, redirected to the homepage — the link does not go anywhere of its own`,
      };
    }

    if (homepage !== null && !isFrontDoor(url) && signature(await response.text()) === homepage) {
      return {
        url,
        outcome: "broken",
        status: response.status,
        reason: `HTTP ${response.status} serving markup identical to the homepage — the app-shell answer an SPA gives to any unknown path, which a status check would have passed. If this page really is a copy of the homepage, the link is still not worth an agent's request`,
      };
    }

    return { url, outcome: "resolves", status: response.status };
  } catch (error) {
    if (error instanceof RobotsDisallowedError) {
      return {
        url,
        outcome: "unreachable",
        reason: "robots.txt disallows it for our crawler, and we honour that",
        blockedByRobots: true,
      };
    }
    const message = error instanceof Error ? error.message : String(error);
    return { url, outcome: "unreachable", reason: message };
  }
}

/**
 * Probe a bounded sample of the links a file declares.
 *
 * The homepage is read first and once: every probe needs it, and fetching it per
 * link would multiply the cost of the check by the size of the sample.
 */
export async function auditDeclaredLinks(links: readonly string[], origin: string): Promise<LinkAudit> {
  const sample = links.slice(0, LINK_SAMPLE);
  if (sample.length === 0) {
    return { shellCheckRan: false, declared: links.length, probed: 0, resolves: 0, broken: [], unreachable: [] };
  }

  const homepage = await readHomepage(origin);
  const probes = await Promise.all(sample.map((link) => probeLink(link, origin, homepage)));

  return {
    shellCheckRan: homepage !== null,
    declared: links.length,
    probed: sample.length,
    resolves: probes.filter((probe) => probe.outcome === "resolves").length,
    broken: probes.filter((probe): probe is Extract<LinkProbe, { outcome: "broken" }> => probe.outcome === "broken"),
    unreachable: probes.filter(
      (probe): probe is Extract<LinkProbe, { outcome: "unreachable" }> => probe.outcome === "unreachable",
    ),
  };
}

/**
 * The sentence that says how much of the file was actually checked.
 *
 * Exported because the handler prints it in two places and they must not drift:
 * the count of what was probed is the qualifier that makes the finding readable,
 * and #390's acceptance names it directly.
 */
export function coverageOf(audit: LinkAudit): string {
  const scope =
    audit.declared > audit.probed
      ? `${audit.probed} of the ${audit.declared} declared links probed (cap of ${LINK_SAMPLE} per run)`
      : `all ${audit.probed} declared link${audit.probed === 1 ? "" : "s"} probed`;
  return audit.unreachable.length > 0
    ? `${scope}; ${audit.unreachable.length} could not be reached on this run, so coverage was incomplete`
    : scope;
}
