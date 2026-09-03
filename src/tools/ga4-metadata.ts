import { z } from "zod";
import { type ToolMetadata, type InferSchema } from "xmcp";
import { defineGoogleTool } from "../lib/define-tool";
import { ga4Property, ga4PropertySchema } from "../lib/google/ga4-tool-shape";
import { toolText } from "../lib/tool-result";
import type { GoogleReader } from "../lib/google/reader";

export const schema = {
  ...ga4PropertySchema,
  search: z
    .string()
    .optional()
    .describe("Only show dimensions and metrics whose name or description matches this."),
};

export const metadata: ToolMetadata = {
  name: "ga4_metadata",
  description:
    "List the dimensions and metrics this Analytics property supports, including the " +
    "custom ones defined for it. Use this before ga4_run_report to find the right API " +
    "names — GA4 rejects a report naming a field the property does not have. Needs " +
    "the Google login; without it this Tool says so.",
  annotations: {
    title: "List Analytics dimensions and metrics",
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: true,
  },
};

/** Completes the sentence "Could not …" for every failure this Tool can return. */
const FAILURE_CONTEXT = "read this Analytics property's metadata";

/**
 * How many to list per section when nothing was searched for.
 *
 * GA4 publishes several hundred dimensions and metrics. Printing all of them
 * crosses the wire into a model's context and buries the ones the caller needs,
 * so an unfiltered call is capped and says so; a search is not, because a search
 * that hid matches would be worse than useless.
 */
const MAX_UNFILTERED = 40;

interface Field {
  apiName?: string;
  uiName?: string;
  description?: string;
  customDefinition?: boolean;
}

function matches(field: Field, search: string): boolean {
  const needle = search.toLowerCase();
  return [field.apiName, field.uiName, field.description].some((value) =>
    value?.toLowerCase().includes(needle),
  );
}

function renderFields(heading: string, fields: Field[], search: string | undefined): string[] {
  const chosen = search ? fields.filter((field) => matches(field, search)) : fields;
  const shown = search ? chosen : chosen.slice(0, MAX_UNFILTERED);

  const lines = ["", `=== ${heading} (${chosen.length}) ===`];
  if (chosen.length === 0) {
    lines.push(search ? `Nothing matches "${search}".` : "This property reports none.");
    return lines;
  }

  for (const field of shown) {
    const custom = field.customDefinition ? "  [custom]" : "";
    lines.push(`  ${field.apiName ?? "(unnamed)"} — ${field.uiName ?? ""}${custom}`.trimEnd());
  }
  if (shown.length < chosen.length) {
    lines.push(
      `  ... and ${chosen.length - shown.length} more. Pass \`search\` to narrow this down.`,
    );
  }
  return lines;
}

export async function handler(
  { propertyId, search }: InferSchema<typeof schema>,
  google: GoogleReader,
) {
  const { property, header } = ga4Property(propertyId, { title: "ANALYTICS METADATA" });
  const found = await google.analytics.getMetadata(property);

  const lines: string[] = [...header];
  if (search) lines.push(`Filtered by: "${search}"`);

  lines.push(...renderFields("DIMENSIONS", found.dimensions ?? [], search));
  lines.push(...renderFields("METRICS", found.metrics ?? [], search));

  lines.push("");
  lines.push("=== NOTE ===");
  lines.push("Fields marked [custom] exist only on this property. Not every pair of these can");
  lines.push("be reported together — ga4_check_compatibility answers that before you spend a");
  lines.push("report on a combination GA4 will reject.");

  return toolText(lines.join("\n"));
}

export default defineGoogleTool(
  FAILURE_CONTEXT,
  { toolName: "ga4_metadata", domainOf: () => null },
  handler,
);
