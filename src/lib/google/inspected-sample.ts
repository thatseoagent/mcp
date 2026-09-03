/**
 * Inspecting the pages that matter, rather than the pages that exist.
 *
 * Three Tools — index coverage, crawl freshness and rich results — all want the
 * same thing: a set of the site's real pages, with Google's own record for each.
 * Getting there has one hard constraint and one easy mistake.
 *
 * **The constraint** is that URL Inspection is rationed per property per day, and
 * a spent inspection does not come back. So the sample is small and deliberate.
 *
 * **The mistake** is sampling arbitrarily. A site's first fifty URLs
 * alphabetically say nothing about the site; the fifty with the most impressions
 * are the ones whose indexing state an Operator would actually act on. Search
 * Console already knows which those are, and asking it costs one request rather
 * than one per URL.
 *
 * Everything goes through `inspectUrlOnce`, so three Tools run in one session
 * share their inspections instead of spending the budget three times over.
 */
import { inspectUrlOnce } from "./inspection-cache";
import { summarise, type InspectionSummary } from "./inspection-report";
import { UpstreamApiError } from "../upstream-api-error";
import type { SearchConsoleReader } from "./reader";

/**
 * How many pages one of these Tools inspects.
 *
 * Small, because of the rationing. Twenty of a property's busiest pages is
 * enough to see a pattern and cheap enough to run daily; the Tools say how many
 * they looked at so nobody reads the sample as the site.
 */
export const SAMPLE_SIZE = 20;

/** How many inspections run at once. Google rate-limits this API tightly. */
const CONCURRENCY = 5;

export type Inspected =
  | { url: string; impressions: number; clicks: number; ok: true; summary: InspectionSummary }
  | { url: string; impressions: number; clicks: number; ok: false; reason: string };

export interface Sample {
  inspected: Inspected[];
  /** How many pages the property reported for the window, before the cap. */
  pagesReported: number;
}

/**
 * The property's busiest pages, inspected.
 *
 * `allSettled` per batch, because one URL that fails must not discard the
 * inspections already spent on the others — those are gone from the day's
 * allowance whether or not a report renders.
 */
export async function inspectBusiestPages(
  reader: SearchConsoleReader,
  property: string,
  window: { startDate: string; endDate: string },
  size = SAMPLE_SIZE,
): Promise<Sample> {
  const rows = await reader.searchAnalytics({
    siteUrl: property,
    startDate: window.startDate,
    endDate: window.endDate,
    dimensions: ["page"],
    rowLimit: 1_000,
  });

  const busiest = [...rows].sort((a, b) => b.impressions - a.impressions).slice(0, size);
  const inspected: Inspected[] = [];

  for (let start = 0; start < busiest.length; start += CONCURRENCY) {
    const batch = busiest.slice(start, start + CONCURRENCY);
    const settled = await Promise.allSettled(
      batch.map((row) => inspectUrlOnce(reader, property, row.keys?.[0] ?? "")),
    );

    settled.forEach((outcome, index) => {
      const row = batch[index];
      const url = row.keys?.[0] ?? "";
      const shared = { url, impressions: row.impressions, clicks: row.clicks };

      if (outcome.status === "fulfilled") {
        inspected.push({ ...shared, ok: true, summary: summarise(outcome.value) });
      } else {
        inspected.push({
          ...shared,
          ok: false,
          reason:
            outcome.reason instanceof UpstreamApiError
              ? outcome.reason.message
              : "the inspection did not complete (its cause has been logged)",
        });
      }
    });
  }

  return { inspected, pagesReported: rows.length };
}

/**
 * The sentence every Tool built on this owes its reader.
 *
 * Without it the report reads as a statement about the site, and it is a
 * statement about twenty pages.
 */
export function whatWasSampled(sample: Sample, size = SAMPLE_SIZE): string[] {
  const lines = ["", "=== WHAT WAS SAMPLED ==="];
  lines.push(
    `${sample.inspected.length} of the ${sample.pagesReported} page(s) Search Console reported ` +
      `for this window, chosen by impressions.`,
  );

  if (sample.pagesReported > size) {
    lines.push(
      `The rest were not inspected. Google rations URL Inspection per property per day, so ` +
        `the allowance is spent on the pages most worth knowing about rather than on all of them.`,
    );
  }

  const failed = sample.inspected.filter((entry) => !entry.ok).length;
  if (failed > 0) {
    lines.push(`${failed} inspection(s) did not complete, and are counted nowhere above.`);
  }

  return lines;
}
