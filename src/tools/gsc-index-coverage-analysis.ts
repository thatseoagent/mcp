import { type ToolMetadata, type InferSchema } from "xmcp";
import { defineGoogleTool } from "../lib/define-tool";
import { toolText } from "../lib/tool-result";
import { fetchRows, gscWindowSchema } from "../lib/google/gsc-tool-shape";
import { busiest, inspectPages, sampleNote, SAMPLE_SIZE, UNINSPECTED_NOTE } from "../lib/google/busiest-pages";
import { canonicalDisagrees } from "../lib/google/inspection-report";
import type { GoogleReader } from "../lib/google/reader";
import { capped } from "../lib/render-list";
import { basisSection, notCheckedSection } from "../lib/render-basis";

export const schema = gscWindowSchema;

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

export async function handler(args: InferSchema<typeof schema>, google: GoogleReader) {
  const fetched = await fetchRows(google.searchConsole, args, { dimensions: ["page"], title: "INDEX COVERAGE" });
  const chosen = busiest(fetched, { by: "impressions", max: SAMPLE_SIZE, default: SAMPLE_SIZE });
  const inspected = await inspectPages(
    google.searchConsole,
    fetched.property,
    chosen.pages.map((page) => page.url),
  );

  const answered = chosen.pages.flatMap((page, index) => {
    const entry = inspected[index];
    return entry.ok ? [{ url: page.url, impressions: page.impressions, summary: entry.summary }] : [];
  });
  const indexed = answered.filter((entry) => entry.summary.index.verdict === "PASS");
  const notIndexed = answered.filter((entry) => entry.summary.index.verdict !== "PASS");

  const lines: string[] = [...fetched.header];
  lines.push("");

  if (chosen.pages.length === 0) {
    lines.push("No page had impressions in this window, so there was nothing to inspect.");
    lines.push(...basisSection(fetched.basis, sampleNote({ reported: chosen.reported, chosen: 0, by: chosen.by, inspected })));
    return toolText(lines.join("\n"));
  }

  lines.push(`Indexed: ${indexed.length} of ${answered.length} inspected`);
  lines.push(`Not reported as indexed: ${notIndexed.length}`);

  if (notIndexed.length > 0) {
    // Grouped by Google's own coverage state rather than listed flat: "crawled,
    // currently not indexed" and "blocked by robots.txt" need completely
    // different work, and a flat list makes them look like one problem.
    const byReason = new Map<string, typeof notIndexed>();
    for (const entry of notIndexed) {
      const reason = entry.summary.index.coverageState ?? "no coverage state reported";
      byReason.set(reason, [...(byReason.get(reason) ?? []), entry]);
    }

    lines.push("");
    lines.push("=== WHY NOT, IN GOOGLE'S OWN WORDS ===");
    for (const [reason, entries] of [...byReason.entries()].sort((a, b) => b[1].length - a[1].length)) {
      lines.push("");
      lines.push(`${reason} — ${entries.length} page(s)`);
      lines.push(
        ...capped(
          entries.map((entry) => `${entry.url} — ${entry.impressions} impressions`),
          MAX_ENTRIES_SHOWN,
        ),
      );
    }
  }

  const wrongCanonical = answered.filter((entry) => canonicalDisagrees(entry.summary.index));
  if (wrongCanonical.length > 0) {
    // Separate from "not indexed" because these pages *are* indexed — just not as
    // themselves, which is a different and much easier problem to miss.
    lines.push("");
    lines.push(`=== INDEXED AS SOMETHING ELSE (${wrongCanonical.length}) ===`);
    lines.push("These are indexed, but under a canonical Google chose rather than the one they");
    lines.push("declare. The URL in the results is the other one.");
    for (const entry of wrongCanonical) {
      lines.push(`  ${entry.url}`);
      lines.push(`    Google chose: ${entry.summary.index.googleCanonical}`);
    }
  }

  if (notIndexed.length === 0 && wrongCanonical.length === 0) {
    lines.push("");
    lines.push("Every page inspected is indexed as itself.");
  }

  const sample = sampleNote({ reported: chosen.reported, chosen: chosen.pages.length, by: chosen.by, inspected });
  lines.push(...notCheckedSection(sample.notChecked, { noun: "URLs", note: UNINSPECTED_NOTE }));
  lines.push(
    ...basisSection(fetched.basis, sample, {
      read: [],
      limits: [
        "A page absent from Search Console's performance report will not appear here at",
        "all — this samples pages that already get impressions. For a page you believe",
        "should be indexed and is not, inspect it directly with gsc_inspect_url.",
      ],
    }),
  );
  return toolText(lines.join("\n"));
}

export default defineGoogleTool(
  FAILURE_CONTEXT,
  { toolName: "gsc_index_coverage_analysis", domainOf: (args) => args.siteUrl ?? null },
  handler,
);
