import { z } from "zod";
import { type ToolMetadata, type InferSchema } from "xmcp";
import { defineGoogleTool } from "../lib/define-tool";
import { toolText } from "../lib/tool-result";
import { readReport, renderReport } from "../lib/google/ga4-report";
import { ga4Window, ga4WindowSchema } from "../lib/google/ga4-tool-shape";
import type { GoogleReader } from "../lib/google/reader";

export const schema = { ...ga4WindowSchema };

export const metadata: ToolMetadata = {
  name: "ga4_key_events",
  description:
    "What is converting: every key event on this Analytics property with its count, " +
    "and where those events came from. Key events are what GA4 calls conversions " +
    "since 2024 — an event only appears here if somebody marked it as one. Needs the " +
    "Google login; without it this Tool says so.",
  annotations: {
    title: "Read Analytics key events",
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: true,
  },
};

/** Completes the sentence "Could not …" for every failure this Tool can return. */
const FAILURE_CONTEXT = "read this Analytics property's key events";

export async function handler(
  { propertyId, startDate, endDate }: InferSchema<typeof schema>,
  google: GoogleReader,
) {
  const window = ga4Window({ propertyId, startDate, endDate }, {
    title: "ANALYTICS KEY EVENTS",
  });

  // `keyEvents` by `eventName`, which is the only breakdown that answers "what
  // is converting". `conversions` was the pre-2024 name for the same metric and
  // is not asked for: a property that has one has the other.
  const byEvent = await google.analytics.runReport({
    property: window.property,
    dateRanges: [window.dateRange],
    dimensions: ["eventName"],
    metrics: ["keyEvents", "eventCount"],
    orderBys: [{ metric: { metricName: "keyEvents" }, desc: true }],
    limit: 50,
  });

  const table = readReport(byEvent);
  // Only the rows that are actually key events. GA4 returns every event name
  // with a `keyEvents` of zero for the ones nobody marked, and printing those
  // under a "key events" heading would suggest the site has fifty conversions
  // that are all failing.
  const converting = table.rows.filter((row) => (row.metrics[0] ?? 0) > 0);

  const lines: string[] = [...window.header];

  for (const caveat of table.caveats) {
    lines.push("");
    lines.push(`Note: ${caveat}`);
  }

  lines.push("");
  if (converting.length === 0) {
    lines.push("No key events were recorded in this window.");
    lines.push("");
    lines.push("Two very different causes, and this report cannot tell them apart: either");
    lines.push("nothing converted, or no event on this property has been marked as a key event.");
    lines.push("Check Admin > Events in Analytics — an unmarked event still collects data, it");
    lines.push("just does not count as a conversion, so the fix is a toggle rather than tracking");
    lines.push("work. The full event list below shows what is being collected either way.");
    lines.push("");
    lines.push(...renderReport(table));
    return toolText(lines.join("\n"));
  }

  lines.push(`Key events with activity: ${converting.length}`);
  lines.push("");
  lines.push("event | key events | total events");
  lines.push("-".repeat(40));
  for (const row of converting) {
    lines.push(`${row.dimensions[0]} | ${row.metrics[0]} | ${row.metrics[1] ?? 0}`);
  }

  const total = converting.reduce((sum, row) => sum + (row.metrics[0] ?? 0), 0);
  lines.push("");
  lines.push(`Total key events across these: ${total}`);

  return toolText(lines.join("\n"));
}

export default defineGoogleTool(
  FAILURE_CONTEXT,
  { toolName: "ga4_key_events", domainOf: () => null },
  handler,
);
