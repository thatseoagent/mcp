import { z } from "zod";
import { type ToolMetadata, type InferSchema } from "xmcp";
import { defineGoogleTool } from "../lib/define-tool";
import { toolText } from "../lib/tool-result";
import { fetchRows, gscWindowSchema, whatTheseRowsAre } from "../lib/google/gsc-tool-shape";
import { cannibalization } from "../lib/google/gsc-analysis";
import type { GoogleReader } from "../lib/google/reader";

export const schema = {
  ...gscWindowSchema,
  minImpressions: z
    .number()
    .int()
    .optional()
    .describe("How often a page must appear for a query to count as competing. Default 10."),
};

export const metadata: ToolMetadata = {
  name: "gsc_detect_cannibalization",
  description:
    "Find queries where more than one page of the site appears in Google's results. " +
    "Reports what the rows show without calling it a fault — two pages on one query is " +
    "often correct. Needs the Google login; without it this Tool says so.",
  annotations: {
    title: "Find queries with more than one page",
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: true,
  },
};

/** Completes the sentence "Could not …" for every failure this Tool can return. */
const FAILURE_CONTEXT = "look for competing pages on this site";

const MAX_SHOWN = 20;

export async function handler(args: InferSchema<typeof schema>, google: GoogleReader) {
  const { rows, header } = await fetchRows(google.searchConsole, args, {
    // Both dimensions, which is what makes the pairing possible at all.
    dimensions: ["query", "page"],
    rowLimit: 10_000,
    title: "QUERIES WITH MORE THAN ONE PAGE",
  });

  const found = cannibalization(rows, args.minImpressions ?? 10);

  const lines = [...header];
  lines.push("");
  if (found.length === 0) {
    lines.push("No query in this window has two pages clearing the impression floor.");
    lines.push(...whatTheseRowsAre(rows.length, 10_000));
    return toolText(lines.join("\n"));
  }

  lines.push(`Queries with more than one page: ${found.length}`);
  lines.push("");
  // Said before the list rather than after it, because the list reads as a defect
  // report otherwise and this is the single most over-diagnosed finding in SEO.
  lines.push("Read this as a description, not a defect. Two pages appearing for one query is");
  lines.push("a fact; that they are *competing* is an interpretation, and often the wrong one —");
  lines.push("a category page and a product page on the same term is usually correct. What is");
  lines.push("worth looking at is a query where the pages trade places run to run, or where the");
  lines.push("one you want to rank is not the one Google picked.");

  for (const entry of found.slice(0, MAX_SHOWN)) {
    lines.push("");
    lines.push(`"${entry.query}" — ${entry.pages.length} pages, best position ${entry.bestPosition.toFixed(1)}`);
    for (const page of entry.pages) {
      lines.push(
        `  ${page.page} — ${page.impressions} impressions, ${page.clicks} clicks, position ${page.position.toFixed(1)}`,
      );
    }
  }
  if (found.length > MAX_SHOWN) {
    lines.push("");
    lines.push(`... and ${found.length - MAX_SHOWN} more queries`);
  }

  lines.push(...whatTheseRowsAre(rows.length, 10_000));
  return toolText(lines.join("\n"));
}

export default defineGoogleTool(
  FAILURE_CONTEXT,
  { toolName: "gsc_detect_cannibalization", domainOf: (args) => args.siteUrl ?? null },
  handler,
);
