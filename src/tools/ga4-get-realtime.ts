import { z } from "zod";
import { type ToolMetadata, type InferSchema } from "xmcp";
import { defineGoogleTool } from "../lib/define-tool";
import { refreshable } from "../lib/with-cache";
import { toolText } from "../lib/tool-result";
import { readReport, renderReport } from "../lib/google/ga4-report";
import type { GoogleReader } from "../lib/google/reader";

export const schema = {
  ...refreshable,
  propertyId: z.string().describe("The GA4 property: `123456789` or `properties/123456789`."),
  dimensions: z
    .array(z.string())
    .optional()
    .describe("Realtime dimensions, e.g. ['unifiedScreenName','country']. Default: page."),
  metrics: z
    .array(z.string())
    .optional()
    .describe("Realtime metrics. Default: ['activeUsers']."),
  limit: z.number().int().optional().describe("How many rows. Default 20."),
};

export const metadata: ToolMetadata = {
  name: "ga4_get_realtime",
  description:
    "Who is on the site right now, from Analytics' realtime report — active users by " +
    "page or country over the last 30 minutes. Realtime is a different dataset from " +
    "the reporting one and supports far fewer dimensions and metrics; it answers 'is " +
    "anything happening', not 'what happened'. Needs the Google login; without it " +
    "this Tool says so.",
  annotations: {
    title: "Read Analytics realtime",
    readOnlyHint: true,
    destructiveHint: false,
    // Genuinely not idempotent: the answer is about this minute.
    idempotentHint: false,
    openWorldHint: true,
  },
};

/** Completes the sentence "Could not …" for every failure this Tool can return. */
const FAILURE_CONTEXT = "read the Analytics realtime report";

export async function handler(
  { propertyId, dimensions, metrics, limit }: InferSchema<typeof schema>,
  google: GoogleReader,
) {
  const report = await google.analytics.runRealtimeReport({
    property: propertyId,
    dimensions: dimensions ?? ["unifiedScreenName"],
    metrics: metrics ?? ["activeUsers"],
    limit: limit ?? 20,
  });

  const table = readReport(report);

  const lines: string[] = ["=== ANALYTICS REALTIME ==="];
  lines.push(`Property: ${propertyId}`);
  lines.push("Window: the last 30 minutes, which is all realtime covers.");
  lines.push("");
  lines.push(...renderReport(table));

  lines.push("");
  lines.push("=== NOTE ===");
  lines.push("Realtime is a separate dataset with its own, much smaller, set of dimensions and");
  lines.push("metrics. Its numbers will not add up to the reporting API's for the same period,");
  lines.push("and that is expected rather than a discrepancy to chase.");

  return toolText(lines.join("\n"));
}

export default defineGoogleTool(
  FAILURE_CONTEXT,
  {
    toolName: "ga4_get_realtime",
    domainOf: () => null,
    // Half a minute. A realtime report cached for an hour is not a realtime
    // report, and caching it for nothing at all would let an agent polling in a
    // loop spend the property's quota.
    ttlMs: 30_000,
  },
  handler,
);
