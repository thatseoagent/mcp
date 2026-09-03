import { type ToolMetadata, type InferSchema } from "xmcp";
import { defineGoogleTool } from "../lib/define-tool";
import { toolText } from "../lib/tool-result";
import { fetchRows, gscWindowSchema } from "../lib/google/gsc-tool-shape";
import { segmentShares } from "../lib/google/gsc-analysis";
import type { GoogleReader } from "../lib/google/reader";

export const schema = { ...gscWindowSchema };

export const metadata: ToolMetadata = {
  name: "gsc_search_appearance",
  description:
    "How the site's results look in Google — plain blue links, rich results, FAQs, " +
    "videos, and the rest — with the clicks and CTR each appearance earns. This is the " +
    "only report that says whether structured data is doing anything. Needs the Google " +
    "login; without it this Tool says so.",
  annotations: {
    title: "Read Search Console search appearances",
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: true,
  },
};

/** Completes the sentence "Could not …" for every failure this Tool can return. */
const FAILURE_CONTEXT = "read this site's search appearances";

export async function handler(args: InferSchema<typeof schema>, google: GoogleReader) {
  const { rows, header, footer } = await fetchRows(google.searchConsole, args, {
    dimensions: ["searchAppearance"],
    rowLimit: 100,
    title: "SEARCH APPEARANCES",
  });

  const shares = segmentShares(rows);
  const lines = [...header];
  lines.push("");

  if (shares.length === 0) {
    // A real and common answer, and one that is easy to misread: Search Console
    // reports this dimension only for results that qualified for an enhanced
    // appearance at all.
    lines.push("Search Console reports no search appearances for this property in this window.");
    lines.push("");
    lines.push("This dimension only covers results that qualified for something beyond a plain");
    lines.push("link — rich results, FAQs, videos, and so on. Nothing here means no result of");
    lines.push("this site's earned one, which is the normal state for a site without structured");
    lines.push("data. seo_schema_detection says what a given page publishes.");
    return toolText(lines.join("\n"));
  }

  lines.push("appearance — impressions (share) / clicks / CTR / position");
  for (const share of shares) {
    lines.push(
      `  ${share.segment} — ${Math.round(share.totals.impressions)} ` +
        `(${(share.impressionShare * 100).toFixed(1)}%) / ${Math.round(share.totals.clicks)} / ` +
        `${(share.totals.ctr * 100).toFixed(2)}% / ${share.totals.position.toFixed(1)}`,
    );
  }

  lines.push("");
  lines.push("=== READING THESE ===");
  lines.push("The appearances overlap: one impression can be counted under more than one, so");
  lines.push("these do not add up to the property's total and are not meant to. What is worth");
  lines.push("comparing is each appearance's CTR against the others — an enhanced result that");
  lines.push("earns no more clicks than a plain one is structured data that is not paying for");
  lines.push("itself.");

  lines.push(...footer);
  return toolText(lines.join("\n"));
}

export default defineGoogleTool(
  FAILURE_CONTEXT,
  { toolName: "gsc_search_appearance", domainOf: (args) => args.siteUrl ?? null },
  handler,
);
