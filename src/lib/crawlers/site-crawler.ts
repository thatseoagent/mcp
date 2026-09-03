/**
 * BFS site crawler — a single pass that collects everything the cross-page
 * checks need: base checks (title, meta, canonical, noindex, H1, redirects, HTTP
 * status), broken internal links, deep pages, and the shortest pages.
 *
 * Uses fetch + cheerio. Respects robots.txt through the shared Robots Ruleset,
 * which picks the most specific group for our own crawler rather than the
 * wildcard one — a site may address ThatSEOAgentBot by name. A disallowed URL is
 * skipped rather than reported: the crawl was told not to look there, which is
 * not the same as the page being broken.
 *
 * Concurrency is three fetches in flight; the spacing between them belongs to
 * `crawl-pacing` now rather than to a `setTimeout` here, so every Tool in this
 * server presses a third-party origin at the same rate instead of only this one.
 */

import { load } from "cheerio";
import { TITLE_LIKELY_TRUNCATED } from "../analyzers/seo-rules";
import { safeFetch } from "../ssrf-guard";
import { CRAWLER_USER_AGENT } from "../bot-identity";
import { visibleTexts } from "../visible-text";
import { paceRequestTo } from "../crawl-pacing";
import { isAllowedByRobots } from "../robots-gate";

// ── Types ──────────────────────────────────────────────────────────────────

export type IssueSeverity = "critical" | "warning";

export type PageIssue = {
  type: string;
  severity: IssueSeverity;
  message: string;
};

export type PageResult = {
  url: string;
  finalUrl: string;
  depth: number;
  statusCode: number;
  redirectHops: number;
  title: string | null;
  metaDescription: string | null;
  canonical: string | null;
  isNoindex: boolean;
  h1: string[];
  wordCount: number;
  internalLinks: string[];
  issues: PageIssue[];
};

export type CrawlReport = {
  domain: string;
  startUrl: string;
  pagesCrawled: number;
  pagesLimit: number;
  truncated: boolean;
  crawledAt: string;
  /**
   * URLs the site told us not to fetch, which the crawl reached and skipped.
   *
   * Reported rather than silently dropped. A disallowed URL still spends one of
   * the pages the caller budgeted for — it was queued, de-duplicated and counted
   * before the ruleset was consulted — so a crawl of a site with a `Disallow`
   * comes back shorter than it was asked for, and without this number there is
   * nothing in the report to explain why.
   */
  skippedByRobots: number;
  /** title → [urls], for duplicate detection. */
  titlesMap: Record<string, string[]>;
  /** description → [urls]. */
  descriptionsMap: Record<string, string[]>;
  brokenLinks: Array<{ url: string; statusCode: number; foundOn: string[] }>;
  deepPages: Array<{ url: string; depth: number; severity: IssueSeverity }>;
  /**
   * The shortest indexable pages, for a human to look over.
   *
   * Named for what it measures. It used to be `thinPages` with a severity, which
   * borrowed the name of a Google spam policy about pages that add no value and
   * applied it to a word count — so a 90-word contact page came back "critical".
   * Word count is not a verdict; whether these pages earn their place is a
   * judgement only their author can make.
   */
  shortPages: Array<{ url: string; wordCount: number }>;
  pages: PageResult[];
};

// ── URL normalisation ──────────────────────────────────────────────────────

function normalise(href: string, base: string): string | null {
  try {
    const url = new URL(href, base);
    // Drop fragments; query strings are kept (they can be canonically relevant).
    url.hash = "";
    return url.href;
  } catch {
    return null;
  }
}

function isInternal(href: string, origin: string): boolean {
  try {
    return new URL(href).origin === origin;
  } catch {
    return false;
  }
}

function extractWords(html: string): number {
  // Remove scripts, styles, then strip tags.
  const cleaned = html
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&[a-z]+;/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!cleaned) return 0;
  return cleaned.split(/\s+/).length;
}

