import { type ToolMetadata, type InferSchema } from "xmcp";
import { defineGoogleTool } from "../lib/define-tool";
import { refreshable } from "../lib/with-cache";
import { toolText } from "../lib/tool-result";
import { z } from "zod";
import { resolveSiteUrl } from "../lib/google/property";
import { resolveWindow } from "../lib/google/gsc-dates";
import { inspectBusiestPages, whatWasSampled } from "../lib/google/inspected-sample";
import { canonicalDisagrees } from "../lib/google/inspection-report";
import type { GoogleReader } from "../lib/google/reader";
import { withheld } from "../lib/render-list";

export const schema = {
  ...refreshable,
  siteUrl: z.string().describe("The Search Console property, or just the domain."),
  days: z.number().int().optional().describe("Window used to pick the busiest pages. Default 28."),
};

export const metadata: ToolMetadata = {
  name: "gsc_index_coverage_analysis",
  description:
    "Ask Google what it has actually indexed among the site's busiest pages, and why " +
    "anything is not: blocked by robots, excluded by a directive, crawled and not " +
    "indexed, or indexed under a different canonical. Inspects a sample, because Google " +
    "rations inspections. Needs the Google login; without it this Tool says so.",
  annotations: {
    title: "Analyse index coverage",
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: false,
    openWorldHint: true,
  },
};

/** Completes the sentence "Could not …" for every failure this Tool can return. */
const FAILURE_CONTEXT = "analyse index coverage for this site";

/** How many URLs to print per coverage state. */
const MAX_ENTRIES_SHOWN = 10;

export async function handler(
  { siteUrl, days }: InferSchema<typeof schema>,
  google: GoogleReader,
) {
  const property = await resolveSiteUrl(google.searchConsole, siteUrl);
  const window = resolveWindow({ days: days ?? 28 });
  const sample = await inspectBusiestPages(google.searchConsole, property, window);

  const answered = sample.inspected.filter((entry) => entry.ok);
  const indexed = answered.filter((entry) => entry.ok && entry.summary.index.verdict === "PASS");
  const notIndexed = answered.filter((entry) => entry.ok && entry.summary.index.verdict !== "PASS");

  const lines: string[] = ["=== INDEX COVERAGE ==="];
  lines.push(`Property: ${property}`);
  lines.push(`Pages chosen from: ${window.startDate} to ${window.endDate}`);
  lines.push("");
  lines.push(`Indexed: ${indexed.length} of ${answered.length} inspected`);
  lines.push(`Not reported as indexed: ${notIndexed.length}`);

  if (notIndexed.length > 0) {
    // Grouped by Google's own coverage state rather than listed flat: "crawled,
    // currently not indexed" and "blocked by robots.txt" need completely
    // different work, and a flat list makes them look like one problem.
    const byReason = new Map<string, typeof notIndexed>();
    for (const entry of notIndexed) {
      if (!entry.ok) continue;
      const reason = entry.summary.index.coverageState ?? "no coverage state reported";
      byReason.set(reason, [...(byReason.get(reason) ?? []), entry]);
    }

    lines.push("");
    lines.push("=== WHY NOT, IN GOOGLE'S OWN WORDS ===");
    for (const [reason, entries] of [...byReason.entries()].sort((a, b) => b[1].length - a[1].length)) {
      lines.push("");
      lines.push(`${reason} — ${entries.length} page(s)`);
      for (const entry of entries.slice(0, 10)) {
        lines.push(`  ${entry.url} — ${entry.impressions} impressions`);
      }
      lines.push(...withheld(entries.length, MAX_ENTRIES_SHOWN));
    }
  }

  const wrongCanonical = answered.filter((entry) => entry.ok && canonicalDisagrees(entry.summary.index));
  if (wrongCanonical.length > 0) {
    // Separate from "not indexed" because these pages *are* indexed — just not as
    // themselves, which is a different and much easier problem to miss.
    lines.push("");
    lines.push(`=== INDEXED AS SOMETHING ELSE (${wrongCanonical.length}) ===`);
    lines.push("These are indexed, but under a canonical Google chose rather than the one they");
    lines.push("declare. The URL in the results is the other one.");
    for (const entry of wrongCanonical) {
      if (!entry.ok) continue;
      lines.push(`  ${entry.url}`);
      lines.push(`    Google chose: ${entry.summary.index.googleCanonical}`);
    }
  }

  if (notIndexed.length === 0 && wrongCanonical.length === 0) {
    lines.push("");
    lines.push("Every page inspected is indexed as itself.");
  }

  lines.push(...whatWasSampled(sample));
  lines.push("");
  lines.push("A page absent from Search Console's performance report will not appear here at");
  lines.push("all — this samples pages that already get impressions. For a page you believe");
  lines.push("should be indexed and is not, inspect it directly with gsc_inspect_url.");

  return toolText(lines.join("\n"));
}

export default defineGoogleTool(
  FAILURE_CONTEXT,
  { toolName: "gsc_index_coverage_analysis", domainOf: (args) => args.siteUrl ?? null },
  handler,
);
