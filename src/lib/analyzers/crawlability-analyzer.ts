/**
 * Crawlability audit analyzer.
 * Checks canonical tags, redirect chains, and indexability directives.
 */

import { load } from "cheerio";
import { fetchWithoutRedirect, fetchWithTimeout, validateUrl } from "../http-client";
import { parseRobots } from "./robots-ruleset";
import { type Result, success, failure } from "../type-guards";
import { annotate, GOOGLE_SAYS, type CheckSource } from "./check-source";

/**
 * Long redirect chains are our concern, not Google's stated one. Google
 * documents no hop limit; it documents which redirect kinds canonicalize.
 */
const REDIRECT_CHAIN_HEURISTIC: CheckSource = {
  kind: "heuristic",
  rationale: "Google publishes no maximum hop count; this is about latency and fragility",
};

export interface CanonicalConflict {
  /**
   * `self_reference` is gone. Pointing the canonical at another URL is the
   * feature, not a defect — see `analyzeCanonical`.
   */
  type: "html_vs_http" | "cross_domain" | "relative" | "invalid";
  message: string;
}

export interface RedirectHop {
  url: string;
  statusCode: number;
  location: string | null;
}

export interface CrawlabilityIssue {
  type: "critical" | "warning" | "info";
  category: "canonical" | "redirect" | "indexability" | "other";
  message: string;
}

export interface CrawlabilityAuditResult {
  url: string;
  canonicalAnalysis: {
    htmlCanonical: string | null;
    httpCanonical: string | null;
    conflicts: CanonicalConflict[];
  };
  redirectAnalysis: {
    redirectChain: RedirectHop[];
    chainLength: number;
    finalUrl: string;
    issues: string[];
  };
  indexability: {
    robotsMetaTag: string | null;
    xRobotsTagHeader: string | null;
    blocked: boolean;
    blockReasons: string[];
  };
  issues: CrawlabilityIssue[];
}

/**
 * Audit crawlability of a URL.
 * Returns Result type for explicit error handling.
 */
export async function auditCrawlability(
  url: string
): Promise<Result<CrawlabilityAuditResult>> {
  try {
    validateUrl(url);

  // Follow redirect chain
  const redirectAnalysis = await analyzeRedirectChain(url);

  // Fetch final URL for canonical and indexability checks
  const finalUrl = redirectAnalysis.finalUrl;
  const response = await fetchWithoutRedirect(finalUrl);
  const html = await response.text();
  const $ = load(html);

  // Analyze canonical tags
  const canonicalAnalysis = analyzeCanonical($, response.headers, finalUrl);

  // Analyze indexability
  const indexability = analyzeIndexability($, response.headers);

  // A page's own directives only count if Googlebot is allowed to fetch it, so
  // robots.txt is part of judging indexability rather than a separate report.
  const crawlAllowed = await isCrawlAllowed(finalUrl);

  // Detect issues
  const issues = detectCrawlabilityIssues({
    canonicalAnalysis,
    redirectAnalysis,
    indexability,
    crawlAllowed,
    originalUrl: url,
    finalUrl,
  });

  return success({
    url,
    canonicalAnalysis,
    redirectAnalysis,
    indexability,
    issues,
  });
  } catch (error) {
    const err = error instanceof Error ? error : new Error(String(error));
    return failure(err);
  }
}

/**
 * Analyze canonical tags from HTML and HTTP headers.
 */
function analyzeCanonical(
  $: ReturnType<typeof load>,
  headers: Headers,
  currentUrl: string
): {
  htmlCanonical: string | null;
  httpCanonical: string | null;
  conflicts: CanonicalConflict[];
} {
  // Extract HTML canonical
  const htmlCanonical =
    $('link[rel="canonical"]').attr("href")?.trim() || null;

  // Extract HTTP Link header canonical
  let httpCanonical: string | null = null;
  const linkHeader = headers.get("link");
  if (linkHeader) {
    const canonicalMatch = linkHeader.match(/<([^>]+)>;\s*rel="canonical"/i);
    if (canonicalMatch) {
      httpCanonical = canonicalMatch[1];
    }
  }

  // Detect conflicts
  const conflicts: CanonicalConflict[] = [];

  // Conflict: HTML and HTTP canonical differ
  if (
    htmlCanonical &&
    httpCanonical &&
    normalizeUrl(htmlCanonical) !== normalizeUrl(httpCanonical)
  ) {
    conflicts.push({
      type: "html_vs_http",
      message: `HTML canonical (${htmlCanonical}) differs from HTTP header canonical (${httpCanonical})`,
    });
  }

  // A canonical that points somewhere else is not a fault. It is what
  // rel="canonical" is *for*: consolidating duplicates onto the preferred URL.
  // This function used to raise a `self_reference` conflict on every such page,
  // which meant a filtered listing correctly pointing at its clean URL — the
  // textbook use — was reported as a problem.
  //
  // What Google does name as mistakes are shape errors, and those are checked
  // instead: a relative href, a fragment, an unparseable value, and a canonical
  // pointing off-domain (legitimate for syndication, but rarely intended, so it
  // stays a finding the reader can dismiss).
  const canonicalUrl = htmlCanonical || httpCanonical;
  if (canonicalUrl) {
    if (canonicalUrl.startsWith("#")) {
      conflicts.push({
        type: "invalid",
        message: `Canonical is a fragment, which Google ignores: ${canonicalUrl}`,
      });
    } else if (!/^https?:\/\//i.test(canonicalUrl)) {
      // Google: "Always specify absolute URLs, not relative URLs."
      conflicts.push({
        type: "relative",
        message: `Canonical is a relative URL (${canonicalUrl}); Google asks for an absolute URL including https://`,
      });
    } else {
      try {
        const canonicalDomain = new URL(canonicalUrl, currentUrl).hostname;
        const currentDomain = new URL(currentUrl).hostname;

        if (canonicalDomain !== currentDomain) {
          conflicts.push({
            type: "cross_domain",
            message: `Canonical points to a different domain (${canonicalUrl}) — intended for syndicated content, otherwise this hands the page to that domain`,
          });
        }
      } catch {
        conflicts.push({
          type: "invalid",
          message: `Canonical is not a parseable URL: ${canonicalUrl}`,
        });
      }
    }
  }

  return {
    htmlCanonical,
    httpCanonical,
    conflicts,
  };
}

