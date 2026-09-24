import { z } from "zod";
import { type ToolMetadata, type InferSchema } from "xmcp";
import { analyzeRobotsTxt, type AiCrawlerPurpose } from "../lib/analyzers/robots-analyzer";
import { USAGE_CATEGORIES } from "../lib/analyzers/robots-ruleset";
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

/**
 * The directives a site owner would add to opt out of model training, and only
 * that.
 *
 * Training crawlers and control tokens, never the search crawlers. Blocking
 * OAI-SearchBot or Claude-SearchBot is how a site leaves ChatGPT and Claude
 * search, not how it leaves a training set, and the advice used to sit under a
 * flat list that did not tell the two apart. `anthropic-ai` is gone from it:
 * ClaudeBot is the token Anthropic documents for training.
 */
const AI_BLOCK_EXAMPLE = [
  "GPTBot",
  "ClaudeBot",
  "Google-Extended",
  "Applebot-Extended",
  "CCBot",
].map((agent) => `    User-agent: ${agent}\n    Disallow: /`);

/** How each purpose is headed in the output, in the order a reader should meet them. */
const PURPOSE_HEADINGS: ReadonlyArray<[AiCrawlerPurpose, string]> = [
  ["search", "AI search (blocking these removes the site from that product's answers)"],
  ["user-fetch", "Fetches on a user's request (some operators say robots.txt does not govern these)"],
  ["training", "Model training (blocking these is the training opt-out; search is unaffected)"],
  ["control-token", "Control tokens (not crawlers; they govern use, never crawling or ranking)"],
];

/**
 * What a `Content-Signal:` line is, said every time one is reported.
 *
 * Because the most natural misreading is the costly one: it looks like an access
 * rule and is not. Nothing in it stops a fetch.
 */
const USAGE_PREFERENCE_CAVEAT = [
  "Content-Signal is a stated preference about how fetched content may be used,",
  "not an access rule: it blocks no crawler, Google does not document reading it",
  "(Google-Extended is Google's own training control), and it binds only the",
  "crawlers that choose to honour it. An unlisted category states no preference.",
];

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

  lines.push("");
  lines.push("=== AI CRAWLER STATUS ===");
  for (const [purpose, heading] of PURPOSE_HEADINGS) {
    const crawlers = data.aiCrawlers.filter((c) => c.purpose === purpose);
    if (crawlers.length === 0) continue;
    lines.push("");
    lines.push(`${heading}:`);
    for (const crawler of crawlers) {
      lines.push(`  - ${crawler.crawler}: ${crawler.blocked ? "BLOCKED" : "allowed"}`);
      if (crawler.blocked) {
        for (const pattern of crawler.patterns) lines.push(`    Disallow: ${pattern}`);
      }
    }
  }

  if (data.usagePreferences.length > 0) {
    lines.push("");
    lines.push("=== CONTENT-SIGNAL (usage preferences) ===");
    for (const { userAgent, preferences } of data.usagePreferences) {
      const stated = USAGE_CATEGORIES.filter((category) => preferences[category] !== undefined)
        .map((category) => `${category}=${preferences[category]}`)
        .join(", ");
      lines.push(`User-agent: ${userAgent} — ${stated}`);
    }
    lines.push("");
    lines.push(...USAGE_PREFERENCE_CAVEAT);
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

  const blockedSearch = data.aiCrawlers.filter((c) => c.purpose === "search" && c.blocked);
  if (blockedSearch.length > 0) {
    lines.push(
      `- ${blockedSearch.map((c) => c.token).join(", ")} ${blockedSearch.length === 1 ? "is" : "are"} blocked. ` +
        "These build the index AI search answers cite from, so",
    );
    lines.push("  the site cannot be cited there. If the aim was to opt out of training, block the");
    lines.push("  training crawlers instead and allow these.");
  }
  if (!data.aiCrawlers.some((c) => c.purpose === "training" && c.blocked)) {
    lines.push("- No training crawler is blocked, so the content is available for model training.");
    lines.push("  To opt out of training without leaving AI search, add these directives:");
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