/** A page we could not read at all, recorded rather than dropped. */
function unreadable(
  url: string,
  depth: number,
  statusCode: number,
  redirectHops: number,
  issue: PageIssue,
): PageResult {
  return {
    url,
    finalUrl: url,
    depth,
    statusCode,
    redirectHops,
    title: null,
    metaDescription: null,
    canonical: null,
    isNoindex: false,
    h1: [],
    wordCount: 0,
    internalLinks: [],
    issues: [issue],
  };
}

// ── Page fetcher ───────────────────────────────────────────────────────────

async function fetchPage(url: string, depth: number, origin: string): Promise<PageResult | null> {
  let finalUrl = url;
  let statusCode = 0;
  let redirectHops = 0;
  let html = "";

  try {
    await paceRequestTo(url);

    const {
      response: res,
      finalUrl: resolvedUrl,
      redirectCount,
    } = await safeFetch(url, {
      signal: AbortSignal.timeout(12_000),
      headers: {
        Accept: "text/html,application/xhtml+xml",
        "User-Agent": CRAWLER_USER_AGENT,
      },
    });

    statusCode = res.status;
    finalUrl = resolvedUrl ?? url;
    redirectHops = redirectCount;

    if (!res.ok) {
      return {
        ...unreadable(url, depth, statusCode, redirectHops, {
          type: statusCode >= 500 ? "server_error" : "broken_link",
          severity: "critical",
          message: `HTTP ${statusCode}`,
        }),
        finalUrl,
      };
    }

    const contentType = res.headers.get("content-type") ?? "";
    if (!contentType.includes("text/html")) return null;

    html = await res.text();
  } catch (error) {
    return unreadable(url, depth, 0, redirectHops, {
      type: "fetch_error",
      severity: "critical",
      message: error instanceof Error ? error.message : String(error),
    });
  }

  const $ = load(html);

  const title = $("title").first().text().trim() || null;
  const metaDescription = $('meta[name="description"]').attr("content")?.trim() || null;
  const canonical = $('link[rel="canonical"]').attr("href")?.trim() || null;
  const robotsMeta = $('meta[name="robots"]').attr("content")?.toLowerCase() ?? "";
  const isNoindex = robotsMeta.includes("noindex");
  const h1 = visibleTexts($, "h1");
  const wordCount = extractWords(html);

  const internalLinks: string[] = [];
  $("a[href]").each((_, el) => {
    const href = $(el).attr("href");
    if (!href) return;
    // Skip mailto, tel, js, anchors.
    if (/^(mailto:|tel:|javascript:|#)/i.test(href)) return;
    const abs = normalise(href, finalUrl);
    if (abs && isInternal(abs, origin)) {
      internalLinks.push(abs);
    }
  });

  const issues: PageIssue[] = [];

  // The per-page checks below carry the same rules as the single-page analyzers,
  // and for a while they carried the same invented ones too: this file kept a
  // 30–60 character title window, `multiple_h1` as a plain warning and a redirect
  // warning from the second hop, after all three had been corrected next door.
  // Two copies of a rule is two places for it to be wrong.
  if (!title) issues.push({ type: "missing_title", severity: "critical", message: "Missing <title>" });
  else if (title.length > TITLE_LIKELY_TRUNCATED) {
    issues.push({
      type: "long_title",
      severity: "warning",
      message: `Title is ${title.length} characters and may be truncated in results — Google truncates to fit the device width, not to a character count`,
    });
  }

  if (!metaDescription) {
    issues.push({ type: "missing_description", severity: "warning", message: "Missing meta description" });
  }

  // Google states heading count and order do not affect ranking, so only the
  // absence of an H1 is an SEO finding here. A second H1 is an accessibility
  // matter, reported by the page analyzers with that label attached.
  if (h1.length === 0) issues.push({ type: "missing_h1", severity: "warning", message: "Missing H1" });

  // Google publishes no hop limit. Three is ours, and matches the page analyzer.
  if (redirectHops > 3) {
    issues.push({
      type: "redirect_chain",
      severity: "warning",
      message: `Redirect chain of ${redirectHops} hops — Google follows these, but each hop costs the user time`,
    });
  }
  if (isNoindex) issues.push({ type: "noindex", severity: "warning", message: "Page has noindex directive" });

  // No page-level finding for length. "Thin content" is a Google spam policy
  // about pages with no added value — copied merchant descriptions, scaled
  // low-value output — and Google states plainly that "the length of the content
  // alone doesn't matter for ranking purposes". Borrowing the policy's name for
  // a word count told owners their contact page was a spam risk.
  //
  // Short pages are still listed in the report, as a list to look through rather
  // than a defect to fix. See `shortPages` below.

  if (depth >= 6) {
    issues.push({ type: "very_deep_page", severity: "critical", message: `Very deep page (${depth} clicks from home)` });
  } else if (depth >= 4) {
    issues.push({ type: "deep_page", severity: "warning", message: `Deep page (${depth} clicks from home)` });
  }

  return {
    url,
    finalUrl,
    depth,
    statusCode,
    redirectHops,
    title,
    metaDescription,
    canonical,
    isNoindex,
    h1,
    wordCount,
    internalLinks,
    issues,
  };
}

// ── BFS crawler ────────────────────────────────────────────────────────────

/**
 * The key two URLs share when they are the same page.
 *
 * `https://example.com` and `https://example.com/` are one page, and the crawler
 * did not know it: dedup stripped the query but not the trailing slash, so a
 * seed written without one and a nav linking to `/` were fetched twice and then
 * compared against each other. On a real crawl that invented a duplicate title
 * *and* a duplicate meta description on the home page — and a duplicate title is
 * what a competitor ships as an error, so the cost of this is a false finding
 * rather than a missing one.
 *
 * The fragment goes too: it never reaches the server. The query goes because
 * that is what the previous inline dedup already assumed, kept rather than
 * revisited here.
 *
 * Used only as a set key. `PageResult.url` stays the URL we actually fetched, so
 * the report never shows a reader a URL they did not give us.
 */
function visitKey(url: string): string {
  try {
    const u = new URL(url);
    u.hash = "";
    u.search = "";
    u.pathname = u.pathname.replace(/\/+$/, "") || "/";
    return u.toString();
  } catch {
    return url;
  }
}

export async function crawlSite(startUrl: string, maxPages: number): Promise<CrawlReport> {
  const origin = new URL(startUrl).origin;
  const domain = new URL(startUrl).hostname;

  const visited = new Set<string>();
  const queue: Array<{ url: string; depth: number; foundOn: string }> = [
    { url: startUrl, depth: 0, foundOn: "" },
  ];

  // Where each URL was found, for the broken-links report.
  const foundOnMap = new Map<string, Set<string>>();
  const pages: PageResult[] = [];
  let skippedByRobots = 0;

  while (queue.length > 0 && visited.size < maxPages) {
    // Drain up to 3 concurrently, but never more than the budget has left.
    // This used to splice a flat 3 whenever `visited.size < maxPages`, so a
    // budget of 25 fetched 26 pages against a real site and said so in its own
    // header: `Crawled: 26 pages (limit: 25)`. It only shows when the queue
    // holds repeats — a duplicate is dropped by the filter below, so
    // `visited.size` grows by 1 or 2 and stops landing exactly on the limit.
    // Invisible at one page, and not harmless at the ceiling: 50 is a duration
    // budget, and quietly fetching 52 spends time the arithmetic behind it did
    // not allow for.
    const batch = queue.splice(0, Math.min(3, maxPages - visited.size)).filter((item) => {
      const key = visitKey(item.url);
      if (visited.has(key)) return false;
      visited.add(key);
      return true;
    });

    if (batch.length === 0) continue;

    const results = await Promise.all(
      batch.map(async (item) => {
        // Path plus query: robots.txt patterns are written against both, and
        // dropping the query made `Disallow: /search?q=` unmatchable. The gate
        // reads the ruleset, so the check and every other Tool's check are the
        // same one rather than two that can drift.
        if (!(await isAllowedByRobots(item.url, CRAWLER_USER_AGENT))) {
          skippedByRobots++;
          return null;
        }

        if (item.foundOn) {
          if (!foundOnMap.has(item.url)) foundOnMap.set(item.url, new Set());
          foundOnMap.get(item.url)!.add(item.foundOn);
        }

        const result = await fetchPage(item.url, item.depth, origin);

        if (result && result.statusCode >= 200 && result.statusCode < 400) {
          for (const link of result.internalLinks) {
            // One key, asked once. This was two `visited.has` calls against two
            // different spellings of the same idea, and neither of them knew a
            // trailing slash was not a different page.
            if (!visited.has(visitKey(link))) {
              queue.push({ url: link, depth: item.depth + 1, foundOn: item.url });
            }
          }
        }

        return result;
      }),
    );

    for (const r of results) {
      if (r) pages.push(r);
    }
  }

  const truncated = queue.length > 0 || visited.size >= maxPages;

  // ── Broken links ───────────────────────────────────────────────────────
  const brokenLinksMap = new Map<string, { statusCode: number; foundOn: Set<string> }>();
  for (const page of pages) {
    if (page.statusCode >= 400 || page.statusCode === 0) {
      if (!brokenLinksMap.has(page.url)) {
        brokenLinksMap.set(page.url, { statusCode: page.statusCode, foundOn: new Set() });
      }
      const entry = brokenLinksMap.get(page.url)!;
      const sources = foundOnMap.get(page.url);
      if (sources) {
        for (const s of sources) entry.foundOn.add(s);
      }
    }
  }
  const brokenLinks = [...brokenLinksMap.entries()].map(([url, data]) => ({
    url,
    statusCode: data.statusCode,
    foundOn: [...data.foundOn],
  }));

  // ── Deep pages ─────────────────────────────────────────────────────────
  const deepPages = pages
    .filter((p) => p.depth >= 4 && p.statusCode < 400)
    .map((p) => ({
      url: p.url,
      depth: p.depth,
      severity: (p.depth >= 6 ? "critical" : "warning") as IssueSeverity,
    }))
    .sort((a, b) => b.depth - a.depth);

  // ── Shortest pages ─────────────────────────────────────────────────────
  // Listed without a verdict. No severity: there is no length at which Google
  // considers a page deficient, so assigning one was inventing a fact.
  const shortPages = pages
    .filter((p) => p.wordCount < 300 && p.wordCount > 0 && p.statusCode < 400 && !p.isNoindex)
    .map((p) => ({ url: p.url, wordCount: p.wordCount }))
    .sort((a, b) => a.wordCount - b.wordCount);

  // ── Duplicate titles / descriptions ────────────────────────────────────
  const titlesMap: Record<string, string[]> = {};
  const descriptionsMap: Record<string, string[]> = {};
  for (const page of pages) {
    if (page.title) {
      titlesMap[page.title] = titlesMap[page.title] ?? [];
      titlesMap[page.title].push(page.url);
    }
    if (page.metaDescription) {
      descriptionsMap[page.metaDescription] = descriptionsMap[page.metaDescription] ?? [];
      descriptionsMap[page.metaDescription].push(page.url);
    }
  }

  return {
    domain,
    startUrl,
    pagesCrawled: pages.length,
    pagesLimit: maxPages,
    truncated,
    crawledAt: new Date().toISOString(),
    skippedByRobots,
    titlesMap,
    descriptionsMap,
    brokenLinks,
    deepPages,
    shortPages,
    pages,
  };
}
