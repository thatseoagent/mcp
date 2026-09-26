import { z } from "zod";
import { type ToolMetadata, type InferSchema } from "xmcp";
import { defineGoogleTool } from "../lib/define-tool";
import { toolText } from "../lib/tool-result";
import { fetchRows, gscWindowSchema } from "../lib/google/gsc-tool-shape";
import { keyOf } from "../lib/google/gsc-analysis";
import type { GoogleReader } from "../lib/google/reader";
import { inspectPages, sampleNote, sampleSize, UNINSPECTED_NOTE, type SampleNote } from "../lib/google/busiest-pages";
import { findSitemaps, readSitemaps, describeSitemapRead, type SitemapEntry } from "../lib/site-sitemap";
import { inProperty, propertyRoot, urlKey } from "../lib/url-match";
import { capped } from "../lib/render-list";
import { basisSection, notCheckedSection, type Basis, type NotChecked } from "../lib/render-basis";

/** URLs inspected when the caller does not say. */
const DEFAULT_SAMPLE = 20;

/** The most one call inspects, against a daily allowance of 2,000 per property. */
const MAX_SAMPLE = 50;

/**
 * How close to the moment we fetched the sitemap a `lastmod` has to be to read
 * as "stamped when the file was generated". Ten minutes, ours: long enough for a
 * sitemap cached briefly by a CDN, short enough that a site genuinely publishing
 * that often is rare.
 */
const STAMPED_WINDOW_MS = 10 * 60 * 1000;

/** The share of dated URLs stamped that way before the whole sitemap is called so. Ours. */
const STAMPED_SHARE = 0.8;

/** How many rows any one list prints before it says how many it withheld. */
const MAX_SHOWN = 25;

const GOOGLE_SOURCE = "https://developers.google.com/search/docs/crawling-indexing/sitemaps/build-sitemap";