/**
 * Analyze redirect chain.
 */
async function analyzeRedirectChain(
  url: string
): Promise<{
  redirectChain: RedirectHop[];
  chainLength: number;
  finalUrl: string;
  issues: string[];
}> {
  const redirectChain: RedirectHop[] = [];
  const issues: string[] = [];
  const maxHops = 10; // Prevent infinite loops

  let currentUrl = url;
  let hops = 0;

  while (hops < maxHops) {
    const response = await fetchWithoutRedirect(currentUrl);
    const statusCode = response.status;
    const location = response.headers.get("location");

    redirectChain.push({
      url: currentUrl,
      statusCode,
      location,
    });

    // Stop if not a redirect
    if (statusCode < 300 || statusCode >= 400) {
      break;
    }

    // Follow redirect
    if (!location) {
      issues.push(`Redirect at ${currentUrl} missing Location header`);
      break;
    }

    // Resolve relative URLs
    try {
      currentUrl = new URL(location, currentUrl).href;
    } catch {
      issues.push(`Invalid redirect Location: ${location}`);
      break;
    }

    hops++;

    // Check for redirect loop
    const visitedUrls = redirectChain.map((hop) => hop.url);
    if (visitedUrls.includes(currentUrl)) {
      issues.push(`Redirect loop detected at ${currentUrl}`);
      break;
    }
  }

  if (hops >= maxHops) {
    issues.push(`Redirect chain exceeded ${maxHops} hops`);
  }

  // Detect long redirect chains
  const redirectCount = redirectChain.filter(
    (hop) => hop.statusCode >= 300 && hop.statusCode < 400
  ).length;

  // Google publishes no maximum hop count, so the old "Recommended: ≤2" was
  // invented and the two-tier warning invented twice. What is true is that every
  // hop is latency for a user and a chance for a rule to be misconfigured, so a
  // long chain is worth mentioning as ours.
  if (redirectCount > 3) {
    issues.push(
      annotate(
        `Redirect chain of ${redirectCount} hops — Google follows these, but each hop costs the user time and adds a place for the chain to break`,
        REDIRECT_CHAIN_HEURISTIC
      )
    );
  }

  const finalUrl = redirectChain[redirectChain.length - 1].url;

  return {
    redirectChain,
    chainLength: redirectCount,
    finalUrl,
    issues,
  };
}

/**
 * Whether robots.txt lets Googlebot fetch this URL.
 *
 * `null` when robots.txt could not be read, which is deliberately distinct from
 * `true`: an unreachable robots.txt means we do not know, and reporting "not
 * blocked" from ignorance is how a tool tells a confident lie. Callers only
 * raise the combined finding when the answer is a definite `false`.
 */
async function isCrawlAllowed(url: string): Promise<boolean | null> {
  const target = new URL(url);

  let body: string;
  try {
    // `fetchWithTimeout` throws on any non-2xx, so the status has to be read back
    // out of the message. Checking `response.status` here was dead code: a 404
    // never reached it.
    const response = await fetchWithTimeout(
      new URL("/robots.txt", target.origin).href,
      10_000
    );
    body = await response.text();
  } catch (error) {
    // No robots.txt is a definite answer: nothing is disallowed. Any other
    // failure is not — a 500 or a timeout means we could not find out, and
    // saying "allowed" from that would be inventing a fact.
    const message = error instanceof Error ? error.message : "";
    return /HTTP 40[34]\b/.test(message) ? true : null;
  }

  return parseRobots(body).allows(
    `${target.pathname}${target.search}`,
    "Googlebot"
  );
}

/**
 * Analyze indexability directives.
 */
