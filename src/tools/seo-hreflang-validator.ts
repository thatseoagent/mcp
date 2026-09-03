import { z } from "zod";
import { type ToolMetadata, type InferSchema } from "xmcp";
import { validateHreflang } from "../lib/analyzers/hreflang-analyzer";
import { getLanguageName } from "../lib/language-validator";
import { defineCachedTool } from "../lib/define-tool";
import { domainFromUrl, refreshable } from "../lib/with-cache";
import { toolFailure } from "../lib/tool-failure";
import { toolText } from "../lib/tool-result";

export const schema = {
  ...refreshable,
  url: z.string().url().describe("The URL to validate hreflang tags for"),
  checkBidirectional: z
    .boolean()
    .optional()
    .describe(
      "Validate bidirectional links (referenced pages link back). Default: true. Slower but thorough.",
    ),
  checkAccessibility: z
    .boolean()
    .optional()
    .describe("Check whether all hreflang URLs are reachable. Default: true."),
  sitemapUrl: z
    .string()
    .url()
    .optional()
    .describe("Optional sitemap URL, to also read hreflang annotations declared there"),
};

export const metadata: ToolMetadata = {
  name: "seo_hreflang_validator",
  description:
    "Validate a page's hreflang setup, wherever it is declared: HTML link tags, the " +
    "HTTP Link header, and optionally a sitemap. Checks the self-reference, the " +
    "language and region codes, x-default, whether the alternates answer, and whether " +
    "they link back. Needs no credentials and no database.",
  annotations: {
    title: "Validate hreflang",
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: true,
  },
};

/** Completes the sentence "Could not …" for every failure this Tool can return. */
const FAILURE_CONTEXT = "validate the hreflang setup for this URL";

export default defineCachedTool(
  FAILURE_CONTEXT,
  { toolName: "seo_hreflang_validator", domainOf: domainFromUrl },
  async ({
    url,
    checkBidirectional,
    checkAccessibility,
    sitemapUrl,
  }: InferSchema<typeof schema>) => {
    const result = await validateHreflang(url, {
      checkBidirectional,
      checkAccessibility,
      sitemapUrl,
    });

    if (!result.success) {
      return toolFailure(result.error, FAILURE_CONTEXT);
    }

    const data = result.data;
    const lines: string[] = [];

    lines.push("=== HREFLANG VALIDATION ===");
    lines.push(`URL: ${data.url}`);
    lines.push(`Total hreflang tags: ${data.hreflangTags.length}`);

    const criticalCount = data.issues.filter((i) => i.type === "critical").length;
    const warningCount = data.issues.filter((i) => i.type === "warning").length;
    lines.push(`Critical issues: ${criticalCount}`);
    lines.push(`Warnings: ${warningCount}`);

    lines.push("");
    lines.push("=== VALIDATION STATUS ===");
    lines.push(`Self-referencing present: ${data.validation.selfReferencingPresent ? "✓" : "✗"}`);
    lines.push(`Language codes valid: ${data.validation.languageCodesValid ? "✓" : "✗"}`);
    // Three marks, matching what `renderVerdict` settled for the scoring Tools:
    // `?` for a question nobody answered, never the cross that says "no".
    lines.push(
      data.validation.urlsAccessibleStatus === "not-evaluated"
        ? "URLs accessible: ? (not checked)"
        : `URLs accessible: ${data.validation.urlsAccessible ? "✓" : "✗"}` +
          (data.validation.urlsUnchecked
            ? ` (${data.validation.urlsUnchecked} did not answer)`
            : ""),
    );
    lines.push(`Has x-default: ${data.validation.hasXDefault ? "✓" : "✗"}`);

    lines.push("");
    lines.push("=== HREFLANG TAGS ===");
    if (data.hreflangTags.length === 0) {
      lines.push("No hreflang tags found.");
    } else {
      for (const [heading, source] of [
        ["From HTML <link> tags:", "html"],
        ["From HTTP Link header:", "http-header"],
        ["From sitemap:", "sitemap"],
      ] as const) {
        const tags = data.hreflangTags.filter((t) => t.source === source);
        if (tags.length === 0) continue;
        lines.push("");
        lines.push(heading);
        for (const tag of tags) {
          lines.push(`  - ${getLanguageName(tag.lang)} (${tag.lang}): ${tag.href}`);
        }
      }
    }

    lines.push("");
    lines.push("=== ISSUES ===");
    if (data.issues.length === 0) {
      lines.push("✓ No hreflang issues detected.");
    } else {
      for (const [label, severity] of [
        ["CRITICAL", "critical"],
        ["WARNINGS", "warning"],
        ["INFO", "info"],
      ] as const) {
        const group = data.issues.filter((i) => i.type === severity);
        if (group.length === 0) continue;
        lines.push("");
        lines.push(`${label}:`);
        for (const issue of group) {
          lines.push(`  - [${issue.category}] ${issue.message}`);
          if (issue.affectedUrl) lines.push(`    Affected URL: ${issue.affectedUrl}`);
        }
      }
    }

    lines.push("");
    lines.push("=== RECOMMENDATIONS ===");
    lines.push(...data.recommendations);

    lines.push("");
    lines.push("=== HREFLANG BEST PRACTICES ===");
    lines.push("1. Self-reference: every page must include a self-referencing hreflang tag");
    lines.push("2. x-default: add x-default as the fallback for unmatched languages");
    lines.push("3. Bidirectional: if page A links to page B, page B must link back to A");
    lines.push("4. Language codes: ISO 639-1 language, optionally ISO 15924 script and ISO 3166-1 region");
    lines.push("   - Correct: en, en-US, en-GB, fr-CA, zh-Hant-TW");
    lines.push("   - Incorrect: en_US, eng, EN-us");
    lines.push("5. Consistency: use the same implementation across every page");
    lines.push("6. Absolute URLs: always absolute, never relative");
    lines.push("7. Accessibility: every hreflang URL has to answer");

    lines.push("");
    lines.push("=== IMPLEMENTATION EXAMPLE ===");
    lines.push("HTML (in <head>):");
    lines.push('  <link rel="alternate" hreflang="en" href="https://example.com/page" />');
    lines.push('  <link rel="alternate" hreflang="fr" href="https://example.com/fr/page" />');
    lines.push('  <link rel="alternate" hreflang="es" href="https://example.com/es/page" />');
    lines.push('  <link rel="alternate" hreflang="x-default" href="https://example.com/page" />');
    lines.push("");
    lines.push("HTTP header:");
    lines.push('  Link: <https://example.com/page>; rel="alternate"; hreflang="en",');
    lines.push('        <https://example.com/fr/page>; rel="alternate"; hreflang="fr"');

    lines.push("");
    lines.push("=== TESTING TOOLS ===");
    lines.push("- Google Search Console: International Targeting report");
    lines.push("- Aleyda Solis' hreflang generator: https://www.aleydasolis.com/english/international-seo-tools/hreflang-tags-generator/");
    lines.push("- Merkle hreflang tester: https://technicalseo.com/tools/hreflang/");

    return toolText(lines.join("\n"));
  },
);
