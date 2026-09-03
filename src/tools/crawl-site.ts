import { z } from "zod";
import { type ToolMetadata, type InferSchema } from "xmcp";
import { crawlSite, type PageResult } from "../lib/crawlers/site-crawler";
import { defineCachedTool } from "../lib/define-tool";
import { domainFromUrl, refreshable } from "../lib/with-cache";
import { toolText } from "../lib/tool-result";

/**
 * How many pages a crawl walks when the caller does not say.
 *
 * The cap used to be one page, and that was right on the evidence it had: the
 * constant had arrived by accident in a login-redesign commit and nothing
 * justified any particular higher number. What changed it was noticing that a
 * free competitor ships `duplicate-title`, `duplicate-description` and
 * `broken-internal-link` as **errors**, while our cap made all three unable to
 * fire — so we were reporting as "not evaluated" what someone else reports as
 * broken.
 *
 * 25, not 50, because this is a default rather than a ceiling, and the cost of
 * the default is somebody else's bandwidth as much as the caller's time.
 */
export const DEFAULT_PAGES = 25;

/**
 * The hard ceiling.
 *
 * The retired version set this against a serverless route's 300-second limit,
 * which no longer applies: this server runs on the Operator's own machine and
 * nothing cuts a long crawl off. What survives is the reason underneath — a
 * crawl is requests to a third party's server, and `crawl-pacing` deliberately
 * makes a big one slow. 50 pages is roughly a minute of an agent turn waiting,
 * which is about as long as a tool call can be useful.
 *
 * A larger request is clamped rather than refused: a smaller crawl is an answer,
 * an error is not.
 */
export const PAGE_CEILING = 50;

/**
 * The page budget a request actually gets.
 *
 * Clamped, not rejected. A caller asking for 500 pages wants a site-wide view,
 * and refusing gives them nothing. The floor is 1 for the same reason in the
 * other direction: `maxPages: 0` would crawl nothing and report it as a finished
 * audit.
 *
 * Stated once and called twice, on purpose. The schema applies it so a caller
 * reading the surface sees the effective budget, and the handler applies it so a
 * direct caller — one that never went through the MCP schema — cannot hand the
 * engine an unbounded number. It is idempotent, so the second application is
 * free.
 */
export function clampPages(requested: number): number {
  return Math.min(PAGE_CEILING, Math.max(1, requested));
}

export const schema = {
  ...refreshable,
  url: z.string().url().describe("Root URL to crawl (e.g. https://example.com)"),
  maxPages: z
    .number()
    .int()
    .default(DEFAULT_PAGES)
    .transform(clampPages)
    .describe(
      "How many pages to walk, 1 to 50. Defaults to 25; a value outside the range is clamped " +
        "rather than rejected. Pass 1 to audit only the given URL; the checks that compare " +
        "pages against each other need at least two.",
    ),
};

export const metadata: ToolMetadata = {
  name: "crawl_site",
  description:
    "Walk a site from a root URL and report what only a multi-page view can show: " +
    "duplicate titles and meta descriptions, broken internal links, pages buried deep " +
    "in the click hierarchy, and the shortest pages. Also reports the given page in " +
    "full, including its internal links. Honours robots.txt and paces itself. Needs no " +
    "credentials and no database.",
  annotations: {
    title: "Crawl a site",
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: true,
  },
};

/** Completes the sentence "Could not …" for every failure this Tool can return. */
const FAILURE_CONTEXT = "crawl this site";

/**
 * Four of the report's checks compare pages against each other: a link is only
 * known broken by *visiting* it and getting a 4xx, click depth needs a second
 * hop, and both duplicate checks need two pages carrying the same string. At one
 * page none of them can fire — so their empty result is "not evaluated", and
 * printing the usual all-clear would be a false claim about the rest of the site.
 *
 * Stated once, at the end. They used to be four headings each carrying this
 * line, which read as four findings rather than one fact.
 */
