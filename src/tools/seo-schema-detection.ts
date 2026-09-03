import { z } from "zod";
import { type ToolMetadata, type InferSchema } from "xmcp";
import { detectSchemas, expectedSchemas } from "../lib/analyzers/schema-analyzer";
import { pageKindLabel } from "../lib/analyzers/page-identity";
import { defineCachedTool } from "../lib/define-tool";
import { domainFromUrl, refreshable } from "../lib/with-cache";
import { unwrap } from "../lib/type-guards";
import { toolText } from "../lib/tool-result";

export const schema = {
  ...refreshable,
  url: z.string().url().describe("The URL to analyze for structured data"),
};

export const metadata: ToolMetadata = {
  name: "seo_schema_detection",
  description:
    "Read the structured data a page publishes — JSON-LD, microdata and RDFa — " +
    "validate each payload, and say which schema types this kind of page owes and " +
    "which of them are missing. Also reports schema whose claims the rendered page " +
    "does not back up. Needs no credentials and no database. Returns an error " +
    "naming the status if the page cannot be read.",
  annotations: {
    title: "Detect structured data",
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: true,
  },
};

/** Completes the sentence "Could not …" for every failure this Tool can return. */
const FAILURE_CONTEXT = "detect structured data on this URL";

/** Render one detected payload's type, verdict and complaints. */
function renderValidation(
  lines: string[],
  index: number,
  type: string,
  validation: { valid: boolean; errors: string[]; warnings: string[] },
): void {
  lines.push(`\n[${index + 1}] Type: ${type}`);
  lines.push(`Valid: ${validation.valid ? "✓" : "✗"}`);

  if (validation.errors.length > 0) {
    lines.push("Errors:");
    for (const error of validation.errors) lines.push(`  - ${error}`);
  }

  if (validation.warnings.length > 0) {
    lines.push("Warnings:");
    for (const warning of validation.warnings) lines.push(`  - ${warning}`);
  }
}

function renderProperties(lines: string[], properties: Record<string, unknown>): void {
  lines.push("Properties:");
  for (const [key, value] of Object.entries(properties)) {
    lines.push(`  ${key}: ${Array.isArray(value) ? value.join(", ") : String(value)}`);
  }
}

export default defineCachedTool(FAILURE_CONTEXT, { toolName: "seo_schema_detection", domainOf: domainFromUrl }, async ({ url }: InferSchema<typeof schema>) => {
  const data = unwrap(await detectSchemas(url));
  const lines: string[] = [];

  lines.push("=== SUMMARY ===");
  lines.push(`Total schemas found: ${data.summary.totalSchemas}`);
  lines.push(`Valid schemas: ${data.summary.validSchemas}`);
  lines.push(`Invalid schemas: ${data.summary.invalidSchemas}`);
  lines.push(`Formats detected: ${data.summary.formats.join(", ") || "none"}`);
  lines.push(`Schema types: ${data.summary.schemaTypes.join(", ") || "none"}`);

  if (data.jsonLd.length > 0) {
    lines.push("\n=== JSON-LD SCHEMAS ===");
    for (const [index, found] of data.jsonLd.entries()) {
      renderValidation(lines, index, found.type, found.validation);
      if (found.type !== "Invalid") {
        lines.push("Schema content:");
        lines.push(JSON.stringify(found.raw, null, 2));
      }
    }
  }

  if (data.microdata.length > 0) {
    lines.push("\n=== MICRODATA SCHEMAS ===");
    for (const [index, found] of data.microdata.entries()) {
      renderValidation(lines, index, found.type, found.validation);
      renderProperties(lines, found.properties);
    }
  }

  if (data.rdfa.length > 0) {
    lines.push("\n=== RDFA SCHEMAS ===");
    for (const [index, found] of data.rdfa.entries()) {
      renderValidation(lines, index, found.type, found.validation);
      renderProperties(lines, found.properties);
    }
  }

  lines.push("\n=== ISSUES & RECOMMENDATIONS ===");
  if (data.issues.length === 0) {
    lines.push("No major issues detected.");
  } else {
    for (const issue of data.issues) lines.push(`- ${issue}`);
  }

  if (data.summary.totalSchemas === 0) {
    lines.push("\nRecommendations:");
    lines.push("- Add Organization schema with name, logo, and contact info");
    lines.push("- Add WebSite schema with name, url, and potentialAction");
    lines.push("- Consider BreadcrumbList for navigation");
    lines.push("- Use JSON-LD format (easiest to implement and maintain)");
  } else if (
    data.summary.formats.includes("microdata") ||
    data.summary.formats.includes("rdfa")
  ) {
    lines.push("\nRecommendations:");
    lines.push("- Consider migrating to JSON-LD format for better compatibility");
  }

  // ── The stack this page type owes ─────────────────────────────────────────
  //
  // Derived from what the page IS. The retired fixed list (Article +
  // Organization + BreadcrumbList) was applied to every URL, so auditing a
  // homepage reported "Missing: Article, BreadcrumbList" — a trail of ancestors
  // for a page with none, and a byline for a page that is not an article. Acting
  // on that advice means publishing schema that misdescribes the page, which is
  // what the mismatch section below exists to catch.
  const { required, exempt } = expectedSchemas(data.identity);
  const detectedTypes = new Set(data.summary.schemaTypes);
  const present: string[] = [];
  const missing: { label: string; because: string }[] = [];
  for (const requirement of required) {
    if (requirement.types.some((type) => detectedTypes.has(type))) {
      present.push(requirement.label);
    } else {
      missing.push({ label: requirement.label, because: requirement.because });
    }
  }
  const kindLabel = pageKindLabel(data.identity.kind);

  lines.push("\n=== SCHEMA STACK FOR THIS PAGE TYPE ===");
  lines.push(`Page identified as: ${kindLabel} (${data.identity.signals.join("; ")})`);
  lines.push(`Expected here: ${required.map((requirement) => requirement.label).join(", ")}`);
  if (missing.length === 0) {
    lines.push(`✓ Complete for a ${kindLabel.toLowerCase()}`);
  } else {
    for (const { label, because } of missing) {
      lines.push(`✗ Missing ${label} — ${because}`);
    }
  }
  lines.push(`  Present: ${present.length > 0 ? present.join(", ") : "none"}`);
  if (exempt.length > 0) {
    lines.push("  Not applicable to this page type:");
    for (const entry of exempt) lines.push(`    ${entry.label} — ${entry.because}`);
  }
  if (detectedTypes.has("FAQPage")) {
    lines.push(
      "  Note: FAQPage detected — Google deprecated FAQ rich results on May 7, 2026 " +
        "(only gov/health sites still get them). Keep schema only if it honestly " +
        "describes the page.",
    );
  }

  if (data.mismatches.length > 0) {
    lines.push("\n=== SCHEMA-CONTENT MISMATCH ===");
    lines.push(
      "Schema should honestly describe the page. The following types are present in " +
        "JSON-LD but the rendered DOM does not back them up:",
    );
    for (const mismatch of data.mismatches) {
      lines.push(`${mismatch.severity === "warning" ? "⚠" : "ℹ"} ${mismatch.type}: ${mismatch.message}`);
      lines.push(`  → ${mismatch.recommendation}`);
    }
  }

  return toolText(lines.join("\n"));
});
