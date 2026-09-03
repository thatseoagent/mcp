/**
 * Hreflang validation analyzer.
 * Validates hreflang tags from HTML, HTTP headers, and optionally sitemaps.
 */

import { load } from "cheerio";
import pLimit from "p-limit";
import { XMLParser } from "fast-xml-parser";
import { type Result, success, failure } from "../type-guards";
import { notScored } from "./scored-checks";
import { fetchAnyStatus, fetchWithTimeout, validateUrl } from "../http-client";
import { PAGE_AUDIT_USER_AGENT } from "../bot-identity";
import {
  validateLanguageCode,
  regionCodeMistakenForLanguage,
} from "../language-validator";

export interface HreflangTag {
  lang: string;
  href: string;
  source: "html" | "http-header" | "sitemap";
}

export interface HreflangIssue {
  type: "critical" | "warning" | "info";
  category: "validation" | "bidirectional" | "accessibility" | "configuration";
  message: string;
  affectedLang?: string;
  affectedUrl?: string;
}

export interface HreflangValidationResult {
  url: string;
  hreflangTags: HreflangTag[];
  validation: {
    selfReferencingPresent: boolean;
    languageCodesValid: boolean;
    /**
     * Every alternate URL we reached answered.
     *
     * Read this only when `urlsAccessibleStatus` is absent. It used to lie in
     * both directions: a timeout of ours flipped it to `false` and was filed as
     * a `critical` finding about the customer, while `checkAccessibility: false`
     * — which is what every site refresh passes — left it at its initial `true`,
     * so a stored section claimed success having verified nothing (#345).
     */
    urlsAccessible: boolean;
    /** Set when no URL was checked at all, either by request or because none answered. */
    urlsAccessibleStatus?: "not-evaluated";
    /** URLs that did not answer: a timeout, a 403, a 429, a 5xx, a 999. */
    urlsUnchecked?: number;
    hasXDefault: boolean;
  };
  issues: HreflangIssue[];
  recommendations: string[];
}

/**
 * What an accessibility sweep found, kept apart from what it could not find out.
 *
 * `accessible` is a statement about `answered` URLs only. A run where nothing
 * answered says `accessible: false, answered: 0`, and the caller turns that into
 * a status rather than a verdict — the same shape `WellKnownRead` and
 * `TrustPageFinding` take, for the same reason.
 */
interface AccessibilitySweep {
  accessible: boolean;
  answered: number;
  unchecked: number;
}

/**
 * Validate hreflang tags for a URL.
 * Returns Result type for explicit error handling.
 */
