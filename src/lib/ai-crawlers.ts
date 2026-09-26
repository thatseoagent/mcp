/**
 * The AI crawlers this server knows by name, and what each one's fetch is for.
 *
 * One list for every reader of robots.txt, in a module that imports nothing. It
 * was three: `robots-analyzer` had eleven names, and `geo-analyzer` and
 * `ai_visibility_score` each had the same four — GPTBot, PerplexityBot, ClaudeBot
 * and Google-Extended — and scored them as "AI crawler access". Two of those four
 * are about training, not about answers:
 *
 *   - GPTBot and ClaudeBot collect training corpora. The crawlers that build the
 *     indexes ChatGPT and Claude search cite from are OAI-SearchBot and
 *     Claude-SearchBot, and each operator documents the two as independent.
 *   - Google-Extended is not a crawler at all. It is a token governing whether
 *     Googlebot's fetches may be used for Gemini, and Google states it does not
 *     affect inclusion in Search.
 *
 * So a site that opted out of training — a common and reasonable choice — lost
 * points for "AI visibility" it still had, while a site that blocked
 * OAI-SearchBot and Claude-SearchBot, and really had left those answers, lost
 * nothing. The purpose is on every entry now, and a scorer asks for the purpose
 * it means.
 *
 * Purposes are the operators' own published descriptions. The space moves;
 * treat this as a maintained list rather than a closed set.
 */

/**
 * What an AI crawler's fetch is *for*, which decides what blocking it costs.
 *
 * - `training` — collects a corpus to train models on. Blocking it is the
 *   training opt-out and costs nothing in search or AI answers.
 * - `search` — builds the index an AI search product answers and cites from.
 *   Blocking it is how a site disappears from ChatGPT search or Perplexity.
 * - `user-fetch` — fetches a page because a person asked the assistant to.
 *   Some operators state that robots.txt does not govern these.
 * - `control-token` — not a crawler. Google-Extended and Applebot-Extended are
 *   names robots.txt can address; the fetching is done by Googlebot and
 *   Applebot, and blocking the token changes only what the content may be used
 *   for, never whether it is crawled or ranked. "Used for" is wider than
 *   training in Google's case: Google-Extended also governs grounding in Gemini
 *   Apps — the model reading Search's index at answer time — so blocking it can
 *   take a site out of Gemini's answers while leaving Search untouched.
 *   https://developers.google.com/search/docs/crawling-indexing/google-common-crawlers
 */
export type AiCrawlerPurpose = "training" | "search" | "user-fetch" | "control-token";

export interface AiCrawler {
  /** The user-agent token, as robots.txt addresses it. */
  name: string;
  description: string;
  purpose: AiCrawlerPurpose;
}

export const AI_CRAWLERS: readonly AiCrawler[] = [
  { name: "GPTBot", description: "OpenAI model training", purpose: "training" },
  { name: "OAI-SearchBot", description: "OpenAI ChatGPT search", purpose: "search" },
  { name: "ChatGPT-User", description: "OpenAI ChatGPT, on a user's request", purpose: "user-fetch" },
  { name: "ClaudeBot", description: "Anthropic model training", purpose: "training" },
  { name: "anthropic-ai", description: "Anthropic, legacy token", purpose: "training" },
  { name: "Claude-SearchBot", description: "Anthropic Claude search", purpose: "search" },
  { name: "Claude-User", description: "Anthropic Claude, on a user's request", purpose: "user-fetch" },
  { name: "PerplexityBot", description: "Perplexity search", purpose: "search" },
  { name: "Perplexity-User", description: "Perplexity, on a user's request", purpose: "user-fetch" },
  // Mistral documents the three as independent: https://docs.mistral.ai/robots
  { name: "MistralAI-Index", description: "Mistral search", purpose: "search" },
  { name: "MistralAI-User", description: "Mistral Vibe, on a user's request", purpose: "user-fetch" },
  { name: "MistralAI-Training", description: "Mistral training", purpose: "training" },
  { name: "Google-Extended", description: "Google Gemini training and grounding", purpose: "control-token" },
  { name: "Applebot-Extended", description: "Apple Intelligence training", purpose: "control-token" },
  { name: "Meta-ExternalAgent", description: "Meta AI training", purpose: "training" },
  { name: "FacebookBot", description: "Meta", purpose: "training" },
  { name: "CCBot", description: "Common Crawl", purpose: "training" },
  { name: "Bytespider", description: "ByteDance", purpose: "training" },
  { name: "Omgilibot", description: "Omgili", purpose: "training" },
  { name: "Diffbot", description: "Diffbot", purpose: "training" },
];

/** The tokens with one purpose, in list order. */
export function crawlersFor(...purposes: AiCrawlerPurpose[]): string[] {
  return AI_CRAWLERS.filter((c) => purposes.includes(c.purpose)).map((c) => c.name);
}

/**
 * The crawlers whose access decides whether AI search can cite a page.
 *
 * Google is absent on purpose. AI Overviews and AI Mode are fed by Googlebot, and
 * whether Googlebot may fetch the page is already the first thing
 * `seo_geo_score` asks — its indexability gate. Scoring Google-Extended here
 * stood in for that, and measured something else.
 */
export const ANSWER_ENGINE_CRAWLERS: readonly string[] = crawlersFor("search");

/**
 * The crawlers and tokens a training opt-out addresses. Reported beside the
 * search crawlers and never scored: opting out is the site's choice, and it
 * costs the page nothing in any answer.
 */
export const TRAINING_CRAWLERS: readonly string[] = crawlersFor("training", "control-token");
