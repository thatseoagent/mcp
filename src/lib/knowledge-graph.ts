/**
 * Shared Google Knowledge Graph entity lookup.
 *
 * Sits beside `wikidata-check.ts` and answers the same shape of question about the
 * same kind of subject: does a third-party knowledge base hold an entity for this
 * brand? Both are keyed by a brand name rather than an origin, which is why neither
 * belongs with the well-known file reads in `lib/utils/well-known.ts`.
 *
 * `geo-tools` and `ai-visibility-tools` each had a copy of this. They agreed on the
 * query and disagreed on what a failure meant: one returned `null` for "the API did
 * not answer" after #337, the other still returned `false`, so a Knowledge Graph
 * outage cost a site 5 GEO points while costing it nothing in AI visibility.
 */
/**
 * Whether Google holds a Knowledge Graph entity for this brand.
 *
 * Three states, and the third is the point:
 *
 * - `true` / `false` — the API answered.
 * - `null` — it did not, so we know nothing. A caller must not score this as a
 *   failure: telling a brand with a Knowledge Panel to "strengthen entity signals"
 *   because the API 503'd is the failure mode #337 is named after.
 *
 * The no-API-key case is **not** `false`, and this file used to say exactly that
 * in the paragraph above while returning `false` on the line below it. The
 * comment had the right argument — `false` here charges every site for a check we
 * never gave them — and the code did the thing the argument forbids. It is
 * unreachable today only because `scoreL1` omits the check when the key is unset
 * and `geo-tools` passes a zero ceiling, i.e. because two callers remember. The
 * next one will not.
 *
 * ── The reason channel ──
 *
 * Returned a bare `boolean | null` while `wikidata-check` next door returned a
 * record with a `reason`, so a Knowledge Graph outage reached the reader as a
 * generic sentence where the specific one existed. Same question, same shape now.
 */
import { readOptionalConfig } from "./required-config";
import { fetchThirdPartyApi } from "./http-client";

export type KnowledgeGraphMatch = {
  /** `null` when we did not find out. Never a stand-in for "no". */
  found: boolean | null;
  /** Why there is no answer. Present only when `found` is `null`. */
  reason?: string;
};

export async function lookupKnowledgeGraph(brandName: string): Promise<KnowledgeGraphMatch> {
  const key = readOptionalConfig("GOOGLE_KG_API_KEY");
  // Our deployment, not their site. `null` says we did not find out, which is the
  // truth, and the reason says whose problem it is.
  if (!key) return { found: null, reason: "the Knowledge Graph API is not configured on this deployment" };

  try {
    const qs = new URLSearchParams({ query: brandName, key, limit: "1" });
    // Paced and scoped like the other fixed-API reads. See `fetchThirdPartyApi`.
    const res = await fetchThirdPartyApi(
      `https://kgsearch.googleapis.com/v1/entities:search?${qs}`,
      { timeout: 8_000 },
    );
    if (!res.ok) return { found: null, reason: `the Knowledge Graph API returned HTTP ${res.status}` };
    const data = (await res.json()) as { itemListElement?: unknown[] };
    return { found: (data.itemListElement?.length ?? 0) > 0 };
  } catch {
    return { found: null, reason: "the Knowledge Graph API did not respond" };
  }
}