export async function validateHreflang(
  url: string,
  options?: {
    checkBidirectional?: boolean;
    checkAccessibility?: boolean;
    sitemapUrl?: string;
  }
): Promise<Result<HreflangValidationResult>> {
  try {
    validateUrl(url);

  const checkBidirectional = options?.checkBidirectional ?? true;
  const checkAccessibility = options?.checkAccessibility ?? true;
  const sitemapUrl = options?.sitemapUrl;

  // Fetch and parse HTML
  const response = await fetchWithTimeout(url);
  // Use the final URL after redirects for all comparisons — avoids false
  // "self-reference missing" failures when the input URL redirects (e.g.
  // root → /en, or http → https, or trailing-slash normalizations).
  const effectiveUrl = response.url || url;
  const html = await response.text();
  const $ = load(html);

  // Extract hreflang tags from different sources
  const htmlTags = extractHreflangFromHtml($, effectiveUrl);
  const httpHeaderTags = extractHreflangFromHeaders(response.headers, effectiveUrl);
  const sitemapTags = sitemapUrl
    ? await extractHreflangFromSitemap(sitemapUrl, effectiveUrl)
    : [];

  const allTags = [...htmlTags, ...httpHeaderTags, ...sitemapTags];

  // Perform validations
  const issues: HreflangIssue[] = [];

  // 1. Validate language codes
  validateLanguageCodes(allTags, issues);

  // 2. Check self-reference
  const selfReferencingPresent = checkSelfReference(allTags, effectiveUrl, issues);

  // 3. Check for x-default
  const hasXDefault = allTags.some((tag) => tag.lang === "x-default");
  if (!hasXDefault && allTags.length > 1) {
    issues.push({
      type: "warning",
      category: "configuration",
      message: "Missing x-default hreflang tag (recommended for international sites)",
    });
  }

  // 4. Check accessibility
  //
  // The initial value used to be `true`, and `site-refresh-runner` passes
  // `checkAccessibility: false` — so every
  // `HreflangSection` a refresh ever stored claimed the URLs were accessible
  // without a single request having been made, and that is the copy that reaches
  // `context_json` and the frozen `shared_reports.snapshot_json` (#345).
  //
  // One read per distinct URL now serves both checks. Two serial loops used to
  // fetch every tag — including the HTML and `Link`-header duplicates of the same
  // URL — once each, so a 30-locale site made 120 requests at 10s apiece (#349).
  let sweep: AccessibilitySweep = { accessible: false, answered: 0, unchecked: allTags.length };
  let reads = new Map<string, AlternateRead>();
  if (checkAccessibility || checkBidirectional) {
    const read = await readAlternates(allTags, checkBidirectional);
    reads = read.reads;
    if (checkAccessibility) sweep = reportAccessibility(allTags, reads, read.skipped, issues);
  }
  // A verdict needs at least one URL to have answered. Nothing answered, or we
  // never asked, and the field is not a verdict — it is an open question, and
  // `false` here is only because the field predates the status and cannot be
  // absent. See the type.
  const urlsAccessibleStatus =
    allTags.length > 0 && sweep.answered === 0 ? ("not-evaluated" as const) : undefined;

  // 5. Bidirectional validation, from the bodies already read above.
  if (checkBidirectional) {
    validateBidirectional(effectiveUrl, allTags, reads, issues);
  }

  // 6. Check for conflicts between sources
  checkSourceConflicts(htmlTags, httpHeaderTags, sitemapTags, issues);

  // 7. Check for duplicates
  checkDuplicates(allTags, issues);

  // Generate validation summary
  const languageCodesValid = !issues.some(
    (i) => i.category === "validation" && i.type === "critical"
  );

  // Generate recommendations
  const recommendations = generateRecommendations({
    issues,
    allTags,
    selfReferencingPresent,
    hasXDefault,
  });

  return success({
    url: effectiveUrl,
    hreflangTags: allTags,
    validation: {
      selfReferencingPresent,
      languageCodesValid,
      urlsAccessible: sweep.accessible,
      urlsAccessibleStatus,
      urlsUnchecked: sweep.unchecked || undefined,
      hasXDefault,
    },
    issues,
    recommendations,
  });
  } catch (error) {
    const err = error instanceof Error ? error : new Error(String(error));
    return failure(err);
  }
}

/**
 * Extract hreflang tags from HTML.
 */
function extractHreflangFromHtml(
  $: ReturnType<typeof load>,
  baseUrl: string
): HreflangTag[] {
  const tags: HreflangTag[] = [];

  $('link[rel="alternate"][hreflang]').each((_, el) => {
    const lang = $(el).attr("hreflang");
    const href = $(el).attr("href");

    if (lang && href) {
      // Resolve relative URLs
      const absoluteHref = new URL(href, baseUrl).href;
      tags.push({ lang, href: absoluteHref, source: "html" });
    }
  });

  return tags;
}

/**
 * Extract hreflang tags from HTTP Link header.
 */
