import { z } from "zod";
import { type ToolMetadata, type InferSchema } from "xmcp";
import { analyzeRobotsTxt } from "../lib/analyzers/robots-analyzer";
import { defineCachedTool } from "../lib/define-tool";
import { domainFromUrl, refreshable } from "../lib/with-cache";
import { unwrap } from "../lib/type-guards";
import { toolText } from "../lib/tool-result";
import { withheld } from "../lib/render-list";

export const schema = {
  ...refreshable,
  url: z
    .string()
    .url()
    .describe("The base URL of the website. robots.txt is fetched from its /robots.txt"),
};

export const metadata: ToolMetadata = {
  name: "seo_robots_validator",
  description:
    "Read and validate a site's robots.txt: which crawlers are blocked, whether AI " +
    "crawlers can train on the content, which sitemaps are declared, and any syntax " +
    "problems. Needs no credentials and no database. Returns an error naming the " +
    "status if the site cannot be read.",
  annotations: {
    title: "Validate robots.txt",
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: true,
  },
};

/** Completes the sentence "Could not …" for every failure this Tool can return. */
const FAILURE_CONTEXT = "validate the robots.txt for this site";

/** How many user-agent groups to print. */
const MAX_DIRECTIVES_SHOWN = 20;

/** The AI crawler directives a site owner would add to block model training. */
const AI_BLOCK_EXAMPLE = [
  "GPTBot",
  "Google-Extended",
  "CCBot",
  "anthropic-ai",
].map((agent) => `    User-agent: ${agent}\n    Disallow: /`);

export default defineCachedTool(FAILURE_CONTEXT, { toolName: "seo_robots_validator", domainOf: domainFromUrl }, async ({ url }: InferSchema<typeof schema>) => {
  const data = unwrap(await analyzeRobotsTxt(url));
  const lines: string[] = [];

  lines.push("=== SUMMARY ===");
  lines.push(`Robots.txt URL: ${data.robotsTxtUrl}`);
  lines.push(`Exists: ${data.exists ? "Yes" : "No"}`);

  if (!data.exists) {
    lines.push("");
    lines.push("No robots.txt file found. This means:");
    lines.push("  - All crawlers can access all pages");
    lines.push("  - AI crawlers can use your content for training");
    lines.push("  - No crawl-delay restrictions");
    lines.push("");
    lines.push("Recommendation: create robots.txt to control crawler access.");
    return toolText(lines.join("\n"));
  }

  lines.push(`Total user-agents: ${data.summary.totalUserAgents}`);
  lines.push(`Blocks site-wide: ${data.summary.blocksSiteWide ? "Yes" : "No"}`);
  lines.push(`Allows Googlebot: ${data.summary.allowsGooglebot ? "Yes" : "No"}`);
  lines.push(`Blocks AI crawlers: ${data.summary.blocksAiCrawlers ? "Yes" : "No"}`);

  const blocked = data.aiCrawlers.filter((c) => c.blocked);
  const allowed = data.aiCrawlers.filter((c) => !c.blocked);

  lines.push("");
  lines.push("=== AI CRAWLER STATUS ===");
  if (blocked.length > 0) {
    lines.push("");
    lines.push("Blocked AI crawlers:");
    for (const crawler of blocked) {
      lines.push(`  - ${crawler.crawler}`);
      for (const pattern of crawler.patterns) lines.push(`    Disallow: ${pattern}`);
    }
  }
  if (allowed.length > 0) {
    lines.push("");
    lines.push("Allowed AI crawlers:");
    for (const crawler of allowed) lines.push(`  - ${crawler.crawler}`);
  }

  if (data.sitemaps.length > 0) {
    lines.push("");
    lines.push("=== SITEMAPS ===");
    for (const sitemap of data.sitemaps) lines.push(`- ${sitemap}`);
  }

  if (data.directives.length > 0) {
    lines.push("");
    lines.push("=== DIRECTIVES ===");
    // Capped because a large site's robots.txt can carry hundreds of groups, and
    // the whole file is printed below anyway when it is small enough to be worth
    // reading.
    for (const directive of data.directives.slice(0, 20)) {
      lines.push("");
      lines.push(`User-agent: ${directive.userAgent}`);
      for (const rule of directive.rules) {
        if (rule.type === "disallow" || rule.type === "allow") {
          const label = rule.type === "allow" ? "Allow" : "Disallow";
          lines.push(`  ${label}: ${rule.pattern}`);
        } else if (rule.type === "crawl-delay") {
          lines.push(`  Crawl-delay: ${rule.value}`);
        }
      }
    }
    if (data.directives.length > 20) {
      lines.push("");
      lines.push(...withheld(data.directives.length, MAX_DIRECTIVES_SHOWN, { noun: "user-agents", indent: "" }));
    }
  }

  if (data.issues.length > 0) {
    lines.push("");
    lines.push("=== ISSUES ===");
    for (const issue of data.issues) {
      const location = issue.line ? ` (line ${issue.line})` : "";
      lines.push(`- [${issue.type.toUpperCase()}]${location} ${issue.message}`);
    }
  }

  lines.push("");
  lines.push("=== RECOMMENDATIONS ===");
  if (data.issues.length === 0) lines.push("No syntax issues detected.");

  if (!data.summary.blocksAiCrawlers) {
    lines.push("- Your content is accessible to AI crawlers (GPTBot, ClaudeBot, etc.).");
    lines.push("  To block AI training, add these directives:");
    lines.push(...AI_BLOCK_EXAMPLE);
  }
  if (data.sitemaps.length === 0) {
    lines.push("- No sitemap declared in robots.txt. Add:");
    lines.push("    Sitemap: https://example.com/sitemap.xml");
  }
  if (data.summary.blocksSiteWide) {
    lines.push("- WARNING: the site is blocked to all crawlers (User-agent: * + Disallow: /).");
    lines.push("  This prevents search engines from indexing it.");
  }
  if (!data.summary.allowsGooglebot) {
    lines.push("- WARNING: Googlebot is blocked, so the site will not appear in Google search.");
  }

  if (data.content && data.content.length < 2000) {
    lines.push("");
    lines.push("=== RAW CONTENT ===");
    lines.push(data.content);
  }

  return toolText(lines.join("\n"));
});
