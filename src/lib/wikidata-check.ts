/**
 * Shared Wikidata entity lookup helper.
 * Used by both ai-visibility-tools and entity-mentions-tools.
 */
import { PAGE_AUDIT_USER_AGENT } from "./bot-identity";
import { fetchThirdPartyApi } from "./http-client";

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
    const qs = new URLSearchParams({
      action: "wbsearchentities",
      search: brandName,
      language: language ?? "en",
      type: "item",
      format: "json",
      limit: "3",
    });
    // Through `fetchThirdPartyApi`, which paces the request and puts it inside
    // the fetch scope. This was a bare `fetch`, so `force_refresh` did not reach
    // it and nothing held it to a pace — see that function for why the robots
    // gate is exempt here and the pace is not.
    const res = await fetchThirdPartyApi(`https://www.wikidata.org/w/api.php?${qs}`, {
      timeout: 8_000,
      // Wikidata is on the signer's exclusion list, so this carries the identity
      // (their API policy asks for a contactable agent) without a signature.
      headers: { "User-Agent": PAGE_AUDIT_USER_AGENT },
    });
    // Not `found: false`: an HTTP error means the question was never answered.
    if (!res.ok) return { found: null, reason: `Wikidata search API returned HTTP ${res.status}` };
    const data = await res.json() as { search?: Array<{ label: string; id: string; description?: string }> };
    const bn = brandName.toLowerCase();
    const match = (data.search ?? []).find((r) => {
      const label = r.label.toLowerCase();
      return label.includes(bn) || bn.includes(label);
    });
    if (match) {
      return { found: true, id: match.id, label: match.label, description: match.description };
    }
    return { found: false };
  } catch {
    // Timeout, DNS failure, connection refused. Same reasoning as the !ok branch.
    return { found: null, reason: "Wikidata search API did not respond" };
  }
}