function extractHreflangFromHeaders(
  headers: Headers,
  baseUrl: string
): HreflangTag[] {
  const tags: HreflangTag[] = [];
  const linkHeader = headers.get("link");

  if (!linkHeader) return tags;

  // Parse Link header (can contain multiple links separated by commas)
  const linkRegex = /<([^>]+)>;\s*rel="alternate";\s*hreflang="([^"]+)"/g;
  let match;

  while ((match = linkRegex.exec(linkHeader)) !== null) {
    const href = match[1];
    const lang = match[2];

    // Resolve relative URLs
    const absoluteHref = new URL(href, baseUrl).href;
    tags.push({ lang, href: absoluteHref, source: "http-header" });
  }

  return tags;
}

/**
 * Extract hreflang tags from sitemap.
 */
async function extractHreflangFromSitemap(
  sitemapUrl: string,
  targetUrl: string
): Promise<HreflangTag[]> {
  const tags: HreflangTag[] = [];

  try {
    const response = await fetchWithTimeout(sitemapUrl);
    const xml = await response.text();

    // Parse sitemap XML
    const parser = new XMLParser({
      ignoreAttributes: false,
      attributeNamePrefix: "@_",
    });

    const parsed = parser.parse(xml);

    // Navigate to urlset
    if (!parsed.urlset || !parsed.urlset.url) {
      return tags;
    }

    // Get URLs array
    const urls = Array.isArray(parsed.urlset.url)
      ? parsed.urlset.url
      : [parsed.urlset.url];

    // Find target URL entry
    for (const urlEntry of urls) {
      if (urlEntry.loc === targetUrl) {
        // Check for xhtml:link elements (hreflang annotations in sitemaps)
        const links = urlEntry["xhtml:link"];
        if (!links) continue;

        const linksArray = Array.isArray(links) ? links : [links];

        for (const link of linksArray) {
          const hreflang = link["@_hreflang"];
          const href = link["@_href"];

          if (hreflang && href) {
            tags.push({
              lang: hreflang,
              href,
              source: "sitemap",
            });
          }
        }
        break;
      }
    }
  } catch {
    // Sitemap parsing failed - not critical, just skip
  }

  return tags;
}

/**
 * Validate language codes.
 */
function validateLanguageCodes(
  tags: HreflangTag[],
  issues: HreflangIssue[]
): void {
  for (const tag of tags) {
    if (!validateLanguageCode(tag.lang)) {
      issues.push({
        type: "critical",
        category: "validation",
        message: `Invalid hreflang value: ${tag.lang}. Google accepts an ISO 639-1 language, optionally with an ISO 15924 script and an ISO 3166-1 Alpha 2 region — "en", "en-GB", "zh-Hant", "zh-Hant-TW".`,
        affectedLang: tag.lang,
        affectedUrl: tag.href,
      });
      continue;
    }

    // Valid, but probably not what the author meant. Google names writing a
    // country where a language belongs as a common mistake, and the cases that
    // survive validation are the ones that need saying out loud: `uk` is
    // Ukrainian, so a UK site using it is correctly annotated for the wrong
    // audience and nothing will ever flag it.
    const confusion = regionCodeMistakenForLanguage(tag.lang);
    if (confusion) {
      issues.push({
        type: "warning",
        category: "validation",
        message: `hreflang="${tag.lang}" means ${confusion}.`,
        affectedLang: tag.lang,
        affectedUrl: tag.href,
      });
    }
  }
}

/**
 * Check for self-referencing hreflang tag.
 */
function checkSelfReference(
  tags: HreflangTag[],
  currentUrl: string,
  issues: HreflangIssue[]
): boolean {
  const normalizedCurrent = normalizeUrl(currentUrl);
  const selfReferencing = tags.some(
    (tag) => normalizeUrl(tag.href) === normalizedCurrent
  );

  if (!selfReferencing && tags.length > 0) {
    issues.push({
      type: "critical",
      category: "configuration",
      message: "Missing self-referencing hreflang tag (page must reference itself)",
    });
  }

  return selfReferencing;
}

/**
 * How many distinct alternate URLs one run will read.
 *
 * A real site can legitimately have thirty locales, so this is not tight — but
 * it is a cap, and #346 is the standing lesson that a silent one reads as "we
 * looked at everything". When it bites, the output says so.
 */
