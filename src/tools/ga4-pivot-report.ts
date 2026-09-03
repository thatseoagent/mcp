import { z } from "zod";
import { type ToolMetadata, type InferSchema } from "xmcp";
import { defineGoogleTool } from "../lib/define-tool";
import { toolText } from "../lib/tool-result";
import { readReport, renderReport } from "../lib/google/ga4-report";
import { ga4Window, ga4WindowSchema } from "../lib/google/ga4-tool-shape";
import type { GoogleReader } from "../lib/google/reader";

export const schema = {
  ...ga4WindowSchema,
  metrics: z.array(z.string()).describe("GA4 metric API names, e.g. ['sessions']"),
  rowDimension: z
    .string()
    .describe("The dimension down the side, e.g. 'landingPage'"),
  columnDimension: z
    .string()
    .describe("The dimension across the top, e.g. 'sessionDefaultChannelGroup'"),
  rowLimit: z.number().int().optional().describe("How many rows down the side. Default 25."),
  columnLimit: z.number().int().optional().describe("How many columns across. Default 10."),
};

export const metadata: ToolMetadata = {
  name: "ga4_pivot_report",
  description:
    "Cross two Analytics dimensions against each other — landing pages by channel, " +
    "devices by country — instead of listing them separately. Use this when the " +
    "question is 'which of these, broken down by those'. Needs the Google login; " +
    "without it this Tool says so.",
  annotations: {
    title: "Run an Analytics pivot report",
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: true,
  },
};

/** Completes the sentence "Could not …" for every failure this Tool can return. */
const FAILURE_CONTEXT = "run this Analytics pivot report";

/**
 * Why the two limits are separate and both modest.
 *
 * A pivot's cost is the product of its two axes, not their sum: 100 rows by 50
 * columns is 5,000 cells, and GA4 charges its cardinality limit against that
 * product — past which it starts collapsing values into `(other)` and the report
 * quietly stops being about what was asked. Small defaults keep the common case
 * inside the limit; a caller who needs more can say so and will be told when
 * Google collapsed something.
 */
const DEFAULT_ROWS = 25;
const DEFAULT_COLUMNS = 10;

export async function handler(
  {
    propertyId,
    metrics,
    rowDimension,
    columnDimension,
    startDate,
    endDate,
    rowLimit,
    columnLimit,
  }: InferSchema<typeof schema>,
  google: GoogleReader,
) {
  const window = ga4Window({ propertyId, startDate, endDate }, {
    title: "ANALYTICS PIVOT REPORT",
  });

  const report = await google.analytics.runPivotReport({
    property: window.property,
    dateRanges: [window.dateRange],
    metrics,
    dimensions: [rowDimension, columnDimension],
    pivots: [
      {
        fieldNames: [rowDimension],
        limit: rowLimit ?? DEFAULT_ROWS,
        // Ordered by the first metric, descending: an unordered pivot returns
        // whichever rows GA4 reached first, which is not the interesting ones.
        orderBys: [{ metric: { metricName: metrics[0] }, desc: true }],
      },
      { fieldNames: [columnDimension], limit: columnLimit ?? DEFAULT_COLUMNS },
    ],
  });

  const table = readReport(report);

  const lines: string[] = [...window.header];
  lines.push(`Rows: ${rowDimension} — Columns: ${columnDimension}`);
  lines.push("");
  lines.push(...renderReport(table));

  return toolText(lines.join("\n"));
}

export default defineGoogleTool(
  FAILURE_CONTEXT,
  { toolName: "ga4_pivot_report", domainOf: () => null },
  handler,
);
