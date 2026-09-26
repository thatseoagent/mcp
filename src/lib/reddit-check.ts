/**
 * Whether Reddit has threads mentioning a brand.
 *
 * The second of the two lookups that sat inline in `entity_mentions` calling the
 * global `fetch`. See `wikipedia-check.ts` for why both moved out; the same
 * three-state discipline applies, and here it matters more than anywhere else in
 * the file: Reddit rate-limits unauthenticated search hard, so "we could not ask"
 * is the *likeliest* outcome in a real run, not an edge case.
 *
 * Reporting that as "no threads found" would be the confident lie
 * `wikidata-check.ts` describes, on the branch most often taken.
 */
import { callApi, UpstreamUnansweredError, type ThirdPartyService } from "./third-party-api";
import { UpstreamApiError } from "./upstream-api-error";

const REDDIT = {
  name: "Reddit's search API",
  timeoutMs: 8_000,
  // INFERRED. Reddit's Data API wiki gives OAuth clients 100 queries a minute
  // and limits traffic without OAuth — which is what this is — well below that
  // without a figure we could confirm
  // (https://support.reddithelp.com/hc/en-us/articles/16160319875092-Reddit-Data-API-Wiki,
  // which refused a scripted read on 2026-09-24). 10 a minute is the
  // conservative reading; one search per brand is all a Tool asks, so it binds
  // only a loop.
  perMinute: 10,
} satisfies ThirdPartyService;

/** How many threads to ask for. Enough to answer "is anyone talking about this?". */
const SAMPLE = 5;

export type RedditMatch = {
  /**
   * Whether any thread mentions the brand, or `null` when we never found out.
   *
   * See `wikidata-check.ts` for the argument. A search that came back empty is
   * evidence; a 429 is evidence of nothing.
   */
  found: boolean | null;
  /** Why there is no answer. Present only when `found` is `null`. */
  reason?: string;
  /** How many threads the sample turned up. Present only when `found` is `true`. */
  threads?: number;
  /** Where a reader can check our work. */
  url: string;
};

export async function lookupReddit(brand: string): Promise<RedditMatch> {
  const url = `https://www.reddit.com/search/?q=${encodeURIComponent(brand)}`;

  try {
    const { body } = await callApi(REDDIT, {
      url: "https://www.reddit.com/search.json",
      query: { q: brand, sort: "relevance", limit: String(SAMPLE) },
    });
    const data = body as { data?: { children?: unknown[] } };
    const threads = data.data?.children?.length ?? 0;
    return threads > 0 ? { found: true, threads, url } : { found: false, url };
  } catch (error) {
    if (error instanceof UpstreamApiError && !(error instanceof UpstreamUnansweredError)) {
      return { found: null, reason: `Reddit answered HTTP ${error.status}`, url };
    }
    // A timeout, or a 200 that was not JSON — Reddit's block page is HTML.
    return { found: null, reason: "the request to Reddit failed or timed out", url };
  }
}