function analyzeIndexability(
  $: ReturnType<typeof load>,
  headers: Headers
): {
  robotsMetaTag: string | null;
  xRobotsTagHeader: string | null;
  blocked: boolean;
  blockReasons: string[];
} {
  // Check robots meta tag
  const robotsMetaTag =
    $('meta[name="robots"]').attr("content")?.trim() || null;

  // Check X-Robots-Tag header
  const xRobotsTagHeader = headers.get("x-robots-tag");

  // Determine if indexing is blocked
  const blockReasons: string[] = [];
  const robotsDirectives = [robotsMetaTag, xRobotsTagHeader]
    .filter(Boolean)
    .join(",")
    .toLowerCase();

  if (robotsDirectives.includes("noindex")) {
    blockReasons.push("noindex directive found");
  }

  if (robotsDirectives.includes("none")) {
    blockReasons.push("'none' directive found (equivalent to noindex, nofollow)");
  }

  const blocked = blockReasons.length > 0;

  return {
    robotsMetaTag,
    xRobotsTagHeader,
    blocked,
    blockReasons,
  };
}

/**
 * Detect crawlability issues.
 */
function detectCrawlabilityIssues(data: {
  canonicalAnalysis: {
    htmlCanonical: string | null;
    httpCanonical: string | null;
    conflicts: CanonicalConflict[];
  };
  redirectAnalysis: {
    redirectChain: RedirectHop[];
    chainLength: number;
    finalUrl: string;
    issues: string[];
  };
  indexability: {
    robotsMetaTag: string | null;
    xRobotsTagHeader: string | null;
    blocked: boolean;
    blockReasons: string[];
  };
  /** `null` when robots.txt could not be read — unknown, not permitted. */
  crawlAllowed: boolean | null;
  originalUrl: string;
  finalUrl: string;
}): CrawlabilityIssue[] {
  const issues: CrawlabilityIssue[] = [];

  // Canonical issues
  for (const conflict of data.canonicalAnalysis.conflicts) {
    // A relative or unparseable canonical is silently discarded by Google, so the
    // page has no canonical at all while appearing to declare one. That is worse
    // than declaring none, and ranks as critical alongside handing the page to
    // another domain.
    const type =
      conflict.type === "cross_domain" ||
      conflict.type === "relative" ||
      conflict.type === "invalid"
        ? "critical"
        : "warning";

    issues.push({
      type,
      category: "canonical",
      message: conflict.message,
    });
  }

  // Google: "none of them are required; your site will likely do just fine
  // without specifying a canonical preference." A page with no duplicates and no
  // canonical is correctly built, so this is a note, not a warning.
  if (
    !data.canonicalAnalysis.htmlCanonical &&
    !data.canonicalAnalysis.httpCanonical
  ) {
    issues.push({
      type: "info",
      category: "canonical",
      message: annotate(
        "No canonical URL specified — Google will choose one; set it explicitly only if this page is reachable at more than one URL",
        GOOGLE_SAYS.canonicalNotRequired
      ),
    });
  }

  // Redirect issues
  for (const issue of data.redirectAnalysis.issues) {
    issues.push({
      type: issue.includes("loop") ? "critical" : "warning",
      category: "redirect",
      message: issue,
    });
  }

  // Indexability issues
  if (data.indexability.blocked) {
    issues.push({
      type: "critical",
      category: "indexability",
      message: `Page blocked from indexing: ${data.indexability.blockReasons.join(", ")}`,
    });
  }

  // The trap: noindex on a page robots.txt forbids Googlebot to fetch. Google
  // never reads the directive, so the page is not deindexed — and because it is
  // never crawled, the usual fix of "wait for a recrawl" never arrives either.
  // Both halves look correct in isolation, which is why this went unreported
  // until the two analyses were put in the same function.
  if (data.indexability.blocked && data.crawlAllowed === false) {
    issues.push({
      type: "critical",
      category: "indexability",
      message: annotate(
        "noindex will never be seen: robots.txt disallows Googlebot from fetching this URL, so Google cannot read the directive and the page can still appear in results from inbound links. Allow crawling of this URL, or remove it another way (password, 404, or the removals tool).",
        GOOGLE_SAYS.directivesNeedCrawlAccess
      ),
    });
  }

  // URL changed after redirects
  if (data.originalUrl !== data.finalUrl) {
    issues.push({
      type: "info",
      category: "redirect",
      message: `URL redirects from ${data.originalUrl} to ${data.finalUrl}`,
    });
  }

  return issues;
}

/**
 * Normalize URL for comparison (remove trailing slash, fragments, etc.).
 */
function normalizeUrl(url: string): string {
  try {
    const parsed = new URL(url);
    // Remove trailing slash, fragment, and normalize to lowercase
    let normalized = parsed.origin + parsed.pathname.replace(/\/$/, "");
    if (parsed.search) {
      normalized += parsed.search;
    }
    return normalized.toLowerCase();
  } catch {
    return url.toLowerCase();
  }
}
