import { z } from "zod";
import { type ToolMetadata, type InferSchema } from "xmcp";
import { defineGoogleTool } from "../lib/define-tool";
import { toolText } from "../lib/tool-result";
import { fetchRows, gscWindowSchema } from "../lib/google/gsc-tool-shape";
import { keyOf } from "../lib/google/gsc-analysis";
import type { GoogleReader } from "../lib/google/reader";
import { crawlSite, type CrawlReport, type PageResult } from "../lib/crawlers/site-crawler";
import { findSitemaps, readSitemaps, describeSitemapRead } from "../lib/site-sitemap";
import { readPages } from "../lib/google/busiest-pages";
import { hostKey, inProperty, propertyRoot, urlKey } from "../lib/url-match";
import { capped } from "../lib/render-list";
import { basisSection, notCheckedSection } from "../lib/render-basis";
import { clampPages, PAGE_CEILING } from "./crawl-site";

export const schema = {
  ...gscWindowSchema,
  maxPages: z
    .number()
    .int()
    .optional()
    .describe(
      `How many pages the crawl walks, 1 to ${PAGE_CEILING}. Defaults to ${PAGE_CEILING}, the ` +
        "most crawl_site will walk, because an orphan is only visible against as much of the " +
        "site as was reached.",
    ),
  sitemapUrl: z
    .string()
    .url()
    .optional()
    .describe(
      "A sitemap to read instead of the ones submitted in Search Console (or, failing those, " +
        "the ones robots.txt names).",
    ),
};

export const metadata: ToolMetadata = {
  name: "site_orphan_pages",
  description:
    "Which pages Google shows that the site's own links do not reach, and which pages the " +
    "site lists or links that Google showed nobody. Crosses Search Console's pages with a " +
    "crawl of the site (at most 50 pages) and its sitemaps, and counts what is only in the " +
    "sitemap, only in the crawl, or in both. Honours robots.txt and paces itself. Needs the " +
    "Google login; without it this Tool says so.",
  annotations: {
    title: "Find orphan and zombie pages",
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: true,
  },
};

/** Completes the sentence "Could not …" for every failure this Tool can return. */
const FAILURE_CONTEXT = "compare this site's Search Console pages with its crawl and sitemaps";

/** How many URLs any one list prints before it says how many it withheld. */
const MAX_SHOWN = 25;

/** A crawled page that answered with something readable. */
function answered(page: PageResult): boolean {
  return page.statusCode >= 200 && page.statusCode < 300;
}

/**
 * A crawled page expected to earn impressions, so that having none says something.
 *
 * Not a `noindex` page, which asked not to be shown, and not one whose canonical
 * points elsewhere, which asked for another URL to be shown in its place. Both
 * have zero impressions by design, and calling them zombies would report the
 * site doing what it said.
 */
function expectsImpressions(page: PageResult): boolean {
  if (!answered(page) || page.isNoindex) return false;
  if (!page.canonical) return true;
  return urlKey(page.canonical, page.finalUrl) === urlKey(page.finalUrl);
}

interface CrawlSets {
  /** Every URL the crawl fetched and read. */
  fetched: Map<string, PageResult>;
  /** Every URL a fetched page links to, plus the seed. What "reached" means below. */
  linked: Set<string>;
}

function crawlSets(report: CrawlReport, seed: string): CrawlSets {
  const fetched = new Map<string, PageResult>();
  const linked = new Set<string>();
  const seedKey = urlKey(seed);
  if (seedKey) linked.add(seedKey);

  for (const page of report.pages) {
    if (!answered(page)) continue;
    for (const url of [page.url, page.finalUrl]) {
      const key = urlKey(url);
      if (key) fetched.set(key, page);
    }
    for (const link of page.internalLinks) {
      const key = urlKey(link);
      if (key) linked.add(key);
    }
  }
  return { fetched, linked };
}

