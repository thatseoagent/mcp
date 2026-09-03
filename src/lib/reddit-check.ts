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
import { fetchThirdPartyApi } from "./http-client";

/** How long to wait on Reddit's search. */
const LOOKUP_TIMEOUT = 8_000;

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
    const query = new URLSearchParams({ q: brand, sort: "relevance", limit: String(SAMPLE) });
    const res = await fetchThirdPartyApi(`https://www.reddit.com/search.json?${query}`, {
      timeout: LOOKUP_TIMEOUT,
    });

    if (!res.ok) {
      return { found: null, reason: `Reddit answered HTTP ${res.status}`, url };
    }

    const data = (await res.json()) as { data?: { children?: unknown[] } };
    const threads = data.data?.children?.length ?? 0;
    return threads > 0 ? { found: true, threads, url } : { found: false, url };
  } catch {
    return { found: null, reason: "the request to Reddit failed or timed out", url };
  }
}
