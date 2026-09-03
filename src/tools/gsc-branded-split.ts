import { z } from "zod";
import { type ToolMetadata, type InferSchema } from "xmcp";
import { defineGoogleTool } from "../lib/define-tool";
import { toolText } from "../lib/tool-result";
import { fetchRows, gscWindowSchema, whatTheseRowsAre } from "../lib/google/gsc-tool-shape";
import { brandedSplit, isBranded } from "../lib/google/gsc-analysis";
import type { GoogleReader } from "../lib/google/reader";

export const schema = {
  ...gscWindowSchema,
  brandTerms: z
    .array(z.string())
    .describe(
      "What your brand is called, including misspellings people search for. Required, " +
        "because only you know: deriving it from the domain gets `johndoe` right and " +
        "`acme-group-uk` wrong, and a wrong split makes both halves meaningless.",
    ),
};

export const metadata: ToolMetadata = {
  name: "gsc_branded_split",
  description:
    "Split search performance into people looking for you by name and people who found " +
    "you some other way. The unbranded half is what SEO actually moved; the branded " +
    "half mostly follows what marketing did elsewhere. Needs the Google login; without " +
    "it this Tool says so.",
  annotations: {
    title: "Split branded from unbranded search",
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: true,
  },
};

/** Completes the sentence "Could not …" for every failure this Tool can return. */
const FAILURE_CONTEXT = "split this site's branded and unbranded search performance";

function share(part: number, whole: number): string {
  return whole > 0 ? `${((part / whole) * 100).toFixed(1)}%` : "n/a";
}

export async function handler(args: InferSchema<typeof schema>, google: GoogleReader) {
  const { rows, header } = await fetchRows(google.searchConsole, args, {
    dimensions: ["query"],
    title: "BRANDED AND UNBRANDED SEARCH",
  });

  const terms = (args.brandTerms ?? []).filter((term) => term.trim().length > 0);
  const lines = [...header];

  if (terms.length === 0) {
    lines.push("");
    lines.push("No brand terms were given, so there is nothing to split on.");
    lines.push("Pass `brandTerms`, including the misspellings people actually type.");
    return toolText(lines.join("\n"));
  }

  const split = brandedSplit(rows, terms);
  const clicks = split.branded.clicks + split.unbranded.clicks;
  const impressions = split.branded.impressions + split.unbranded.impressions;

  lines.push(`Brand terms: ${terms.join(", ")}`);
  lines.push("");
  lines.push("=== SPLIT ===");
  lines.push(
    `Branded: ${Math.round(split.branded.clicks)} clicks (${share(split.branded.clicks, clicks)}), ` +
      `${Math.round(split.branded.impressions)} impressions, ` +
      `${(split.branded.ctr * 100).toFixed(2)}% CTR, position ${split.branded.position.toFixed(1)} ` +
      `— ${split.brandedQueries} queries`,
  );
  lines.push(
    `Unbranded: ${Math.round(split.unbranded.clicks)} clicks (${share(split.unbranded.clicks, clicks)}), ` +
      `${Math.round(split.unbranded.impressions)} impressions, ` +
      `${(split.unbranded.ctr * 100).toFixed(2)}% CTR, position ${split.unbranded.position.toFixed(1)} ` +
      `— ${split.unbrandedQueries} queries`,
  );
  lines.push("");
  lines.push(`Impression split: ${share(split.branded.impressions, impressions)} branded.`);

  lines.push("");
  lines.push("=== WHAT THIS IS FOR ===");
  lines.push("Branded search mostly measures how many people already know the name, so it moves");
  lines.push("with advertising, press and word of mouth rather than with anything done to the");
  lines.push("pages. The unbranded half is the one SEO work shows up in — and it is the half to");
  lines.push("watch when judging whether a change helped.");
  lines.push("");
  lines.push("A high branded share is not a fault. It is normal for a well-known business, and");
  lines.push("normal for a very small site whose only visitors are people who were told about");
  lines.push("it. The number to compare is this site against itself over time.");

  // Named because the split is only as good as the terms, and a reader should be
  // able to see whether the matching did what they meant.
  const brandedExamples = rows
    .filter((row) => isBranded(row.keys?.[0] ?? "", terms))
    .slice(0, 5)
    .map((row) => row.keys?.[0] ?? "");
  if (brandedExamples.length > 0) {
    lines.push("");
    lines.push(`Counted as branded, for example: ${brandedExamples.join(", ")}`);
  }

  lines.push(...whatTheseRowsAre(rows.length));
  return toolText(lines.join("\n"));
}

export default defineGoogleTool(
  FAILURE_CONTEXT,
  { toolName: "gsc_branded_split", domainOf: (args) => args.siteUrl ?? null },
  handler,
);
