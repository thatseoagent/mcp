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
  name: "gsc_rich_results",
  description:
    "Which rich results Google has actually detected on the site's busiest pages, and " +
    "which pages it found none on. This is Google's own answer, as opposed to what the " +
    "markup on the page claims — seo_schema_detection covers that side. Needs the " +
    "Google login; without it this Tool says so.",
  annotations: {
    title: "Check rich results Google detected",
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: false,
    openWorldHint: true,
  },
};

/** Completes the sentence "Could not …" for every failure this Tool can return. */
const FAILURE_CONTEXT = "check the rich results Google detected on this site";

/** How many rich-result types to list as absent. */
const MAX_WITHOUT_SHOWN = 15;

/** How many example URLs to print per rich-result type. */
const EXAMPLE_URLS = 5;

export async function handler(args: InferSchema<typeof schema>, google: GoogleReader) {
  const fetched = await fetchRows(google.searchConsole, args, { dimensions: ["page"], title: "RICH RESULTS" });
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
  const withTypes = answered.filter((entry) => entry.summary.richResultTypes.length > 0);
  const without = answered.filter((entry) => entry.summary.richResultTypes.length === 0);

  const lines: string[] = [...fetched.header];
  lines.push("");

  if (chosen.pages.length === 0) {
    lines.push("No page had impressions in this window, so there was nothing to inspect.");
    lines.push(...basisSection(fetched.basis, sampleNote({ reported: chosen.reported, chosen: 0, by: chosen.by, inspected })));
    return toolText(lines.join("\n"));
  }

  lines.push(`Pages with rich results detected: ${withTypes.length} of ${answered.length}`);

  const byType = new Map<string, string[]>();
  for (const entry of withTypes) {
    for (const type of entry.summary.richResultTypes) {
      byType.set(type, [...(byType.get(type) ?? []), entry.url]);
    }
  }

  if (byType.size > 0) {
    lines.push("");
    lines.push("=== BY TYPE ===");
    for (const [type, urls] of [...byType.entries()].sort((a, b) => b[1].length - a[1].length)) {
      lines.push(`${type} — ${urls.length} page(s)`);
      lines.push(...capped(urls, EXAMPLE_URLS));
    }
  }

  // Verdicts kept separate from detection: a page can have a type detected *and*
  // a verdict that is not PASS, which means the markup is there and Google will
  // not use it — the most actionable state and the easiest to miss.
  const failing = answered.filter(
    (entry) => entry.summary.richResultsVerdict !== null && entry.summary.richResultsVerdict !== "PASS",
  );
  if (failing.length > 0) {
    lines.push("");
    lines.push(`=== DETECTED BUT NOT USABLE (${failing.length}) ===`);
    lines.push("Google found markup on these and will not show a rich result from it. Run the");
    lines.push("URL through Google's Rich Results Test to see which field it objected to.");
    for (const entry of failing) {
      lines.push(`  ${entry.url} — verdict ${entry.summary.richResultsVerdict}`);
    }
  }

  if (without.length > 0) {
    lines.push("");
    lines.push(`=== NOTHING DETECTED (${without.length}) ===`);
    lines.push("Not a fault. Most pages do not qualify for a rich result and do not need to —");
    lines.push("there is no rich result for an ordinary article or a homepage. It is worth a");
    lines.push("look only where the page is the kind Google has a rich result for: a product, a");
    lines.push("recipe, an event, an FAQ.");
    lines.push(
      ...capped(
        without.map((entry) => `${entry.url} — ${entry.impressions} impressions`),
        MAX_WITHOUT_SHOWN,
      ),
    );
  }

  const sample = sampleNote({ reported: chosen.reported, chosen: chosen.pages.length, by: chosen.by, inspected });
  lines.push(...notCheckedSection(sample.notChecked, { noun: "URLs", note: UNINSPECTED_NOTE }));
  lines.push(
    ...basisSection(fetched.basis, sample, {
      read: [],
      limits: [
        "This is Google's record of what it detected, not a reading of the page's markup.",
        "Markup added recently will not appear until Google recrawls — gsc_crawl_freshness",
        "says when that last happened.",
      ],
    }),
  );
  return toolText(lines.join("\n"));
}

export default defineGoogleTool(
  FAILURE_CONTEXT,
  { toolName: "gsc_rich_results", domainOf: (args) => args.siteUrl ?? null },
  handler,
);
