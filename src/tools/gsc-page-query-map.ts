import { z } from "zod";
import { type ToolMetadata, type InferSchema } from "xmcp";
import { defineGoogleTool } from "../lib/define-tool";
import { toolText } from "../lib/tool-result";
import { fetchRows, gscWindowSchema, whatTheseRowsAre } from "../lib/google/gsc-tool-shape";
import { keyOf, totalsOf } from "../lib/google/gsc-analysis";
import type { GoogleReader, SearchAnalyticsRow } from "../lib/google/reader";

export const schema = {
  ...gscWindowSchema,
  page: z
    .string()
    .optional()
    .describe("One page's URL, to see only what it ranks for. Omit for the whole site."),
};

export const metadata: ToolMetadata = {
  name: "gsc_page_query_map",
  description:
    "Which queries each page actually ranks for. This is what a page is understood to " +
    "be about, as opposed to what it was written to be about — the two differing is the " +
    "most useful thing this report shows. Needs the Google login; without it this Tool " +
    "says so.",
  annotations: {
    title: "Map pages to the queries they rank for",
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: true,
  },
};

/** Completes the sentence "Could not …" for every failure this Tool can return. */
const FAILURE_CONTEXT = "map this site's pages to their queries";

const MAX_PAGES = 20;
const MAX_QUERIES_PER_PAGE = 10;

export async function handler(args: InferSchema<typeof schema>, google: GoogleReader) {
  const { rows, header } = await fetchRows(google.searchConsole, args, {
    dimensions: ["page", "query"],
    rowLimit: 10_000,
    title: "PAGES AND THE QUERIES THEY RANK FOR",
  });

  const wanted = args.page;
  const relevant = wanted ? rows.filter((row) => keyOf(row, 0) === wanted) : rows;

  const byPage = new Map<string, SearchAnalyticsRow[]>();
  for (const row of relevant) {
    const page = keyOf(row, 0);
    byPage.set(page, [...(byPage.get(page) ?? []), row]);
  }

  const lines = [...header];
  if (wanted) lines.push(`Page: ${wanted}`);
  lines.push("");

  if (byPage.size === 0) {
    lines.push(
      wanted
        ? `No queries reported for ${wanted} in this window. Check the URL exactly as Search ` +
          `Console records it — a trailing slash or a query string makes it a different page.`
        : "No page and query rows in this window.",
    );
    lines.push(...whatTheseRowsAre(rows.length, 10_000));
    return toolText(lines.join("\n"));
  }

  const ranked = [...byPage.entries()]
    .map(([page, pageRows]) => ({ page, rows: pageRows, totals: totalsOf(pageRows) }))
    .sort((a, b) => b.totals.clicks - a.totals.clicks);

  lines.push(`Pages with reported queries: ${ranked.length}`);

  for (const entry of ranked.slice(0, MAX_PAGES)) {
    lines.push("");
    lines.push(
      `${entry.page} — ${Math.round(entry.totals.clicks)} clicks, ` +
        `${Math.round(entry.totals.impressions)} impressions, ` +
        `${entry.rows.length} queries reported`,
    );
    const queries = [...entry.rows].sort((a, b) => b.clicks - a.clicks);
    for (const row of queries.slice(0, MAX_QUERIES_PER_PAGE)) {
      lines.push(
        `  ${keyOf(row, 1)} — ${row.clicks} clicks, ${row.impressions} impressions, ` +
          `position ${row.position.toFixed(1)}`,
      );
    }
    if (queries.length > MAX_QUERIES_PER_PAGE) {
      lines.push(`  ... and ${queries.length - MAX_QUERIES_PER_PAGE} more queries`);
    }
  }
  if (ranked.length > MAX_PAGES) {
    lines.push("");
    lines.push(`... and ${ranked.length - MAX_PAGES} more pages`);
  }

  lines.push("");
  lines.push("=== WHAT TO LOOK FOR ===");
  lines.push("A page ranking for queries it was not written for. That is not a fault by itself —");
  lines.push("Google understood the page somehow — but it usually means either the page should");
  lines.push("say more about what it is actually being found for, or those queries belong on a");
  lines.push("different page that does not exist yet.");

  lines.push(...whatTheseRowsAre(rows.length, 10_000));
  return toolText(lines.join("\n"));
}

export default defineGoogleTool(
  FAILURE_CONTEXT,
  { toolName: "gsc_page_query_map", domainOf: (args) => args.siteUrl ?? null },
  handler,
);
