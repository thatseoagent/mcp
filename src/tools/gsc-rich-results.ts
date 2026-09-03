import { type ToolMetadata, type InferSchema } from "xmcp";
import { defineGoogleTool } from "../lib/define-tool";
import { refreshable } from "../lib/with-cache";
import { toolText } from "../lib/tool-result";
import { z } from "zod";
import { resolveSiteUrl } from "../lib/google/property";
import { resolveWindow } from "../lib/google/gsc-dates";
import { inspectBusiestPages, whatWasSampled } from "../lib/google/inspected-sample";
import type { GoogleReader } from "../lib/google/reader";

export const schema = {
  ...refreshable,
  siteUrl: z.string().describe("The Search Console property, or just the domain."),
  days: z.number().int().optional().describe("Window used to pick the busiest pages. Default 28."),
};

export const metadata: ToolMetadata = {
  name: "gsc_rich_results",
  description:
    "Which rich results Google has actually detected on the site's busiest pages, and " +
    "which pages it found none on. This is Google's own answer, as opposed to what the " +
    "markup on the page claims — seo_schema_detection covers that side. Needs the " +
    "Google login; without it this Tool says so.",
  annotations: {
    title: "Check rich results Google detected",
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: false,
    openWorldHint: true,
  },
};

/** Completes the sentence "Could not …" for every failure this Tool can return. */
const FAILURE_CONTEXT = "check the rich results Google detected on this site";

export async function handler(
  { siteUrl, days }: InferSchema<typeof schema>,
  google: GoogleReader,
) {
  const property = await resolveSiteUrl(google.searchConsole, siteUrl);
  const window = resolveWindow({ days: days ?? 28 });
  const sample = await inspectBusiestPages(google.searchConsole, property, window);

  const answered = sample.inspected.filter((entry) => entry.ok);
  const withTypes = answered.filter((entry) => entry.ok && entry.summary.richResultTypes.length > 0);
  const without = answered.filter((entry) => entry.ok && entry.summary.richResultTypes.length === 0);

  const lines: string[] = ["=== RICH RESULTS ==="];
  lines.push(`Property: ${property}`);
  lines.push("");
  lines.push(`Pages with rich results detected: ${withTypes.length} of ${answered.length}`);

  const byType = new Map<string, string[]>();
  for (const entry of withTypes) {
    if (!entry.ok) continue;
    for (const type of entry.summary.richResultTypes) {
      byType.set(type, [...(byType.get(type) ?? []), entry.url]);
    }
  }

  if (byType.size > 0) {
    lines.push("");
    lines.push("=== BY TYPE ===");
    for (const [type, urls] of [...byType.entries()].sort((a, b) => b[1].length - a[1].length)) {
      lines.push(`${type} — ${urls.length} page(s)`);
      for (const url of urls.slice(0, 5)) lines.push(`  ${url}`);
      if (urls.length > 5) lines.push(`  ... and ${urls.length - 5} more`);
    }
  }

  // Verdicts kept separate from detection: a page can have a type detected *and*
  // a verdict that is not PASS, which means the markup is there and Google will
  // not use it — the most actionable state and the easiest to miss.
  const failing = answered.filter(
    (entry) => entry.ok && entry.summary.richResultsVerdict !== null && entry.summary.richResultsVerdict !== "PASS",
  );
  if (failing.length > 0) {
    lines.push("");
    lines.push(`=== DETECTED BUT NOT USABLE (${failing.length}) ===`);
    lines.push("Google found markup on these and will not show a rich result from it. Run the");
    lines.push("URL through Google's Rich Results Test to see which field it objected to.");
    for (const entry of failing) {
      if (!entry.ok) continue;
      lines.push(`  ${entry.url} — verdict ${entry.summary.richResultsVerdict}`);
    }
  }

  if (without.length > 0) {
    lines.push("");
    lines.push(`=== NOTHING DETECTED (${without.length}) ===`);
    lines.push("Not a fault. Most pages do not qualify for a rich result and do not need to —");
    lines.push("there is no rich result for an ordinary article or a homepage. It is worth a");
    lines.push("look only where the page is the kind Google has a rich result for: a product, a");
    lines.push("recipe, an event, an FAQ.");
    for (const entry of without.slice(0, 15)) {
      lines.push(`  ${entry.url} — ${entry.impressions} impressions`);
    }
    if (without.length > 15) lines.push(`  ... and ${without.length - 15} more`);
  }

  lines.push(...whatWasSampled(sample));
  lines.push("");
  lines.push("This is Google's record of what it detected, not a reading of the page's markup.");
  lines.push("Markup added recently will not appear until Google recrawls — gsc_crawl_freshness");
  lines.push("says when that last happened.");

  return toolText(lines.join("\n"));
}

export default defineGoogleTool(
  FAILURE_CONTEXT,
  { toolName: "gsc_rich_results", domainOf: (args) => args.siteUrl ?? null },
  handler,
);
