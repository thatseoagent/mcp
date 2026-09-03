import { z } from "zod";
import { type ToolMetadata, type InferSchema } from "xmcp";
import { defineGoogleTool } from "../lib/define-tool";
import { refreshable } from "../lib/with-cache";
import { toolText } from "../lib/tool-result";
import { readReport, renderReport } from "../lib/google/ga4-report";
import type { GoogleReader } from "../lib/google/reader";

/**
 * The date range every GA4 Tool defaults to, in GA4's own relative form.
 *
 * `NdaysAgo` and `yesterday` rather than dates computed here, and the reason is
 * a bug worth not repeating: computed dates come from `new Date()`, which is
 * UTC, while GA4 resolves a range in the **property's** reporting timezone. For
 * anyone west of Greenwich the window was off by a day.
 *
 * Ending at `yesterday` rather than `today` because Google processes a day's
 * data over the following 24 to 48 hours, so today is always a partial day being
 * compared against whole ones.
 */
export const DEFAULT_START = "28daysAgo";
export const DEFAULT_END = "yesterday";

export const schema = {
  ...refreshable,
  propertyId: z
    .string()
    .describe("The GA4 property: `123456789` or `properties/123456789`. Both work."),
  metrics: z
    .array(z.string())
    .describe("GA4 metric API names, e.g. ['sessions','totalUsers','keyEvents']"),
  dimensions: z
    .array(z.string())
    .optional()
    .describe("GA4 dimension API names, e.g. ['sessionDefaultChannelGroup','landingPage']"),
  startDate: z
    .string()
    .optional()
    .describe(`YYYY-MM-DD or a GA4 relative date like '28daysAgo'. Default ${DEFAULT_START}.`),
  endDate: z
    .string()
    .optional()
    .describe(`YYYY-MM-DD or 'yesterday'/'today'. Default ${DEFAULT_END}.`),
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
  const range = { startDate: startDate ?? DEFAULT_START, endDate: endDate ?? DEFAULT_END };

  const report = await google.analytics.runReport({
    property: propertyId,
    dateRanges: [range],
    metrics,
    dimensions,
    limit: limit ?? DEFAULT_LIMIT,
    offset,
  });

  const table = readReport(report);

  const lines: string[] = ["=== ANALYTICS REPORT ==="];
  lines.push(`Property: ${propertyId}`);
  lines.push(`Window: ${range.startDate} to ${range.endDate}`);
  if (!startDate && !endDate) {
    lines.push(
      "The window ends yesterday: Google processes a day's data over the following 24 to 48",
      "hours, so today is always a partial day being compared against whole ones.",
    );
  }
  lines.push("");
  lines.push(...renderReport(table));

  return toolText(lines.join("\n"));
}

export default defineGoogleTool(
  FAILURE_CONTEXT,
  { toolName: "ga4_run_report", domainOf: () => null },
  handler,
);