const CROSS_PAGE_NA =
  "n/a — broken links, click depth, duplicate titles and duplicate meta descriptions. " +
  "Each compares pages against each other, and only one page was crawled, so none of them ran. " +
  "Their absence here is not a pass. Ask for more pages with `maxPages`.";

/**
 * The one cross-page check more pages will never answer.
 *
 * A BFS reaches a page by following a link to it, so every page it visits has an
 * inbound internal link *by construction*. An orphan is precisely the page
 * nothing links to — the one the crawl cannot arrive at. Finding them means
 * subtracting what the crawl reached from what the sitemap lists, which is a
 * different piece of work in a different module.
 *
 * Printed on every multi-page report rather than left out, because silence in a
 * report full of cross-page findings reads as "no orphans found".
 */
const ORPHANS_NA =
  "n/a — orphan pages. A crawler finds pages by following links, so every page it " +
  "reaches has one pointing at it; an orphan is the page it never arrives at. Detecting " +
  "them means comparing the sitemap against what was crawled, which this Tool does not do.";

/** How many rows any one cross-page section prints before it says how many it withheld. */
const MAX_ROWS_SHOWN = 25;

/**
 * One section, or nothing at all when there is nothing to report.
 *
 * A heading over an empty list is a claim, and the wrong one — the same reason
 * the four `n/a` headings were collapsed into one line. Every cross-page section
 * goes through here so none of them can render empty, and the withheld count is
 * always printed so a truncated list never reads as a complete one.
 */
function section(heading: string, rows: string[]): string[] {
  if (rows.length === 0) return [];
  const lines = ["", `=== ${heading} (${rows.length}) ===`];
  for (const row of rows.slice(0, MAX_ROWS_SHOWN)) lines.push(`  ${row}`);
  if (rows.length > MAX_ROWS_SHOWN) {
    lines.push(`  ... and ${rows.length - MAX_ROWS_SHOWN} more`);
  }
  return lines;
}

/**
 * The URLs sharing one string, for the two duplicate maps.
 *
 * The maps carry every value, not only the repeated ones, so the filter is the
 * check: a title appearing once is a title doing its job.
 */
function duplicateRows(map: Record<string, string[]>): string[] {
  return Object.entries(map)
    .filter(([, urls]) => urls.length > 1)
    .sort((a, b) => b[1].length - a[1].length)
    .map(([value, urls]) => `"${value}" — ${urls.length} pages: ${urls.join(", ")}`);
}

/**
 * Every page crawled, one line each.
 *
 * The alternative was `renderPageDetail` twenty-five times, which is twenty-five
 * headings and up to a hundred link targets apiece crossing the wire into a
 * model's context. Full detail stays on the page the caller actually named; the
 * rest are accounted for here, and the cross-page sections below carry the
 * findings that are the reason to walk a site at all.
 */
function renderPageIndex(pages: readonly PageResult[]): string[] {
  const lines = ["", `=== PAGES CRAWLED (${pages.length}) ===`];
  for (const page of pages) {
    const status = page.statusCode === 0 ? "unreachable" : String(page.statusCode);
    lines.push(`  [${status}] d${page.depth} ${page.url} — ${orNone(page.title)}`);
  }
  return lines;
}

/**
 * How many internal links to print per page.
 *
 * The list is one reason this Tool exists, so the cap is generous — but it is a
 * cap, because a navigation-heavy page can expose hundreds of links and the
 * whole report crosses the wire into a model's context. The withheld count is
 * always printed, so a truncated list never reads as a complete one.
 */
const MAX_LINKS_SHOWN = 100;

/** `null` and `""` both mean "the page does not have one"; say so rather than printing a blank. */
function orNone(value: string | null): string {
  return value && value.trim().length > 0 ? value : "(none)";
}

/**
 * The facts the crawler already collected about one page.
 *
 * These used to be gathered and thrown away: the report derived the issue list
 * and the duplicate maps from them and printed none of them, so a healthy page
 * produced a header and nothing else. The registered description promised every
 * field below, which made it a false claim rather than a thin one.
 *
 * Reads only `page`, so it lives apart from the handler rather than inside its
 * loop.
 */
