import { z } from "zod";
import { type ToolMetadata, type InferSchema } from "xmcp";
import { auditCrawlability } from "../lib/analyzers/crawlability-analyzer";
import { defineCachedTool } from "../lib/define-tool";
import { domainFromUrl, refreshable } from "../lib/with-cache";
import { toolFailure } from "../lib/tool-failure";
import { toolText } from "../lib/tool-result";

export const schema = {
  ...refreshable,
  url: z.string().url().describe("The URL to audit for crawlability issues"),
};

export const metadata: ToolMetadata = {
  name: "seo_crawlability_audit",
  description:
    "Audit one URL for what stands between it and being indexed: its canonical tag " +
    "(in the HTML and in the Link header), the redirect chain it sits at the end of, " +
    "and the directives that block indexing — including the trap of a noindex on a " +
    "page robots.txt forbids Google to fetch. Needs no credentials and no database.",
  annotations: {
    title: "Audit crawlability",
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: true,
  },
};

/** Completes the sentence "Could not …" for every failure this Tool can return. */
const FAILURE_CONTEXT = "audit crawlability for this URL";

export default defineCachedTool(FAILURE_CONTEXT, { toolName: "seo_crawlability_audit", domainOf: domainFromUrl }, async ({ url }: InferSchema<typeof schema>) => {
  const result = await auditCrawlability(url);

  // The analyzers do not throw; they return a failed Result. Routing that branch
  // through the same seam as a `catch` is the whole point of `tool-failure`.
  if (!result.success) {
    return toolFailure(result.error, FAILURE_CONTEXT);
  }

  const data = result.data;
  const lines: string[] = [];

  const criticalCount = data.issues.filter((i) => i.type === "critical").length;
  const warningCount = data.issues.filter((i) => i.type === "warning").length;

  lines.push("=== CRAWLABILITY AUDIT ===");
  lines.push(`URL: ${data.url}`);
  lines.push(`Critical issues: ${criticalCount}`);
  lines.push(`Warnings: ${warningCount}`);

  // ── Canonical ────────────────────────────────────────────────────────────
  lines.push("");
  lines.push("=== CANONICAL TAGS ===");
  lines.push(`HTML canonical: ${data.canonicalAnalysis.htmlCanonical || "(not set)"}`);
  lines.push(`HTTP header canonical: ${data.canonicalAnalysis.httpCanonical || "(not set)"}`);

  if (data.canonicalAnalysis.conflicts.length > 0) {
    lines.push("");
    lines.push("Canonical conflicts:");
    for (const conflict of data.canonicalAnalysis.conflicts) {
      lines.push(`  - ${conflict.message}`);
    }
  } else {
    lines.push("");
    lines.push("✓ No canonical conflicts");
  }

  // ── Redirects ────────────────────────────────────────────────────────────
  lines.push("");
  lines.push("=== REDIRECT ANALYSIS ===");
  lines.push(`Redirect chain length: ${data.redirectAnalysis.chainLength}`);
  lines.push(`Final URL: ${data.redirectAnalysis.finalUrl}`);

  if (data.redirectAnalysis.redirectChain.length > 1) {
    lines.push("");
    lines.push("Redirect chain:");
    for (const [index, hop] of data.redirectAnalysis.redirectChain.entries()) {
      const isLast = index === data.redirectAnalysis.redirectChain.length - 1;
      lines.push(`  ${index + 1}. [${hop.statusCode}] ${hop.url}${isLast ? "" : " →"}`);
      if (hop.location && !isLast) {
        lines.push(`     Location: ${hop.location}`);
      }
    }
  } else {
    lines.push("✓ No redirects");
  }

  if (data.redirectAnalysis.issues.length > 0) {
    lines.push("");
    lines.push("Redirect issues:");
    for (const issue of data.redirectAnalysis.issues) {
      lines.push(`  - ${issue}`);
    }
  }

  // ── Indexability ─────────────────────────────────────────────────────────
  lines.push("");
  lines.push("=== INDEXABILITY ===");
  lines.push(`Robots meta tag: ${data.indexability.robotsMetaTag || "(not set)"}`);
  lines.push(`X-Robots-Tag header: ${data.indexability.xRobotsTagHeader || "(not set)"}`);
  lines.push(`Blocked from indexing: ${data.indexability.blocked ? "Yes" : "No"}`);

  if (data.indexability.blocked) {
    lines.push("");
    lines.push("Block reasons:");
    for (const reason of data.indexability.blockReasons) {
      lines.push(`  - ${reason}`);
    }
  }

  // ── Every issue, grouped ─────────────────────────────────────────────────
  lines.push("");
  lines.push("=== ISSUES ===");
  if (data.issues.length === 0) {
    lines.push("✓ No crawlability issues detected.");
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
      }
    }
  }

  // ── Recommendations ──────────────────────────────────────────────────────
  lines.push("");
  lines.push("=== RECOMMENDATIONS ===");

  const recommendations: string[] = [];

  if (data.canonicalAnalysis.conflicts.length > 0) {
    recommendations.push("- Fix the canonical conflicts above; the HTML tag and the Link header have to agree.");
  }
  if (!data.canonicalAnalysis.htmlCanonical && !data.canonicalAnalysis.httpCanonical) {
    // Deliberately conditional advice rather than an instruction. Google states a
    // canonical is not required, so telling every page without one to add it
    // would be inventing a defect — the analyzer already files this as info.
    recommendations.push(
      "- If this page is reachable at more than one URL, add a canonical naming the preferred one.",
    );
  }
  if (data.redirectAnalysis.chainLength > 2) {
    recommendations.push("- Shorten the redirect chain: point internal links at the final URL.");
  }
  if (data.indexability.blocked) {
    recommendations.push("- Remove the noindex directive if this page is meant to be indexed.");
  }
  if (data.redirectAnalysis.redirectChain.length > 1) {
    recommendations.push("- Update internal links so visitors do not pay for a redirect.");
  }

  if (recommendations.length === 0) {
    lines.push("✓ Nothing here is standing between this page and being crawled.");
  } else {
    lines.push(...recommendations);
  }

  return toolText(lines.join("\n"));
});
