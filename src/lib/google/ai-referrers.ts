/**
 * Telling a visit that arrived from an AI assistant from one that did not.
 *
 * Ported whole, comments included, because the comments are where the evidence
 * lives: the counts below were measured against a real property, and the reason
 * `bing.com` is absent is a correction somebody had to make after shipping the
 * mistake.
 */
/**
 * The medium GA4 assigns when it recognises the referrer as an AI assistant.
 *
 * Google classifies this itself now: the visit gets `medium = ai-assistant`,
 * campaign `(ai-assistant)`, and the `AI Assistant` default channel group.
 * https://support.google.com/analytics/answer/9756891
 *
 * This is the rule. The host list below is what we fall back on, not the other
 * way round.
 */
export const AI_ASSISTANT_MEDIUM = "ai-assistant";

/**
 * Hosts we count as an AI engine when Google has not classified the visit.
 *
 * A supplement, for engines Google does not recognise yet. It is deliberately
 * not the primary rule, and the cost of having had it be the primary rule was
 * measured: on a property with 100 AI sessions, this list found 2. Google had
 * moved the other 98 out of `referral` and into `ai-assistant`, which the old
 * check required them to still be in, and one of the five sources was
 * `copilot.com`, which was not on the list at all.
 *
 * `bing.com` used to be here too, so every referral from Bing's ordinary web
 * search was reported to the site's owner as a citation by an AI engine.
 * Copilot has its own hosts, which is why removing Bing loses nothing: what it
 * added was the search engine, not the assistant.
 *
 * A host earns a place only if arriving from it means a person was reading an
 * AI answer. Search engines with AI features do not qualify, because the
 * referral does not say which of the two the person used.
 */
export const AI_REFERRER_HOSTS = [
  "chatgpt.com",
  "chat.openai.com",
  "openai.com",
  "perplexity.ai",
  "gemini.google.com",
  "claude.ai",
  "copilot.microsoft.com",
  "copilot.com",
  "edgeservices.bing.com",
  "grok.com",
  "meta.ai",
  "deepseek.com",
  "you.com",
  "poe.com",
  "mistral.ai",
] as const;

/** Why a visit was counted as AI traffic. */
export type AiReferrerVerdict = "google" | "host-list" | null;

/**
 * Did this visit come from an AI engine, and who says so?
 *
 * Google's own classification first, our list second. Returns which of the two
 * decided, because a report that mixes Google's answer with ours owes the
 * reader the difference.
 *
 * The host match is on a host or a subdomain of it, never a substring.
 * Substring matching is what let `bing.com` stand for
 * `edgeservices.bing.com`, and it would just as happily count
 * `notchatgpt.com.example.org`.
 */
export function classifyAiReferrer(source: string, medium: string): AiReferrerVerdict {
  const m = medium.toLowerCase();
  if (m === AI_ASSISTANT_MEDIUM) return "google";
  if (m !== "referral") return null;

  const host = source.toLowerCase().replace(/^www\./, "");
  return AI_REFERRER_HOSTS.some((h) => host === h || host.endsWith(`.${h}`))
    ? "host-list"
    : null;
}

/** Did this visit come from an AI engine? See {@link classifyAiReferrer}. */
export function isAiReferrer(source: string, medium: string): boolean {
  return classifyAiReferrer(source, medium) !== null;
}