function renderPageDetail(page: PageResult): string[] {
  const lines: string[] = ["", "=== PAGE DETAIL ==="];

  lines.push(`URL: ${page.url}`);
  if (page.finalUrl !== page.url) {
    lines.push(`Final URL: ${page.finalUrl}`);
  }
  // A count, not a chain: `PageResult` records how many hops there were, not
  // what they were. Saying "chain" here would promise the intermediate URLs,
  // which the crawler does not keep.
  lines.push(
    page.statusCode === 0
      ? "Status: unreachable (no response)"
      : `Status: ${page.statusCode}${page.redirectHops > 0 ? ` — ${page.redirectHops} redirect hop(s)` : ""}`,
  );
  lines.push(`Title: ${orNone(page.title)}`);
  lines.push(`Meta description: ${orNone(page.metaDescription)}`);
  lines.push(`Canonical: ${orNone(page.canonical)}`);
  // Phrased as the consequence, not the tag: "noindex" is what the page says,
  // "not indexable" is what it means for the caller.
  lines.push(`Indexable: ${page.isNoindex ? "no — the page declares noindex" : "yes"}`);
  // Every H1, not the first. More than one is itself the finding, and printing
  // only one would hide it.
  lines.push(`H1: ${page.h1.length === 0 ? "(none)" : page.h1.map((h) => `"${h}"`).join(", ")}`);
  // The length guidance rides on the number rather than living in a section of
  // its own. Google: "The length of the content alone doesn't matter for ranking
  // purposes" — so this is a prompt to look, never a defect. Qualified only when
  // the page is one somebody is actually trying to rank: an error page or a
  // noindex page is not being judged on length, which is the same rule the
  // crawler applies when it builds `shortPages`.
  const judgedOnLength =
    page.wordCount > 0 && page.wordCount < 300 && page.statusCode < 400 && !page.isNoindex;
  lines.push(
    `Word count: ${page.wordCount}` +
      (judgedOnLength
        ? " — under 300. Length is not a ranking factor, so this is worth a look rather than a defect: does the page say what it needs to?"
        : ""),
  );

  // ── Internal links ────────────────────────────────────────────────────────
  // The one thing no other Tool in the surface reports. `seo_analyze_page` and
  // `seo_content_analysis` each print a link *count*; neither prints the
  // targets, which is what makes "where does this page actually point?"
  // answerable here and nowhere else.
  lines.push("", `=== INTERNAL LINKS (${page.internalLinks.length}) ===`);
  if (page.internalLinks.length === 0) {
    lines.push("This page exposes no internal links.");
  } else {
    for (const link of page.internalLinks.slice(0, MAX_LINKS_SHOWN)) {
      lines.push(`  - ${link}`);
    }
    if (page.internalLinks.length > MAX_LINKS_SHOWN) {
      lines.push(`  ... and ${page.internalLinks.length - MAX_LINKS_SHOWN} more`);
    }
  }

  return lines;
}

