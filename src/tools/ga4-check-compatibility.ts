import { z } from "zod";
import { type ToolMetadata, type InferSchema } from "xmcp";
import { defineGoogleTool } from "../lib/define-tool";
import { refreshable } from "../lib/with-cache";
import { toolText } from "../lib/tool-result";
import { DEFAULT_END, DEFAULT_START } from "./ga4-run-report";
import type { GoogleReader } from "../lib/google/reader";

export const schema = {
  ...refreshable,
  propertyId: z.string().describe("The GA4 property: `123456789` or `properties/123456789`."),
  metrics: z.array(z.string()).describe("The metric API names you want to report together."),
  dimensions: z
    .array(z.string())
    .optional()
    .describe("The dimension API names you want to report together."),
};

export const metadata: ToolMetadata = {
  name: "ga4_check_compatibility",
  description:
    "Ask Analytics whether a set of dimensions and metrics can be reported together " +
    "before running the report. GA4 refuses some combinations outright — a scope " +
    "mismatch between a user-scoped dimension and an event-scoped metric, for " +
    "instance — and this says which field is the problem rather than leaving you with " +
    "a rejected report. Needs the Google login; without it this Tool says so.",
  annotations: {
    title: "Check an Analytics combination",
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: true,
  },
};

/** Completes the sentence "Could not …" for every failure this Tool can return. */
const FAILURE_CONTEXT = "check whether these Analytics fields can be combined";

/** Google's own verdict, translated into what the caller should do. */
const VERDICTS: Record<string, string> = {
  COMPATIBLE: "can be used with the rest of this combination",
  INCOMPATIBLE: "cannot — drop it, or drop what conflicts with it",
};

export async function handler(
  { propertyId, metrics, dimensions }: InferSchema<typeof schema>,
  google: GoogleReader,
) {
  const result = await google.analytics.checkCompatibility({
    property: propertyId,
    // The API wants a report-shaped request. The dates are irrelevant to the
    // answer — compatibility is a property of the field combination, not of the
    // window — so the ordinary defaults are used rather than asking the caller
    // for dates that change nothing.
    dateRanges: [{ startDate: DEFAULT_START, endDate: DEFAULT_END }],
    metrics,
    dimensions,
  });

  const dimensionVerdicts = result.dimensionCompatibilities ?? [];
  const metricVerdicts = result.metricCompatibilities ?? [];

  const incompatible = [
    ...dimensionVerdicts
      .filter((entry) => entry.compatibility === "INCOMPATIBLE")
      .map((entry) => entry.dimensionMetadata?.apiName ?? "(unnamed dimension)"),
    ...metricVerdicts
      .filter((entry) => entry.compatibility === "INCOMPATIBLE")
      .map((entry) => entry.metricMetadata?.apiName ?? "(unnamed metric)"),
  ];

  const lines: string[] = ["=== ANALYTICS COMPATIBILITY ==="];
  lines.push(`Property: ${propertyId}`);
  lines.push(`Metrics asked about: ${metrics.join(", ")}`);
  if (dimensions && dimensions.length > 0) {
    lines.push(`Dimensions asked about: ${dimensions.join(", ")}`);
  }

  lines.push("");
  if (incompatible.length === 0) {
    lines.push("This combination is reportable. Every field GA4 was asked about works with the");
    lines.push("others, so ga4_run_report will accept it.");
  } else {
    lines.push(`GA4 will refuse this combination because of: ${incompatible.join(", ")}.`);
    lines.push("");
    lines.push("This is a scope conflict rather than a missing field: GA4 will not report a");
    lines.push("user-scoped dimension alongside an event-scoped metric, and similar pairs.");
    lines.push("Drop one side, or run two reports.");
  }

  const detail = (
    heading: string,
    entries: Array<{ name: string; compatibility?: string }>,
  ): string[] => {
    if (entries.length === 0) return [];
    const out = ["", `=== ${heading} ===`];
    for (const entry of entries) {
      const verdict = entry.compatibility ?? "not reported";
      out.push(`  ${entry.name}: ${verdict}${VERDICTS[verdict] ? ` — ${VERDICTS[verdict]}` : ""}`);
    }
    return out;
  };

  lines.push(
    ...detail(
      "DIMENSIONS",
      dimensionVerdicts.map((entry) => ({
        name: entry.dimensionMetadata?.apiName ?? "(unnamed)",
        compatibility: entry.compatibility,
      })),
    ),
  );
  lines.push(
    ...detail(
      "METRICS",
      metricVerdicts.map((entry) => ({
        name: entry.metricMetadata?.apiName ?? "(unnamed)",
        compatibility: entry.compatibility,
      })),
    ),
  );

  return toolText(lines.join("\n"));
}

export default defineGoogleTool(
  FAILURE_CONTEXT,
  { toolName: "ga4_check_compatibility", domainOf: () => null },
  handler,
);