export async function handler(args: InferSchema<typeof schema>, google: GoogleReader) {
  const fetched = await fetchRows(google.searchConsole, args, {
    dimensions: ["page"],
    title: "ORPHAN AND ZOMBIE CANDIDATES",
  });

  const root = propertyRoot(fetched.property);
  const origin = new URL(root).origin;
  const budget = clampPages(args.maxPages ?? PAGE_CEILING);

  // The sitemaps first: a refusal from Search Console's sitemap list should stop
  // the Tool before it has spent fifty requests on the Operator's server.
  const sitemapRoots = await findSitemaps(origin, {
    searchConsole: google.searchConsole,
    property: fetched.property,
    explicit: args.sitemapUrl,
  });
  const sitemaps = await readSitemaps(sitemapRoots);

  // Read the root before crawling it, for two reasons. The crawler treats as
  // internal only links on the origin it was seeded with, so a root that
  // redirects `example.com` to `www.example.com` would find every link external
  // and report the whole site unreached. And a root that cannot be read — or
  // that robots.txt closes to us — is a crawl that did not happen, which has to
  // be said as "not checked" rather than as fifty orphans.
  const [home] = await readPages([root]);
  const seed = home.ok ? home.page.url : null;
  const crawl = seed ? await crawlSite(seed, budget) : null;
  const sets = crawl && seed ? crawlSets(crawl, seed) : null;
  const crawled = sets !== null && sets.fetched.size > 0;
  const crawlHost = seed ? hostKey(seed) : null;

  const lines = [...fetched.header];

  // ── What was read ─────────────────────────────────────────────────────────
  // Gathered here and printed at the end, under the headings every Tool uses:
  // what the answer rests on, and what it set out to read and could not.
  const sitemapRead = describeSitemapRead(sitemaps);
  const read = [`Search Console: ${fetched.rows.length} page(s) with impressions in this window.`];
  const notChecked = [...sitemapRead.notChecked];
  if (!home.ok) {
    notChecked.unshift({ subject: "Crawl", reason: `${root} could not be read: ${home.reason}` });
  } else if (!crawled || !crawl) {
    notChecked.unshift({
      subject: "Crawl",
      reason:
        crawl && crawl.skippedByRobots > 0 && crawl.pagesCrawled === 0
          ? `robots.txt disallows ${seed} for our crawler, so the crawl did not start.`
          : `the crawl from ${seed} read no page it could follow links from.`,
    });
  } else {
    read.push(
      `Crawl: ${crawl.pagesCrawled} page(s) from ${seed}, limit ${crawl.pagesLimit}. ` +
        (crawl.truncated
          ? `It stopped at the limit with pages still queued, so it did not see the whole site.`
          : `It ran out of links to follow before the limit, so it saw every page linked from the start page onward.`),
    );
    if (crawl.skippedByRobots > 0) {
      read.push(
        `  ${crawl.skippedByRobots} URL(s) were skipped because robots.txt disallows them for our ` +
          `crawler. Links on those pages were not seen.`,
      );
    }
  }
  read.push(...sitemapRead.read);

  // ── Sets ──────────────────────────────────────────────────────────────────
  const gscPages = new Map<string, { url: string; impressions: number; clicks: number }>();
  for (const row of fetched.rows) {
    const url = keyOf(row);
    const key = urlKey(url);
    if (!key || row.impressions <= 0) continue;
    const existing = gscPages.get(key);
    gscPages.set(key, {
      url: existing?.url ?? url,
      impressions: (existing?.impressions ?? 0) + row.impressions,
      clicks: (existing?.clicks ?? 0) + row.clicks,
    });
  }

  const sitemapUrls = new Map<string, string>();
  let outsideProperty = 0;
  for (const entry of sitemaps.entries) {
    if (!inProperty(entry.loc, fetched.property)) {
      outsideProperty++;
      continue;
    }
    const key = urlKey(entry.loc);
    if (key && !sitemapUrls.has(key)) sitemapUrls.set(key, entry.loc);
  }

  // ── Sitemap against crawl ─────────────────────────────────────────────────
  if (crawled && sets) {
    const inCrawl = (key: string) => sets.linked.has(key) || sets.fetched.has(key);
    const sameHost = [...sitemapUrls.entries()].filter(([, loc]) => hostKey(loc) === crawlHost);
    const both = sameHost.filter(([key]) => inCrawl(key)).length;
    const sitemapOnly = sameHost.length - both;
    const crawlKeys = new Set([...sets.linked, ...sets.fetched.keys()]);
    const crawlOnly = [...crawlKeys].filter((key) => !sitemapUrls.has(key)).length;

    lines.push("");
    lines.push("=== SITEMAP AGAINST CRAWL ===");
    lines.push(`"In the crawl" means fetched, or linked from a page that was fetched.`);
    lines.push(`In both: ${both}`);
    lines.push(`Only in the sitemap: ${sitemapOnly}`);
    lines.push(`Only in the crawl: ${crawlOnly}`);
    if (crawl?.truncated && sitemapOnly > 0) {
      lines.push(
        `The crawl stopped at ${crawl.pagesLimit} pages, so "only in the sitemap" includes pages ` +
          `it would have reached with a larger budget.`,
      );
    }
  }

  // ── Orphan candidates ─────────────────────────────────────────────────────
  lines.push("");
  if (!crawled || !sets || !crawl) {
    lines.push("=== ORPHAN CANDIDATES ===");
    lines.push("Not checked: there was no crawl to compare Search Console's pages against.");
  } else {
    const onOtherHosts = [...gscPages.values()].filter((page) => hostKey(page.url) !== crawlHost);
    const unreached = [...gscPages.entries()]
      .filter(([key, page]) => hostKey(page.url) === crawlHost && !sets.linked.has(key) && !sets.fetched.has(key))
      .map(([key, page]) => ({ ...page, inSitemap: sitemapUrls.has(key) }))
      .sort((a, b) => b.impressions - a.impressions);

    const heading = crawl.truncated
      ? `NOT REACHED WITHIN ${crawl.pagesLimit} PAGES (${unreached.length})`
      : `ORPHAN CANDIDATES (${unreached.length})`;
    lines.push(`=== ${heading} ===`);
    if (unreached.length === 0) {
      lines.push(
        crawl.truncated
          ? `Every page Search Console reported on ${crawlHost} was linked from the ${crawl.pagesCrawled} page(s) crawled.`
          : `Every page Search Console reported on ${crawlHost} is linked from the site.`,
      );
    } else {
      lines.push(
        crawl.truncated
          ? `Pages Google showed that no link on the ${crawl.pagesCrawled} page(s) crawled pointed ` +
              `to. The crawl did not see the whole site, so these are not orphans yet: a page ` +
              `deeper in could link to any of them.`
          : "Pages Google showed that no link on the site pointed to, as far as a crawl from the " +
              "start page could follow. A page reached only through a form, a script or a " +
              "robots-disallowed page would also appear here.",
      );
      lines.push(
        ...capped(
          unreached.map(
            (page) =>
              `${page.url} — ${page.impressions} impressions, ${page.clicks} clicks` +
              (page.inSitemap ? ", in the sitemap" : ", not in the sitemap either"),
          ),
          MAX_SHOWN,
          { noun: "pages" },
        ),
      );
    }
    if (onOtherHosts.length > 0) {
      lines.push(
        `${onOtherHosts.length} page(s) with impressions are on other hosts of this property than ` +
          `${crawlHost}. The crawl stays on one host, so those were not checked.`,
      );
    }
  }

  // ── Zombie candidates ─────────────────────────────────────────────────────
  const zombies = new Map<string, { url: string; inSitemap: boolean; inCrawl: boolean }>();
  for (const [key, loc] of sitemapUrls) {
    if (!gscPages.has(key)) zombies.set(key, { url: loc, inSitemap: true, inCrawl: false });
  }
  if (sets) {
    for (const [key, page] of sets.fetched) {
      if (gscPages.has(key) || !expectsImpressions(page)) continue;
      if (!inProperty(page.finalUrl, fetched.property)) continue;
      const existing = zombies.get(key);
      zombies.set(key, { url: existing?.url ?? page.finalUrl, inSitemap: existing?.inSitemap ?? false, inCrawl: true });
    }
  }
  const zombieList = [...zombies.values()];

  lines.push("");
  lines.push(`=== ZOMBIE CANDIDATES (${zombieList.length}) ===`);
  if (sitemaps.filesRead.length === 0 && !crawled) {
    lines.push("Not checked: neither a sitemap nor a crawl was read, so there are no pages to compare.");
  } else if (gscPages.size === 0 && zombieList.length > 0) {
    lines.push(
      `Search Console reported no pages at all for this window, so all ${zombieList.length} ` +
        "URL(s) the site lists or serves would be listed here for that reason alone. Check the " +
        "property and the window before reading anything into it; the list is withheld.",
    );
  } else if (zombieList.length === 0) {
    lines.push("Every page listed in the sitemap or crawled had impressions in this window.");
  } else {
    lines.push(
      "Pages the site lists in its sitemap or serves as indexable, with no impressions in these " +
        "rows. Crawled pages marked noindex or canonicalised elsewhere are left out: they have no " +
        "impressions because they asked not to.",
    );
    const where = (page: (typeof zombieList)[number]) =>
      page.inSitemap && page.inCrawl ? "sitemap and crawl" : page.inSitemap ? "sitemap" : "crawl";
    lines.push(...capped(zombieList.map((page) => `${page.url} — ${where(page)}`), MAX_SHOWN, { noun: "pages" }));
    lines.push(
      "No impressions in one window is not a verdict. A new page, a seasonal one, or one Google " +
        "has not indexed yet reads the same; gsc_inspect_url says which.",
    );
  }
  if (outsideProperty > 0) {
    lines.push(`${outsideProperty} sitemap URL(s) are outside ${fetched.property} and were not compared.`);
  }

  lines.push(...notCheckedSection(notChecked));
  lines.push(
    ...basisSection(fetched.basis, {
      read,
      limits: [
        "URLs were matched with the scheme, host case, a leading www., a trailing slash and the " +
          "fragment ignored; the query string is not, because Search Console reports ?page=2 as " +
          "its own URL.",
      ],
    }),
  );
  return toolText(lines.join("\n"));
}

export default defineGoogleTool(
  FAILURE_CONTEXT,
  { toolName: "site_orphan_pages", domainOf: (args) => args.siteUrl ?? null },
  handler,
);