export const schema = {
  ...gscWindowSchema,
  pages: z
    .number()
    .int()
    .optional()
    .describe(
      `How many sitemap URLs to inspect, those with the most impressions first. Default ` +
        `${DEFAULT_SAMPLE}, at most ${MAX_SAMPLE}. Each one spends a URL Inspection, which Google ` +
        `rations per property per day.`,
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
  name: "site_lastmod_accuracy",
  description:
    "Whether the site's sitemap <lastmod> dates can be believed. Reads the sitemaps, checks " +
    "for missing dates, for every URL carrying the same date, and for dates stamped when the " +
    "file was generated; then inspects a sample of the URLs (most impressions first) and " +
    "compares each lastmod with the last time Google crawled it. Google uses lastmod only when " +
    "it is consistently and verifiably accurate. Spends one URL Inspection per sampled URL. " +
    "Needs the Google login; without it this Tool says so.",
  annotations: {
    title: "Check sitemap lastmod against Google's crawls",
    readOnlyHint: true,
    destructiveHint: false,
    // Each run can spend inspections, which Google rations.
    idempotentHint: false,
    openWorldHint: true,
  },
};

/** Completes the sentence "Could not …" for every failure this Tool can return. */
const FAILURE_CONTEXT = "compare this site's sitemap lastmod dates with Google's crawls";

/**
 * A `lastmod`, read as the W3C Datetime the sitemap protocol asks for.
 *
 * `precision` is kept because a date-only value (`2026-09-20`) says nothing
 * about the hour, and comparing its midnight against a crawl at 10:00 the same
 * day would report the crawl as having missed a change it may well have seen.
 * Day-precision values are compared by date only.
 */
interface Lastmod {
  at: number;
  precision: "day" | "instant";
}

function parseLastmod(value: string): Lastmod | null {
  if (!/^\d{4}(?:-\d{2}(?:-\d{2})?)?(?:T.+)?$/.test(value)) return null;
  const at = Date.parse(value);
  if (!Number.isFinite(at)) return null;
  return { at, precision: value.includes("T") ? "instant" : "day" };
}

const day = (ms: number): string => new Date(ms).toISOString().slice(0, 10);

/** Is this lastmod later than this crawl, at the precision the lastmod has? */
function after(lastmod: Lastmod, crawl: number): boolean {
  return lastmod.precision === "day" ? day(lastmod.at) > day(crawl) : lastmod.at > crawl;
}

/** Was this lastmod written when the file was fetched, i.e. generated on request? */
function stampedAtFetch(lastmod: Lastmod, entry: SitemapEntry): boolean {
  if (lastmod.precision === "day") return day(lastmod.at) === day(entry.fetchedAt);
  return Math.abs(lastmod.at - entry.fetchedAt) <= STAMPED_WINDOW_MS;
}

export async function handler(args: InferSchema<typeof schema>, google: GoogleReader) {
  const fetched = await fetchRows(google.searchConsole, args, {
    dimensions: ["page"],
    title: "SITEMAP LASTMOD AGAINST GOOGLE'S CRAWLS",
  });

  const origin = new URL(propertyRoot(fetched.property)).origin;
  const roots = await findSitemaps(origin, {
    searchConsole: google.searchConsole,
    property: fetched.property,
    explicit: args.sitemapUrl,
  });
  const sitemaps = await readSitemaps(roots);

  const lines = [...fetched.header];

  // What the answer rests on and what it could not read, gathered as the Tool
  // goes and printed once at the end, whichever answer it reaches.
  const sitemapRead = describeSitemapRead(sitemaps);
  const entries = sitemaps.entries.filter((entry) => inProperty(entry.loc, fetched.property));
  const outside = sitemaps.entries.length - entries.length;
  const read = [...sitemapRead.read];
  if (outside > 0) read.push(`${outside} sitemap URL(s) are outside ${fetched.property} and were left out.`);
  const notChecked: NotChecked[] = sitemapRead.notChecked.map((file) => ({
    subject: `${file.subject} (sitemap file)`,
    reason: file.reason,
  }));
  let sampled: SampleNote | undefined;
  const closing = (...parts: Basis[]) => {
    const uninspected = notChecked.length > sitemapRead.notChecked.length;
    return [
      ...notCheckedSection(notChecked, { note: uninspected ? UNINSPECTED_NOTE : undefined }),
      ...basisSection(fetched.basis, { read }, ...parts),
    ];
  };

  if (entries.length === 0) {
    lines.push("");
    lines.push(
      sitemaps.filesRead.length === 0
        ? "Not checked: no sitemap could be read, so there are no lastmod dates to judge. Nothing was inspected."
        : "The sitemaps read list no URLs in this property, so there are no lastmod dates to judge. Nothing was inspected.",
    );
    lines.push(...closing());
    return toolText(lines.join("\n"));
  }

  // ── The sitemap on its own ────────────────────────────────────────────────
  const dated = entries
    .map((entry) => ({ entry, lastmod: entry.lastmod ? parseLastmod(entry.lastmod) : null }))
    .filter((item): item is { entry: SitemapEntry; lastmod: Lastmod } => item.lastmod !== null);
  const missing = entries.filter((entry) => !entry.lastmod).length;
  const malformed = entries.length - missing - dated.length;
  const distinct = new Set(dated.map((item) => item.entry.lastmod)).size;
  const stamped = dated.filter((item) => stampedAtFetch(item.lastmod, item.entry)).length;
  const future = dated.filter((item) => item.lastmod.at - item.entry.fetchedAt > 86_400_000).length;

  lines.push("");
  lines.push("=== THE SITEMAP ITSELF ===");
  lines.push(`URLs with a lastmod: ${dated.length} of ${entries.length}`);
  lines.push(`Missing lastmod: ${missing}`);
  if (malformed > 0) lines.push(`Not a W3C date (so unusable as a lastmod): ${malformed}`);

  const findings: string[] = [];
  if (dated.length >= 2 && distinct === 1) {
    findings.push(
      `Every dated URL carries the same lastmod (${dated[0].entry.lastmod}). A date shared by the ` +
        `whole site cannot be each page's last significant change.`,
    );
  }
  if (dated.length >= 2 && stamped / dated.length >= STAMPED_SHARE) {
    findings.push(
      `${stamped} of ${dated.length} dated URL(s) carry a lastmod within ${STAMPED_WINDOW_MS / 60_000} minutes ` +
        `of when we fetched the sitemap (or today's date, for date-only values). That is the pattern of a ` +
        `sitemap that stamps the time it was generated rather than when each page changed.`,
    );
  }
  if (future > 0) findings.push(`${future} URL(s) carry a lastmod more than a day in the future.`);
  if (missing === entries.length) {
    findings.push("No URL carries a lastmod, so Google has no dates from this sitemap to use or ignore.");
  }
  if (findings.length === 0) {
    lines.push("Nothing in the dates alone suggests they are generated rather than tracked.");
  } else {
    for (const finding of findings) lines.push(`- ${finding}`);
  }

  // ── The sample ────────────────────────────────────────────────────────────
  // The candidates are the sitemap's, not Search Console's busiest, so this
  // joins rather than selects: every sitemap URL is prioritised by the
  // impressions Search Console reported for it, matched by `urlKey` because
  // Search Console may report `https://www.example.com/a/` for a sitemap's
  // `https://example.com/a`. A URL with none keeps its place in sitemap order.
  const size = sampleSize({ count: args.pages, max: MAX_SAMPLE, default: DEFAULT_SAMPLE });
  const impressions = new Map<string, number>();
  for (const row of fetched.rows) {
    const key = urlKey(keyOf(row));
    if (key) impressions.set(key, (impressions.get(key) ?? 0) + row.impressions);
  }
  const seen = (entry: SitemapEntry) => impressions.get(urlKey(entry.loc) ?? "") ?? 0;
  const sample = dated
    .map((item, order) => ({ ...item, impressions: seen(item.entry), order }))
    .sort((a, b) => b.impressions - a.impressions || a.order - b.order)
    .slice(0, size);
  const withImpressions = sample.filter((item) => item.impressions > 0).length;

  lines.push("");
  lines.push(`=== AGAINST GOOGLE'S LAST CRAWL (${sample.length} URL(s)) ===`);

  if (sample.length === 0) {
    lines.push("Not checked: no URL has a usable lastmod, so there is nothing to compare with a crawl. Nothing was inspected.");
  } else {
    lines.push(
      withImpressions === sample.length
        ? "Sampled by impressions in this window, most first."
        : `${withImpressions} sampled by impressions in this window; the other ${sample.length - withImpressions} ` +
            `had none and were taken in sitemap order.`,
    );

    const inspections = await inspectPages(
      google.searchConsole,
      fetched.property,
      sample.map((item) => item.entry.loc),
    );

    const pending: string[] = [];
    const neverCrawled: string[] = [];
    let notInspected = 0;
    let consistent = 0;
    sample.forEach((item, index) => {
      const inspected = inspections[index];
      // Not "no crawl on record": Google did not answer, which says nothing
      // about the crawl. They are listed under NOT CHECKED, with their reasons.
      if (!inspected.ok) {
        notInspected++;
        return;
      }
      const lastCrawl = inspected.summary.index.lastCrawlTime;
      const crawlAt = lastCrawl ? Date.parse(lastCrawl) : Number.NaN;
      if (!lastCrawl || !Number.isFinite(crawlAt)) {
        neverCrawled.push(`${item.entry.loc} — lastmod ${item.entry.lastmod}`);
        return;
      }
      if (after(item.lastmod, crawlAt)) {
        pending.push(`${item.entry.loc} — lastmod ${item.entry.lastmod}, last crawled ${lastCrawl}`);
      } else {
        consistent++;
      }
    });

    lines.push(`Last crawled on or after its lastmod: ${consistent}`);
    lines.push(`lastmod after the last crawl: ${pending.length}`);
    lines.push(`No crawl on record: ${neverCrawled.length}`);
    if (notInspected > 0) lines.push(`Inspection did not complete: ${notInspected}`);

    if (pending.length > 0) {
      lines.push("");
      lines.push(`=== DECLARED CHANGES GOOGLE HAS NOT CRAWLED YET (${pending.length}) ===`);
      lines.push("The sitemap says these changed after Google last fetched them. If the dates are real, Google");
      lines.push("has not picked the change up yet; if they are generated, this list is the symptom.");
      lines.push(...capped(pending, MAX_SHOWN));
    }
    if (neverCrawled.length > 0) {
      lines.push("");
      lines.push(`=== NO CRAWL ON RECORD (${neverCrawled.length}) ===`);
      lines.push("Google reports no successful crawl of these, so their lastmod cannot be compared with one.");
      lines.push(...capped(neverCrawled, MAX_SHOWN));
    }

    sampled = sampleNote({
      reported: dated.length,
      chosen: sample.length,
      by: "impressions",
      inspected: inspections,
      of: "sitemap URL(s) with a usable lastmod",
    });
    notChecked.push(
      ...sampled.notChecked.map((url) => ({ subject: `${url.subject} (inspection)`, reason: url.reason })),
    );
  }

  lines.push("");
  lines.push("=== WHAT GOOGLE SAYS ===");
  lines.push(
    `"Google uses the <lastmod> value if it's consistently and verifiably (for example by comparing ` +
      `to the last modification of the page) accurate." It "should reflect the date and time of the ` +
      `last significant update to the page". (${GOOGLE_SOURCE})`,
  );
  lines.push(
    "That a sitemap stamping every URL with its generation time is ignored is our inference from " +
      "that sentence: such a date is not the page's last significant change, so it cannot be " +
      "verified as accurate. Google does not say how it verifies, and a lastmod after the last " +
      "crawl is evidence about the dates, not proof that Google distrusts them.",
  );

  lines.push(...closing(...(sampled ? [sampled] : [])));
  return toolText(lines.join("\n"));
}

export default defineGoogleTool(
  FAILURE_CONTEXT,
  { toolName: "site_lastmod_accuracy", domainOf: (args) => args.siteUrl ?? null },
  handler,
);
