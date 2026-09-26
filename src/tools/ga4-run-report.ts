import { z } from "zod";
import { type ToolMetadata, type InferSchema } from "xmcp";
import { defineGoogleTool } from "../lib/define-tool";
import { toolText } from "../lib/tool-result";
import { quotaNotes, readReport, renderReport, reportBasis } from "../lib/google/ga4-report";
import { basisSection } from "../lib/render-basis";
import { ga4Window, ga4WindowSchema } from "../lib/google/ga4-tool-shape";
import type { GoogleReader } from "../lib/google/reader";

export const schema = {
  ...ga4WindowSchema,
  metrics: z
    .array(z.string())
    .describe("GA4 metric API names, e.g. ['sessions','totalUsers','keyEvents']"),
  dimensions: z
    .array(z.string())
    .optional()
    .describe("GA4 dimension API names, e.g. ['sessionDefaultChannelGroup','landingPage']"),
  limit: z.number().int().optional().describe("How many rows to return. Default 50."),
  offset: z.number().int().optional().describe("Rows to skip, for paging through a long report."),
};

export const metadata: ToolMetadata = {
  name: "ga4_run_report",
  description:
    "Run any Google Analytics report: pick metrics and dimensions and get the rows " +
    "back. Says when a report was truncated or thresholded, so a partial answer is " +
    "never presented as a complete one. Use ga4_metadata to discover what this " +
    "property supports. Needs the Google login; without it this Tool says so.",
  annotations: {
    title: "Run an Analytics report",
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: true,
  },
};

/** Completes the sentence "Could not …" for every failure this Tool can return. */
const FAILURE_CONTEXT = "run this Analytics report";

/** How many rows to ask for when the caller does not say. */
const DEFAULT_LIMIT = 50;

export async function handler(
  { propertyId, metrics, dimensions, startDate, endDate, limit, offset }: InferSchema<typeof schema>,
  google: GoogleReader,
) {
  const window = ga4Window({ propertyId, startDate, endDate }, { title: "ANALYTICS REPORT" });

  const report = await google.analytics.runReport({
    property: window.property,
    dateRanges: [window.dateRange],
    metrics,
    dimensions,
    limit: limit ?? DEFAULT_LIMIT,
    offset,
    // Free to ask for, and the only way to warn before Google starts refusing:
    // this is the Tool an agent calls in a loop. `quotaNotes` stays silent
    // unless the property is close to its limit.
    returnPropertyQuota: true,
    // The totals line under the table is the one figure a truncated report can
    // still be read by, and Google fills `totals` only when asked. Nothing asked,
    // so the line was never printed and the "use the totals line" caveat pointed
    // at nothing.
    metricAggregations: ["TOTAL"],
  });

  const table = readReport(report);

  const lines: string[] = [...window.header];
  lines.push("");
  lines.push(...renderReport(table));

  const quota = quotaNotes(report.propertyQuota);
  if (quota.length > 0) lines.push("", ...quota);

  lines.push(...basisSection(reportBasis(table)));

  return toolText(lines.join("\n"));
}

export default defineGoogleTool(
  FAILURE_CONTEXT,
  { toolName: "ga4_run_report", domainOf: () => null },
  handler,
);