const MAX_ALTERNATES_CHECKED = 25;

/** How many of them are read at once. Bounded to stay polite to one origin. */
const ALTERNATE_CONCURRENCY = 6;

/**
 * What one read of one alternate URL told us.
 *
 * `body` is present only when someone asked for it — bidirectional validation
 * needs the markup, accessibility does not, and fetching a whole page to learn
 * that it answers is the difference between a HEAD and a GET on every locale.
 */
interface AlternateRead {
  outcome: "present" | "absent" | "unanswered";
  body?: { html: string; headers: Headers };
}

/**
 * Read every distinct alternate URL once, in parallel, up to the cap.
 *
 * ── Why one function for two checks ──
 *
 * There were two serial loops over the same list. `allTags` is HTML tags plus
 * `Link`-header tags plus sitemap tags, and the first two normally carry the
 * same set — `checkSourceConflicts` warns only when they *differ* — so a
 * 30-locale site presented 60 tags for 30 URLs, and each loop fetched all 60.
 * With both options on that is 120 requests, serial, at 10s apiece: a worst case
 * of twenty minutes for one tool call, aimed at one customer's origin (#349).
 *
 * Deduplicated on the normalized href, bounded, and one read serves both checks.
 */
async function readAlternates(
  tags: HreflangTag[],
  wantBody: boolean,
): Promise<{ reads: Map<string, AlternateRead>; skipped: number }> {
  const byUrl = new Map<string, string>();
  for (const tag of tags) {
    const key = normalizeUrl(tag.href);
    if (!byUrl.has(key)) byUrl.set(key, tag.href);
  }

  const all = [...byUrl.entries()];
  const chosen = all.slice(0, MAX_ALTERNATES_CHECKED);
  const limit = pLimit(ALTERNATE_CONCURRENCY);

  const reads = new Map<string, AlternateRead>();
  await Promise.all(
    chosen.map(([key, href]) =>
      limit(async () => {
        reads.set(key, await readAlternate(href, wantBody));
      }),
    ),
  );

  return { reads, skipped: all.length - chosen.length };
}

/**
 * One alternate URL.
 *
 * `fetchAnyStatus` rather than `fetchWithTimeout`, because that one throws on
 * every non-2xx, and here the status IS the finding. The original note said
 * `PageFetchError` "does not carry the status" and so this had to assemble the
 * fetch by hand; the error carries `status` as a field now, and the fetcher hands
 * back the response, so neither the regex nor the assembly is needed.
 */
async function readAlternate(href: string, wantBody: boolean): Promise<AlternateRead> {
  const method = wantBody ? "GET" : "HEAD";
  try {
    const { response } = await fetchAnyStatus(href, { method, timeout: 10_000 });
    // Split the way `classifyRobotsStatus` splits it: 404 and 410 are the file
    // not being there, which for an hreflang target IS the finding. Everything
    // else — a WAF's 403, a 429, a 5xx, a 999, a timeout — is a conversation we
    // did not have.
    const outcome =
      response.status === 404 || response.status === 410 ? "absent" as const
        : response.status >= 200 && response.status < 400 ? "present" as const
          : "unanswered" as const;

    if (outcome !== "present" || !wantBody) return { outcome };
    return { outcome, body: { html: await response.text(), headers: response.headers } };
  } catch {
    // The error message is deliberately not carried out of here. It used to be
    // interpolated straight into customer-facing output, so a reader was shown
    // the text of our own AbortError as a fact about their site.
    return { outcome: "unanswered" };
  }
}

/**
 * Turn the reads into accessibility findings, one per distinct URL.
 *
 * Per URL and not per tag: a 404 declared under three language codes is one
 * broken target, and reporting it three times inflates the critical count the
 * tool prints and the recommendation it derives from it.
 */
