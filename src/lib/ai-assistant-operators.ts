/**
 * Which crawler stands behind which AI assistant, in one table.
 *
 * `ai-crawlers.ts` knows each crawler and what its fetch is for. GA4 knows each
 * assistant by the host its referrals come from. Nothing joined the two, so a
 * site could block ChatGPT's search crawler while ChatGPT sent it visitors and
 * no Tool here would put those two facts in one sentence. This is the join, for
 * `site_ai_crawler_traffic`.
 *
 * ── How an entry earns its place ──
 *
 * Every crawler named below is named in its operator's own documentation, read
 * on 2026-09-24 at the URL on the entry, for the purpose it is filed under. An
 * assistant whose operator documents no crawler for its answers is left out
 * rather than guessed at — Grok, Meta AI, DeepSeek, You.com and Poe are on the
 * referrer host list in `ai-referrers.ts` and are not here. Meta documents
 * Meta-ExternalAgent "for use cases such as training foundation AI models or
 * improving products by indexing content directly"
 * (https://developers.facebook.com/docs/sharing/webmasters/web-crawlers), which
 * does not say that Meta AI's answers are built from it. Their sessions are
 * reported, unjoined, and the output says why.
 *
 * Purposes use `ai-crawlers.ts`'s vocabulary. Where a token is also on that
 * list, the purpose here must match it, and a test holds them together. Some
 * are not on it — Googlebot and Bingbot are search crawlers first and AI
 * crawlers by consequence, and Mistral's three are newer than the list — and are
 * addressed here only.
 *
 * ── The two that are not a crawler of their own ──
 *
 * **Gemini.** Google states that Google-Extended "is a standalone product token"
 * and that "crawling is done with existing Google user agent strings; the
 * robots.txt user-agent token is used in a control capacity". The fetching is
 * Googlebot's. And Google-Extended governs more than training: it manages
 * whether crawled content may be used for "grounding (providing content from the
 * Google Search index to the model at prompt time …)" in Gemini Apps and
 * Grounding with Google Search on Vertex AI — while it "does not impact a site's
 * inclusion in Google Search". So for Gemini, and only for Gemini, the control
 * token is an answer control, not a training opt-out.
 * https://developers.google.com/search/docs/crawling-indexing/google-common-crawlers
 *
 * **Copilot.** Microsoft names no separate crawler for it. Its documented
 * controls over use in Bing Chat (now Copilot) answers are the NOARCHIVE and
 * NOCACHE meta tags — "Content tagged NOARCHIVE will not be included in Bing Chat
 * answers" — which are read off pages Bing's crawler fetched, and Bing states it
 * "respects all content owner preferences expressed through robots.txt". That
 * Bingbot is the crawler Copilot's answers depend on is therefore an inference
 * from Microsoft's documentation, not a sentence in it, and the entry says so
 * wherever it is printed.
 * https://blogs.bing.com/webmaster/september-2023/Announcing-new-options-for-webmasters-to-control-usage-of-their-content-in-Bing-Chat
 * https://blogs.bing.com/webmaster/February-2026/Introducing-AI-Performance-in-Bing-Webmaster-Tools-Public-Preview
 */
import { hostKey } from "./url-match";

export interface AssistantOperator {
  /** The assistant, as a reader names it. */
  assistant: string;
  /** Who runs it and its crawlers. */
  operator: string;
  /**
   * The hosts its referrals arrive from, as GA4's `sessionSource` carries them.
   * Matched on the host or a subdomain of it, never a substring, for the reason
   * `classifyAiReferrer` gives.
   */
  referrerHosts: readonly string[];
  /** The crawlers that build what its answers cite from. */
  search: readonly string[];
  /** The agents that fetch a page because a person asked it to. */
  userFetch: readonly string[];
  /** The crawlers that only collect training data. */
  training: readonly string[];
  /**
   * Tokens that are not crawlers but govern whether fetched content may be used
   * in this assistant's answers. Google-Extended for Gemini; empty elsewhere.
   */
  answerControls: readonly string[];
  /** What the operator says an answer control governs, quoted. Set when `answerControls` is. */
  answerControlEffect?: string;
  /**
   * What the operator says about robots.txt and its user-triggered agent,
   * quoted, or `null` when it says it obeys robots.txt like its other crawlers.
   */
  userFetchRobotsNote: string | null;
  /** What the operator says blocking its search crawler does, quoted. */
  searchBlockEffect: string;
  /** Set when the crawler mapping is our inference rather than the operator's statement. */
  inference?: string;
  /** Where each statement above was read. */
  docs: readonly string[];
}

