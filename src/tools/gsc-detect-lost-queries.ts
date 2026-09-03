import { z } from "zod";
import { type ToolMetadata, type InferSchema } from "xmcp";
import { defineGoogleTool } from "../lib/define-tool";
import { toolText } from "../lib/tool-result";
import {
  fetchRows,
  gscWindowSchema,
  precedingWindow,
  whatTheseRowsAre,
} from "../lib/google/gsc-tool-shape";
import { compareWindows, lost } from "../lib/google/gsc-analysis";
import { withPropertyFallback } from "../lib/google/property";
import type { GoogleReader } from "../lib/google/reader";

export const schema = {
  ...gscWindowSchema,
  minImpressions: z
    .number()
    .int()
    .optional()
    .describe("How much traffic a query needed before, to count as lost. Default 20."),
};

export const metadata: ToolMetadata = {
  name: "gsc_detect_lost_queries",
  description:
    "Find queries the site was being seen for in the previous window and is not being " +
    "seen for now. Distinguishes 'stopped being reported' from 'stopped existing', " +
    "because Search Console withholds queries and both look identical. Needs the " +
    "Google login; without it this Tool says so.",
  annotations: {
    title: "Find queries that disappeared",
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: true,
  },
};

/** Completes the sentence "Could not …" for every failure this Tool can return. */
const FAILURE_CONTEXT = "look for queries this site has stopped appearing for";

const MAX_SHOWN = 30;

export async function handler(args: InferSchema<typeof schema>, google: GoogleReader) {
  const current = await fetchRows(google.searchConsole, args, {
    dimensions: ["query"],
    title: "QUERIES NO LONGER REPORTED",
  });

  const before = precedingWindow(current.startDate, current.endDate);
  const { result: previousRows } = await withPropertyFallback(
    google.searchConsole,
    current.property,
    (resolved) =>
      google.searchConsole.searchAnalytics({
        siteUrl: resolved,
        startDate: before.startDate,
        endDate: before.endDate,
        dimensions: ["query"],
        rowLimit: 5_000,
      }),
  );

  const gone = lost(compareWindows(current.rows, previousRows), args.minImpressions ?? 20);

  const lines = [...current.header];
  lines.push(`Compared against: ${before.startDate} to ${before.endDate} (${previousRows.length} rows)`);
  lines.push("");

  if (gone.length === 0) {
    lines.push("Every query with meaningful traffic in the previous window is still being");
    lines.push("reported in this one.");
    lines.push(...whatTheseRowsAre(current.rows.length));
    return toolText(lines.join("\n"));
  }

  lines.push(`Queries reported before and not now: ${gone.length}`);
  lines.push(
    `They accounted for ${Math.round(gone.reduce((sum, m) => sum + m.before.clicks, 0))} clicks ` +
      `in the previous window.`,
  );
  lines.push("");
  // The distinction that makes this Tool honest rather than alarming.
  lines.push("This is a change in what Search Console reports, which has more than one cause.");
  lines.push("A query can vanish from the report because the page stopped ranking, because");
  lines.push("nobody searched for it this month, or because it fell below the volume Google");
  lines.push("will report at all. Only the first is a problem, and this cannot tell them apart.");
  lines.push("The ones worth checking are the queries that used to earn real clicks.");

  lines.push("");
  lines.push("query — clicks / impressions / position, as they were");
  for (const movement of gone.slice(0, MAX_SHOWN)) {
    lines.push(
      `  ${movement.key} — ${Math.round(movement.before.clicks)} / ` +
        `${Math.round(movement.before.impressions)} / ${movement.before.position.toFixed(1)}`,
    );
  }
  if (gone.length > MAX_SHOWN) lines.push(`  ... and ${gone.length - MAX_SHOWN} more`);

  lines.push(...whatTheseRowsAre(current.rows.length));
  return toolText(lines.join("\n"));
}

export default defineGoogleTool(
  FAILURE_CONTEXT,
  { toolName: "gsc_detect_lost_queries", domainOf: (args) => args.siteUrl ?? null },
  handler,
);