function reportAccessibility(
  tags: HreflangTag[],
  reads: Map<string, AlternateRead>,
  skipped: number,
  issues: HreflangIssue[],
): AccessibilitySweep {
  let accessible = true;
  let answered = 0;
  let unchecked = skipped;
  const seen = new Set<string>();

  for (const tag of tags) {
    const key = normalizeUrl(tag.href);
    if (seen.has(key)) continue;
    seen.add(key);

    // Absence from the map means the cap cut it, never that it failed: every
    // chosen URL gets an entry, failures included. Counting those here as well
    // as in `skipped` double-counted them, and would have filed a "did not
    // answer our check" against a URL we never asked.
    const read = reads.get(key);
    if (!read) continue;

    if (read.outcome === "unanswered") {
      unchecked++;
      issues.push({
        // `info`, not `critical`. A URL that did not answer us is not a broken
        // hreflang, and filing it as one inflates the critical count.
        type: "info",
        category: "accessibility",
        message: notScored("this URL did not answer our check", "it may well be reachable, we could not confirm it"),
        affectedLang: tag.lang,
        affectedUrl: tag.href,
      });
      continue;
    }

    answered++;
    if (read.outcome === "absent") {
      issues.push({
        type: "critical",
        category: "accessibility",
        message: "URL not accessible (HTTP 404 or 410)",
        affectedLang: tag.lang,
        affectedUrl: tag.href,
      });
      accessible = false;
    }
  }

  if (skipped > 0) {
    // Never a silent cap. A truncation nobody is told about reads as coverage.
    issues.push({
      type: "info",
      category: "accessibility",
      message: `Only the first ${MAX_ALTERNATES_CHECKED} alternate URLs were checked; ${skipped} more were not`,
    });
  }

  return { accessible, answered, unchecked };
}

/**
 * Validate bidirectional links: page A links to B, so B must link back to A.
 *
 * Reads nothing itself — it is handed the bodies `readAlternates` already
 * fetched, which is what stops this being a second round trip per locale.
 */
function validateBidirectional(
  currentUrl: string,
  tags: HreflangTag[],
  reads: Map<string, AlternateRead>,
  issues: HreflangIssue[],
): void {
  const normalizedCurrent = normalizeUrl(currentUrl);
  const seen = new Set<string>();

  for (const tag of tags) {
    const key = normalizeUrl(tag.href);
    if (key === normalizedCurrent || tag.lang === "x-default" || seen.has(key)) continue;
    seen.add(key);

    const read = reads.get(key);
    if (!read?.body) {
      // Was an empty `catch` with the comment "Already reported in accessibility
      // check" — true only when `checkAccessibility` also ran, and the two are
      // independent options. With bidirectional on and accessibility off, a URL
      // that never answered produced no output at all (#349).
      issues.push({
        type: "info",
        category: "bidirectional",
        message: notScored(
          "this URL could not be read, so whether it links back was not established",
        ),
        affectedLang: tag.lang,
        affectedUrl: tag.href,
      });
      continue;
    }

    const $ = load(read.body.html);
    const referenced = [
      ...extractHreflangFromHtml($, tag.href),
      ...extractHreflangFromHeaders(read.body.headers, tag.href),
    ];

    if (!referenced.some((refTag) => normalizeUrl(refTag.href) === normalizedCurrent)) {
      issues.push({
        type: "warning",
        category: "bidirectional",
        message: `Bidirectional validation failed: ${tag.href} (${tag.lang}) does not link back to ${currentUrl}`,
        affectedLang: tag.lang,
        affectedUrl: tag.href,
      });
    }
  }
}

/**
 * Check for conflicts between HTML, HTTP headers, and sitemap.
 */
