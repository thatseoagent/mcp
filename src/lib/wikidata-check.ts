/**
 * Shared Wikidata entity lookup helper.
 * Used by both ai-visibility-tools and entity-mentions-tools.
 */
import { callApi, UpstreamUnansweredError, type ThirdPartyService } from "./third-party-api";
import { UpstreamApiError } from "./upstream-api-error";
import { WIKIMEDIA_CEILING } from "./wikipedia-check";

/**
 * Wikidata's search API, as `callApi` takes it. Every request carries our
 * identity, which Wikidata's API policy asks for as a contactable agent.
 */
const WIKIDATA = {
  name: "Wikidata's search API",
  timeoutMs: 8_000,
  // Counted with Wikipedia's lookups: Wikimedia's limit is one for all of its
  // APIs, the Action API this is included. See `WIKIMEDIA_CEILING`.
  ...WIKIMEDIA_CEILING,
} satisfies ThirdPartyService;

export type WikidataMatch = {
  /**
   * Whether a matching item exists, or `null` when we never found out.
   *
   * `null` is not a third kind of "no". A search that came back and matched nothing
   * is evidence the brand has no Wikidata item; an API that returned 5xx or timed
   * out is evidence of nothing at all, and reporting the second as the first is how
   * a tool tells a confident lie — the same distinction
   * `crawlability-analyzer.isCrawlAllowed` already draws for robots.txt. Callers
   * must handle it explicitly: a falsy check treats "we could not ask" as "the
   * answer is no" (#337).
   */
  found: boolean | null;
  /** Why there is no answer. Present only when `found` is `null`. */
  reason?: string;
  id?: string;
  label?: string;
  description?: string;
};

/**
 * `language` is the page's, when it declares one.
 *
 * `wbsearchentities` searches one language's labels at a time, and this asked in
 * English unconditionally — so a brand whose Wikidata item is labelled only in
 * Spanish came back "no entity found", and the report told a company with an item to
 * go and create one (#342). English remains the fallback: it is the language most
 * items carry a label in, so it is the best guess when the page does not say.
 */
export async function lookupWikidata(
  brandName: string,
  language: string | null = null,
): Promise<WikidataMatch> {
  try {
    // Through `callApi`, which holds the request to Wikimedia's ceiling and puts
    // it inside the fetch scope. This was a bare `fetch`, so `force_refresh` did
    // not reach it and nothing held it to any limit — see `third-party-api.ts`
    // for why the robots gate is exempt here and the ceiling is not.
    const { body } = await callApi(WIKIDATA, {
      url: "https://www.wikidata.org/w/api.php",
      query: {
        action: "wbsearchentities",
        search: brandName,
        language: language ?? "en",
        type: "item",
        format: "json",
        limit: "3",
      },
    });
    const data = body as { search?: Array<{ label: string; id: string; description?: string }> };
    const bn = brandName.toLowerCase();
    const match = (data.search ?? []).find((r) => {
      const label = r.label.toLowerCase();
      return label.includes(bn) || bn.includes(label);
    });
    if (match) {
      return { found: true, id: match.id, label: match.label, description: match.description };
    }
    return { found: false };
  } catch (error) {
    // Not `found: false`: an HTTP error means the question was never answered.
    if (error instanceof UpstreamApiError && !(error instanceof UpstreamUnansweredError)) {
      return { found: null, reason: `Wikidata search API returned HTTP ${error.status}` };
    }
    // Timeout, an answer that is not JSON, DNS failure, connection refused.
    // Same reasoning, with no status to name.
    return { found: null, reason: "Wikidata search API did not respond" };
  }
}
