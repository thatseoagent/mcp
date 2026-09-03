
import { type ToolMetadata, type InferSchema } from "xmcp";
import { defineGoogleTool } from "../lib/define-tool";
import { ga4Property, ga4PropertySchema } from "../lib/google/ga4-tool-shape";
import { toolText } from "../lib/tool-result";
import type { GoogleReader } from "../lib/google/reader";

export const schema = { ...ga4PropertySchema };

export const metadata: ToolMetadata = {
  name: "ga4_custom_definitions",
  description:
    "List only the custom dimensions and metrics defined on this Analytics property — " +
    "the fields somebody set up deliberately, as opposed to GA4's built-in ones. " +
    "These are usually where a business's own vocabulary lives. Needs the Google " +
    "login; without it this Tool says so.",
  annotations: {
    title: "List Analytics custom definitions",
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: true,
  },
};

/** Completes the sentence "Could not …" for every failure this Tool can return. */
const FAILURE_CONTEXT = "list this Analytics property's custom definitions";

export async function handler({ propertyId }: InferSchema<typeof schema>, google: GoogleReader) {
  const { property, header } = ga4Property(propertyId, {
    title: "ANALYTICS CUSTOM DEFINITIONS",
  });
  const found = await google.analytics.getMetadata(property);

  const dimensions = (found.dimensions ?? []).filter((field) => field.customDefinition);
  const metrics = (found.metrics ?? []).filter((field) => field.customDefinition);

  const lines: string[] = [...header];

  if (dimensions.length === 0 && metrics.length === 0) {
    // A real answer, and a common one. Said as a fact rather than as an absence,
    // because "none" here does not mean the property is misconfigured.
    lines.push("");
    lines.push("This property has no custom dimensions or metrics.");
    lines.push("");
    lines.push("That is normal for a standard install: GA4's built-in fields cover most");
    lines.push("reporting. Custom definitions are how a business's own vocabulary — plan tier,");
    lines.push("content type, logged-in state — reaches Analytics, so their absence means those");
    lines.push("questions cannot be answered here, not that anything is broken.");
    return toolText(lines.join("\n"));
  }

  lines.push(`Custom dimensions: ${dimensions.length}`);
  lines.push(`Custom metrics: ${metrics.length}`);

  if (dimensions.length > 0) {
    lines.push("");
    lines.push(`=== CUSTOM DIMENSIONS (${dimensions.length}) ===`);
    for (const field of dimensions) {
      lines.push(`  ${field.apiName ?? "(unnamed)"} — ${field.uiName ?? ""}`.trimEnd());
      if (field.description) lines.push(`    ${field.description}`);
    }
  }

  if (metrics.length > 0) {
    lines.push("");
    lines.push(`=== CUSTOM METRICS (${metrics.length}) ===`);
    for (const field of metrics) {
      lines.push(`  ${field.apiName ?? "(unnamed)"} — ${field.uiName ?? ""}`.trimEnd());
      if (field.description) lines.push(`    ${field.description}`);
    }
  }

  lines.push("");
  lines.push("Pass these API names to ga4_run_report exactly as printed.");

  return toolText(lines.join("\n"));
}

export default defineGoogleTool(
  FAILURE_CONTEXT,
  { toolName: "ga4_custom_definitions", domainOf: () => null },
  handler,
);