export default defineCachedTool(
  FAILURE_CONTEXT,
  { toolName: "crawl_site", domainOf: domainFromUrl },
  async ({ url, maxPages }: InferSchema<typeof schema>) => {
    // The schema has usually clamped this already; see `clampPages` for why it
    // is applied on both sides rather than either one.
    const budget = clampPages(maxPages ?? DEFAULT_PAGES);
    const report = await crawlSite(url, budget);
    const lines: string[] = [];

    // Whether the cross-page checks could run at all, and it is a fact about the
    // crawl rather than about the request. A caller can ask for 25 pages and get
    // a site that has one; the checks did not run either way, and reporting them
    // as clear because the *budget* allowed for more would be the false all-clear
    // the `n/a` line exists to prevent.
    const crossPageRan = report.pagesCrawled > 1;

    lines.push("=== PAGE CRAWL REPORT ===");
    lines.push(`Domain: ${report.domain}`);
    lines.push(
      `Crawled: ${report.pagesCrawled} pages${report.truncated ? ` (limit: ${report.pagesLimit})` : ""}`,
    );
    // Date only. The full ISO-8601 instant was the odd one out — every other
    // report in the codebase truncates to the day — and the time-of-day says
    // nothing about the crawl while pinning exactly when the caller ran it.
    lines.push(`Date: ${report.crawledAt.slice(0, 10)}`);
    if (report.skippedByRobots > 0) {
      // Said out loud, because the alternative is a report that is quietly
      // shorter than the budget with nothing to account for the difference —
      // and a reader who cannot tell "we did not look" from "there is nothing
      // there" has been handed the wrong conclusion about their own site.
      lines.push(
        `Skipped: ${report.skippedByRobots} URL(s) this site disallows for our crawler in robots.txt. ` +
          `They were not fetched and nothing below reports on them.`,
      );
    }
    if (report.pagesLimit === 1) {
      // `pagesLimit` is the budget the engine was given, which is the clamped
      // value — so this is true for `maxPages: 0` as well, where saying "you
      // asked for one page" would not be.
      lines.push(
        "This run was budgeted for one page, so it audits the given URL and does not walk the site.",
      );
    } else if (report.truncated) {
      lines.push(`WARNING: the crawl was truncated at ${report.pagesLimit} pages.`);
    }

    // Full detail for the page the caller named, then every page crawled — the
    // seed included, so the index's count agrees with `pagesCrawled` above and a
    // reader is not left working out which page is missing from it. See
    // `renderPageIndex` for why this is not twenty-five detail blocks.
    const [seed] = report.pages;
    if (seed) lines.push(...renderPageDetail(seed));
    if (report.pages.length > 1) lines.push(...renderPageIndex(report.pages));

    if (crossPageRan) {
      lines.push(...section("DUPLICATE TITLES", duplicateRows(report.titlesMap)));
      lines.push(...section("DUPLICATE META DESCRIPTIONS", duplicateRows(report.descriptionsMap)));
      lines.push(
        ...section(
          "BROKEN LINKS",
          report.brokenLinks
            // A broken *link* needs something pointing at it. The crawler derives
            // this list from any page that came back 4xx/5xx, which includes the
            // URL the caller handed us — and nothing linked to that, so its
            // `foundOn` is empty. `PAGE DETAIL` already reports its status;
            // repeating it here would frame the requested page as a bad link
            // discovered somewhere else. That was true at one page and it stays
            // true at fifty.
            .filter((l) => l.foundOn.length > 0)
            .map(
              (l) =>
                `${l.url} — ${l.statusCode === 0 ? "unreachable" : l.statusCode}, linked from ${l.foundOn.join(", ")}`,
            ),
        ),
      );
      lines.push(
        ...section(
          "DEEP PAGES",
          report.deepPages.map((p) => `${p.url} — ${p.depth} clicks from the homepage (${p.severity})`),
        ),
      );
      lines.push(
        ...section(
          "SHORTEST PAGES",
          // Not "thin". Google states length alone is not a ranking factor, so
          // this is a list to look over, never a verdict — the same rule the
          // single-page word count already follows.
          report.shortPages.map((p) => `${p.url} — ${p.wordCount} words`),
        ),
      );
      lines.push("", "=== NOT EVALUATED ===", ORPHANS_NA);
    } else {
      lines.push("", "=== NOT EVALUATED ===", CROSS_PAGE_NA);
    }

    const issueCount: Record<string, number> = {};
    for (const page of report.pages) {
      for (const issue of page.issues) {
        issueCount[issue.type] = (issueCount[issue.type] ?? 0) + 1;
      }
    }
    const sortedIssues = Object.entries(issueCount).sort((a, b) => b[1] - a[1]);
    if (sortedIssues.length > 0) {
      lines.push("", `=== ISSUE SUMMARY (all ${report.pagesCrawled} pages) ===`);
      for (const [type, count] of sortedIssues) {
        lines.push(`  ${count}x ${type.replace(/_/g, " ")}`);
      }
    }

    return toolText(lines.join("\n"));
  },
);
