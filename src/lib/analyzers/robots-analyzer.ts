/**
 * Robots.txt analyzer.
 * Parses robots.txt files, detects AI crawler blocks, and validates syntax.
 */

import { type Result, success, failure } from "../result";
import { fetchWithTimeout, validateUrl } from "../http-client";
import { parseRobots, type RobotsRuleset } from "./robots-ruleset";
import { PageFetchError } from "../page-fetch-error";

export interface RobotsDirective {
  userAgent: string;
  rules: {
    type: "allow" | "disallow" | "crawl-delay" | "sitemap";
    pattern?: string;
    value?: string;
  }[];
}

export interface AiCrawlerDirective {
  crawler: string;
  blocked: boolean;
  patterns: string[];
}

export interface RobotsIssue {
  type: "syntax" | "conflict" | "warning";
  message: string;
  line?: number;
}

export interface RobotsAnalysisResult {
  robotsTxtUrl: string;
  exists: boolean;
  content: string | null;
  directives: RobotsDirective[];
  sitemaps: string[];
  aiCrawlers: AiCrawlerDirective[];
  issues: RobotsIssue[];
  summary: {
    totalUserAgents: number;
    blocksSiteWide: boolean;
    allowsGooglebot: boolean;
    blocksAiCrawlers: boolean;
  };
}

/**
 * Known AI crawlers to detect.
 */
const AI_CRAWLERS = [
  { name: "GPTBot", description: "OpenAI ChatGPT" },
  { name: "Google-Extended", description: "Google Bard/Gemini" },
  { name: "CCBot", description: "Common Crawl" },
  { name: "anthropic-ai", description: "Anthropic Claude" },
  { name: "ClaudeBot", description: "Anthropic Claude" },
  { name: "Bytespider", description: "TikTok" },
  { name: "Omgilibot", description: "Omgili search" },
  { name: "Applebot-Extended", description: "Apple Intelligence" },
  { name: "FacebookBot", description: "Meta AI" },
  { name: "Diffbot", description: "Diffbot AI" },
  { name: "PerplexityBot", description: "Perplexity AI" },
];

/**
 * Analyze robots.txt file for a website.
 * Returns Result type for explicit error handling.
 */
export async function analyzeRobotsTxt(
  baseUrl: string
): Promise<Result<RobotsAnalysisResult>> {
  try {
    validateUrl(baseUrl);

  // Construct robots.txt URL
  const parsedUrl = new URL(baseUrl);
  const robotsTxtUrl = new URL("/robots.txt", parsedUrl.origin).href;

  let content: string | null = null;
  let exists = false;

  // Fetch robots.txt
  try {
    const response = await fetchWithTimeout(robotsTxtUrl);
    content = await response.text();
    exists = true;
  } catch (error) {
    // "There is no robots.txt here" is an answer, not a failure — every crawler
    // treats it as "nothing is disallowed" and so do we. 410 says the file was
    // deliberately removed, which is the same fact.
    //
    // This used to match on `error.message.includes("HTTP 404")`, reading a
    // decision out of prose that exists to be reworded, and it missed 410
    // entirely: a site serving Gone on /robots.txt got an error instead of an
    // answer. `PageFetchError` carries the status for exactly this.
    if (error instanceof PageFetchError && (error.status === 404 || error.status === 410)) {
      exists = false;
    } else {
      // Anything else — a timeout, a 500, DNS — is a genuine failure to look.
      throw error;
    }
  }

  // `content === null` rather than `!content`, which is what this used to be.
  // An empty robots.txt served with a 200 is not a missing one: the site owner
  // put a file there that restricts nothing, and reporting it as absent both
  // states something false and recommends creating a file that already exists.
  if (!exists || content === null) {
    return success({
      robotsTxtUrl,
      exists: false,
      content: null,
      directives: [],
      sitemaps: [],
      aiCrawlers: [],
      issues: [],
      summary: {
        totalUserAgents: 0,
        blocksSiteWide: false,
        allowsGooglebot: true,
        blocksAiCrawlers: false,
      },
    });
  }

  // Parse robots.txt
  const ruleset = parseRobots(content);
  const { sitemaps, issues } = ruleset;
  // `RobotsDirective` is the shape this analyzer's Section has always had, and
  // `RobotsGroup` is the same idea under the parser's names. Mapped here rather
  // than changing the stored shape, which every existing audit row uses.
  const directives: RobotsDirective[] = ruleset.groups.map((group) => ({
    userAgent: group.userAgent,
    rules: group.rules.map((rule) => ({ type: rule.type, pattern: rule.pattern })),
  }));

  // Detect AI crawler blocks
  const aiCrawlers = detectAiCrawlerBlocks(ruleset);

  // Calculate summary
  const summary = calculateSummary(ruleset, aiCrawlers);

  return success({
    robotsTxtUrl,
    exists: true,
    content,
    directives,
    sitemaps,
    aiCrawlers,
    issues,
    summary,
  });
  } catch (error) {
    const err = error instanceof Error ? error : new Error(String(error));
    return failure(err);
  }
}

/**
 * Which AI crawlers are shut out, and what the rest are merely restricted from.
 *
 * "Blocked" means cannot fetch the site root. This function used to count *any*
 * disallow rule as a block — `blocked: blockedSiteWide || disallowRules.length > 0`
 * — so `Disallow: /admin/` reported GPTBot as blocked here while the GEO and
 * AI-visibility sections of the same audit reported it as allowed. One file,
 * three verdicts.
 */
function detectAiCrawlerBlocks(ruleset: RobotsRuleset): AiCrawlerDirective[] {
  return AI_CRAWLERS.map((aiCrawler) => ({
    crawler: `${aiCrawler.name} (${aiCrawler.description})`,
    blocked: ruleset.blocksEntirely(aiCrawler.name),
    patterns: ruleset.restrictionsFor(aiCrawler.name),
  }));
}

/**
 * The headline facts, all of them answered by the one matcher.
 *
 * `allowsGooglebot` and `blocksSiteWide` used to look for a literal
 * `Disallow: /` in a specific group, which missed `Disallow: /*` and missed a
 * rule stated in a second block for the same agent.
 */
function calculateSummary(
  ruleset: RobotsRuleset,
  aiCrawlers: AiCrawlerDirective[]
): {
  totalUserAgents: number;
  blocksSiteWide: boolean;
  allowsGooglebot: boolean;
  blocksAiCrawlers: boolean;
} {
  return {
    totalUserAgents: new Set(ruleset.groups.map((g) => g.userAgent.toLowerCase())).size,
    // What an unnamed crawler gets. `*` is the group any agent without its own
    // rules falls back to.
    blocksSiteWide: ruleset.blocksEntirely("SomeUnnamedCrawler"),
    allowsGooglebot: !ruleset.blocksEntirely("Googlebot"),
    blocksAiCrawlers: aiCrawlers.some((c) => c.blocked),
  };
}

// ── Section types (co-located with the module that produces them) ──────────────

export type RobotsSection = {
  url: string;
  exists: boolean;
  blocksSiteWide: boolean;
  allowsGooglebot: boolean;
  blocksAiCrawlers: boolean;
  aiCrawlers: { allowed: string[]; blocked: string[] };
  sitemaps: string[];
  directives: Array<{
    userAgent: string;
    rules: Array<{ type: "allow" | "disallow"; path: string }>;
  }>;
  criticalIssues: number;
  warnings: number;
  recommendations: string[];
};
