import { type ToolMetadata, type InferSchema } from "xmcp";
import { defineGoogleTool } from "../lib/define-tool";
import { toolText } from "../lib/tool-result";
import { fetchRows, gscWindowSchema } from "../lib/google/gsc-tool-shape";
import { busiest, inspectPages, sampleNote, SAMPLE_SIZE, UNINSPECTED_NOTE } from "../lib/google/busiest-pages";
import type { GoogleReader } from "../lib/google/reader";
import { capped } from "../lib/render-list";
import { basisSection, notCheckedSection } from "../lib/render-basis";

export const schema = gscWindowSchema;

export const metadata: ToolMetadata = {
  name: "gsc_crawl_freshness",
  description:
    "When Google last crawled the site's busiest pages. Use this after publishing a " +
    "change: a page Google has not revisited cannot be showing your new title, and no " +
    "amount of waiting for a ranking change means anything until it has. Needs the " +
    "Google login; without it this Tool says so.",
  annotations: {
    title: "Check when Google last crawled",
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: false,
    openWorldHint: true,
  },
};

/** Completes the sentence "Could not …" for every failure this Tool can return. */
const FAILURE_CONTEXT = "check when Google last crawled this site";

/** How many stale URLs to print. */
const MAX_STALE_SHOWN = 20;

/** Past this, a page is worth mentioning as stale. Ours, not Google's. */
const STALE_DAYS = 30;

function daysSince(iso: string): number | null {
  const at = Date.parse(iso);
  if (Number.isNaN(at)) return null;
  return Math.floor((Date.now() - at) / 86_400_000);
}

export async function handler(args: InferSchema<typeof schema>, google: GoogleReader) {
  const fetched = await fetchRows(google.searchConsole, args, { dimensions: ["page"], title: "CRAWL FRESHNESS" });
  const chosen = busiest(fetched, { by: "impressions", max: SAMPLE_SIZE, default: SAMPLE_SIZE });
  const inspected = await inspectPages(
    google.searchConsole,
    fetched.property,
    chosen.pages.map((page) => page.url),
  );
  // Closes every answer below, the empty ones included: an inspection that did
  // not complete is as absent from "nothing to say" as from a median.
  const sample = sampleNote({ reported: chosen.reported, chosen: chosen.pages.length, by: chosen.by, inspected });
  const note = [
    ...notCheckedSection(sample.notChecked, { noun: "URLs", note: UNINSPECTED_NOTE }),
    ...basisSection(fetched.basis, sample),
  ];

  const crawled = chosen.pages.flatMap((page, index) => {
    const entry = inspected[index];
    if (!entry.ok) return [];
    const last = entry.summary.index.lastCrawlTime;
    return [{ url: page.url, impressions: page.impressions, last, age: last ? daysSince(last) : null }];
  });

  const lines: string[] = [...fetched.header];
  lines.push("");

  if (chosen.pages.length === 0) {
    lines.push("No page had impressions in this window, so there was nothing to inspect.");
    lines.push(...note);
    return toolText(lines.join("\n"));
  }

  const dated = crawled.filter((entry) => entry.age !== null);
  const undated = crawled.filter((entry) => entry.age === null);

  if (dated.length === 0) {
    // Not "never crawled". Google omits the field for pages it has no crawl
    // record of *and* sometimes for ones it does, and reporting an absence as a
    // date of never would be inventing one.
    lines.push("Google reported no last-crawl date for any page inspected.");
    lines.push("That is an absence of information rather than a crawl that never happened.");
    lines.push(...note);
    return toolText(lines.join("\n"));
  }

  const ages = dated.map((entry) => entry.age!).sort((a, b) => a - b);
  const median = ages[Math.floor(ages.length / 2)];
  lines.push(`Median page was last crawled ${median} day(s) ago.`);
  lines.push(`Most recent: ${ages[0]} day(s) ago. Oldest: ${ages[ages.length - 1]} day(s) ago.`);

  const stale = dated.filter((entry) => (entry.age ?? 0) > STALE_DAYS).sort((a, b) => (b.age ?? 0) - (a.age ?? 0));
  lines.push("");
  if (stale.length === 0) {
    lines.push(`No page inspected has gone more than ${STALE_DAYS} days without a visit.`);
  } else {
    lines.push(`=== NOT VISITED IN ${STALE_DAYS}+ DAYS (${stale.length}) ===`);
    lines.push(
      ...capped(
        stale.map((entry) => `${entry.url} — ${entry.age} days, ${entry.impressions} impressions`),
        MAX_STALE_SHOWN,
      ),
    );
    lines.push("");
    lines.push(`${STALE_DAYS} days is our threshold, not Google's — it publishes no crawl`);
    lines.push("schedule. A page Google visits rarely is usually a page it considers stable or");
    lines.push("unimportant rather than one it is failing to reach, so this is a prompt to check");
    lines.push("whether the page still deserves the traffic it gets, not an error.");
  }

  if (undated.length > 0) {
    lines.push("");
    lines.push(`${undated.length} page(s) had no crawl date reported and are excluded above.`);
  }

  lines.push(...note);
  return toolText(lines.join("\n"));
}

export default defineGoogleTool(
  FAILURE_CONTEXT,
  { toolName: "gsc_crawl_freshness", domainOf: (args) => args.siteUrl ?? null },
  handler,
);