export const ASSISTANT_OPERATORS: readonly AssistantOperator[] = [
  {
    assistant: "ChatGPT",
    operator: "OpenAI",
    referrerHosts: ["chatgpt.com", "chat.openai.com", "openai.com"],
    search: ["OAI-SearchBot"],
    userFetch: ["ChatGPT-User"],
    training: ["GPTBot"],
    answerControls: [],
    userFetchRobotsNote:
      'OpenAI: "Because these actions are initiated by a user, robots.txt rules may not apply."',
    searchBlockEffect:
      'OpenAI: "Sites that are opted out of OAI-SearchBot will not be shown in ChatGPT search ' +
      'answers, though can still appear as navigational links."',
    docs: ["https://developers.openai.com/api/docs/bots"],
  },
  {
    assistant: "Perplexity",
    operator: "Perplexity",
    referrerHosts: ["perplexity.ai"],
    search: ["PerplexityBot"],
    userFetch: ["Perplexity-User"],
    training: [],
    answerControls: [],
    userFetchRobotsNote: 'Perplexity: Perplexity-User "generally ignores robots.txt rules".',
    searchBlockEffect:
      'Perplexity: PerplexityBot is designed to "surface and link websites in search results on ' +
      'Perplexity", and is not "used to crawl content for AI foundation models."',
    docs: ["https://docs.perplexity.ai/guides/bots"],
  },
  {
    assistant: "Claude",
    operator: "Anthropic",
    referrerHosts: ["claude.ai"],
    search: ["Claude-SearchBot"],
    userFetch: ["Claude-User"],
    training: ["ClaudeBot"],
    answerControls: [],
    userFetchRobotsNote: null,
    searchBlockEffect:
      'Anthropic: blocking Claude-SearchBot "prevents our system from indexing your content for ' +
      'search optimization, which may reduce your site\'s visibility and accuracy in user search results."',
    docs: [
      "https://support.claude.com/en/articles/8896518-does-anthropic-crawl-data-from-the-web-and-how-can-site-owners-block-the-crawler",
    ],
  },
  {
    assistant: "Gemini",
    operator: "Google",
    referrerHosts: ["gemini.google.com"],
    search: ["Googlebot"],
    userFetch: [],
    training: [],
    answerControls: ["Google-Extended"],
    answerControlEffect:
      'Google states it governs grounding — "providing content from the Google Search index to ' +
      'the model at prompt time" — in Gemini Apps, as well as training, while it "does not impact ' +
      "a site's inclusion in Google Search\". For Gemini it is an answer control, not only a " +
      "training opt-out.",
    userFetchRobotsNote: null,
    searchBlockEffect:
      'Google describes Gemini\'s grounding as "providing content from the Google Search index to ' +
      'the model at prompt time". That index is Googlebot\'s, so blocking Googlebot also removes ' +
      "the site from Google Search.",
    docs: ["https://developers.google.com/search/docs/crawling-indexing/google-common-crawlers"],
  },
  {
    assistant: "Copilot",
    operator: "Microsoft",
    referrerHosts: ["copilot.microsoft.com", "copilot.com", "edgeservices.bing.com"],
    search: ["Bingbot"],
    userFetch: [],
    training: [],
    answerControls: [],
    userFetchRobotsNote: null,
    searchBlockEffect:
      'Microsoft: by default, content "may be included in Bing Chat answers" (Bing Chat is now ' +
      "Copilot). Blocking Bingbot also removes the site from Bing search.",
    inference:
      "Microsoft names no separate crawler for Copilot; Bingbot is read here because Copilot's " +
      "documented answer controls (NOARCHIVE, NOCACHE) apply to pages Bing crawls.",
    docs: [
      "https://blogs.bing.com/webmaster/september-2023/Announcing-new-options-for-webmasters-to-control-usage-of-their-content-in-Bing-Chat",
    ],
  },
  {
    assistant: "Mistral",
    operator: "Mistral AI",
    referrerHosts: ["mistral.ai"],
    search: ["MistralAI-Index"],
    userFetch: ["MistralAI-User"],
    training: ["MistralAI-Training"],
    answerControls: [],
    userFetchRobotsNote: null,
    searchBlockEffect:
      "Mistral AI: MistralAI-Index indexes the web for the search behind its assistant's answers, " +
      'and "content crawled by MistralAI-Index is not used for generative AI training of any kind."',
    docs: ["https://docs.mistral.ai/robots"],
  },
];

/** The assistant a GA4 session source belongs to, or `null` when none is mapped. */
export function operatorForSource(source: string): AssistantOperator | null {
  // `hostKey`'s host, then a suffix match on it, as `classifyAiReferrer` does:
  // a subdomain is the assistant's without being the same host.
  const host = hostKey(source);
  if (host === null) return null;
  return (
    ASSISTANT_OPERATORS.find((entry) =>
      entry.referrerHosts.some((h) => host === h || host.endsWith(`.${h}`)),
    ) ?? null
  );
}