function checkSourceConflicts(
  htmlTags: HreflangTag[],
  httpHeaderTags: HreflangTag[],
  sitemapTags: HreflangTag[],
  issues: HreflangIssue[]
): void {
  if (htmlTags.length > 0 && httpHeaderTags.length > 0) {
    // Check if HTML and HTTP header tags match
    const htmlSet = new Set(htmlTags.map((t) => `${t.lang}:${t.href}`));
    const httpSet = new Set(httpHeaderTags.map((t) => `${t.lang}:${t.href}`));

    if (htmlSet.size !== httpSet.size || ![...htmlSet].every((x) => httpSet.has(x))) {
      issues.push({
        type: "warning",
        category: "configuration",
        message: "HTML and HTTP header hreflang tags differ (they should match)",
      });
    }
  }

  if (sitemapTags.length > 0 && htmlTags.length > 0) {
    const htmlSet = new Set(htmlTags.map((t) => `${t.lang}:${t.href}`));
    const sitemapSet = new Set(sitemapTags.map((t) => `${t.lang}:${t.href}`));

    if (htmlSet.size !== sitemapSet.size || ![...htmlSet].every((x) => sitemapSet.has(x))) {
      issues.push({
        type: "info",
        category: "configuration",
        message: "HTML and sitemap hreflang tags differ",
      });
    }
  }
}

/**
 * Check for duplicate hreflang tags (same language, different URLs).
 */
function checkDuplicates(tags: HreflangTag[], issues: HreflangIssue[]): void {
  const langMap = new Map<string, Set<string>>();

  for (const tag of tags) {
    if (!langMap.has(tag.lang)) {
      langMap.set(tag.lang, new Set());
    }
    langMap.get(tag.lang)!.add(tag.href);
  }

  for (const [lang, urls] of langMap) {
    if (urls.size > 1) {
      issues.push({
        type: "critical",
        category: "validation",
        message: `Duplicate hreflang for ${lang}: ${Array.from(urls).join(", ")}`,
        affectedLang: lang,
      });
    }
  }
}

/**
 * Normalize URL for comparison.
 */
function normalizeUrl(url: string): string {
  try {
    const parsed = new URL(url);
    // Strip trailing slash from path (except root "/") for consistent comparison
    const pathname =
      parsed.pathname.length > 1
        ? parsed.pathname.replace(/\/+$/, "")
        : parsed.pathname;
    return `${parsed.origin}${pathname}${parsed.search}`.toLowerCase();
  } catch {
    return url.toLowerCase().replace(/\/+$/, "");
  }
}

/**
 * Generate recommendations.
 */
function generateRecommendations(data: {
  issues: HreflangIssue[];
  allTags: HreflangTag[];
  selfReferencingPresent: boolean;
  hasXDefault: boolean;
}): string[] {
  const recommendations: string[] = [];

  const criticalCount = data.issues.filter((i) => i.type === "critical").length;
  const warningCount = data.issues.filter((i) => i.type === "warning").length;

  if (criticalCount === 0 && warningCount === 0) {
    recommendations.push("✓ Hreflang implementation is correct.");
    return recommendations;
  }

  if (!data.selfReferencingPresent) {
    recommendations.push("- Add self-referencing hreflang tag (page must reference itself)");
  }

  if (!data.hasXDefault && data.allTags.length > 1) {
    recommendations.push("- Add x-default hreflang tag for fallback language");
  }

  const validationIssues = data.issues.filter(
    (i) => i.category === "validation"
  );
  if (validationIssues.length > 0) {
    recommendations.push("- Fix invalid language codes (use ISO 639-1 format)");
  }

  const bidirectionalIssues = data.issues.filter(
    (i) => i.category === "bidirectional"
  );
  if (bidirectionalIssues.length > 0) {
    recommendations.push("- Fix bidirectional links (referenced pages must link back)");
  }

  // `critical` only. The category now also carries the `info` rows for URLs that
  // did not answer us, and "Fix broken URLs" is not something a customer can act
  // on when the URL may be perfectly fine and it was our request that failed.
  const brokenUrls = data.issues.filter(
    (i) => i.category === "accessibility" && i.type === "critical"
  );
  if (brokenUrls.length > 0) {
    recommendations.push("- Fix broken URLs (all hreflang URLs must be accessible)");
  }

  return recommendations;
}

