import { z } from "zod";
import { type ToolMetadata, type InferSchema } from "xmcp";
import { analyzeOnPageSeo } from "../lib/analyzers/onpage-seo";
import { defineCachedTool } from "../lib/define-tool";
import { domainFromUrl, refreshable } from "../lib/with-cache";
import { toolText } from "../lib/tool-result";

export const schema = {
  ...refreshable,
  url: z.string().url().describe("The URL of the page to analyze"),
};

export const metadata: ToolMetadata = {
  name: "seo_analyze_page",
  description:
    "Read one page's on-page SEO: title, meta description, canonical, headings, " +
    "word count, links, image alt text, Open Graph, JSON-LD and hreflang, with the " +
    "issues those add up to. Needs no credentials and no database. Returns an error " +
    "naming the status if the page cannot be read.",
  annotations: {
    title: "Analyze on-page SEO",
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: true,
  },
};

/** Completes the sentence "Could not …" for every failure this Tool can return. */
const FAILURE_CONTEXT = "analyze this page";

/** How many undescribed images to name before summarizing the rest. */
const MAX_LISTED_IMAGES = 20;

export default defineCachedTool(FAILURE_CONTEXT, { toolName: "seo_analyze_page", domainOf: domainFromUrl }, async ({ url }: InferSchema<typeof schema>) => {
  const result = await analyzeOnPageSeo(url);
  const lines: string[] = [];

  lines.push("=== META ===");
  lines.push(`Title: ${result.meta.title ?? "(missing)"} (${result.meta.titleLength} chars)`);
  lines.push(
    `Description: ${result.meta.description ?? "(missing)"} (${result.meta.descriptionLength} chars)`,
  );
  lines.push(`Canonical: ${result.meta.canonical ?? "(missing)"}`);
  lines.push(`Robots: ${result.meta.robots ?? "(not set)"}`);
  lines.push(`Viewport: ${result.meta.viewport ?? "(missing)"}`);
  lines.push(`Charset: ${result.meta.charset ?? "(not declared)"}`);
  lines.push(`Lang: ${result.meta.lang ?? "(missing)"}`);

  lines.push("\n=== HEADINGS ===");
  for (const [level, texts] of Object.entries(result.headings)) {
    for (const text of texts) {
      lines.push(`${level.toUpperCase()}: ${text}`);
    }
  }
  if (Object.keys(result.headings).length === 0) lines.push("(no headings found)");

  lines.push("\n=== CONTENT ===");
  lines.push(`Word count: ${result.content.wordCount}`);
  lines.push(`Internal links: ${result.content.internalLinks}`);
  lines.push(`External links: ${result.content.externalLinks}`);
  lines.push(`Total links: ${result.content.totalLinks}`);

  lines.push("\n=== IMAGES ===");
  lines.push(`Total images: ${result.images.total}`);
  if (result.images.withoutAlt.length > 0) {
    lines.push(`Images without alt (${result.images.withoutAlt.length}):`);
    for (const src of result.images.withoutAlt.slice(0, MAX_LISTED_IMAGES)) {
      lines.push(`  - ${src}`);
    }
    if (result.images.withoutAlt.length > MAX_LISTED_IMAGES) {
      lines.push(`  ... and ${result.images.withoutAlt.length - MAX_LISTED_IMAGES} more`);
    }
  }

  if (Object.keys(result.openGraph).length > 0) {
    lines.push("\n=== OPEN GRAPH ===");
    for (const [key, value] of Object.entries(result.openGraph)) {
      lines.push(`${key}: ${value}`);
    }
  }

  if (result.jsonLd.length > 0) {
    lines.push("\n=== JSON-LD ===");
    lines.push(JSON.stringify(result.jsonLd, null, 2));
  }

  if (result.hreflang.length > 0) {
    lines.push("\n=== HREFLANG ===");
    for (const { lang, href } of result.hreflang) {
      lines.push(`${lang}: ${href}`);
    }
  }

  lines.push("\n=== SEO ISSUES ===");
  if (result.issues.length === 0) {
    lines.push("No issues detected.");
  } else {
    for (const issue of result.issues) {
      lines.push(`- ${issue}`);
    }
  }

  return toolText(lines.join("\n"));
});
