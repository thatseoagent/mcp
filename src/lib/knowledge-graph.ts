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
import { readOptionalConfig, type ConfigRequirement } from "./required-config";
import { callApi, DEFAULT_PER_MINUTE, UpstreamUnansweredError, type ThirdPartyService } from "./third-party-api";
import { UpstreamApiError } from "./upstream-api-error";

/**
 * Stated for `callApi`, which requires every key it places. It is never the
 * sentence an Operator reads: the key is an enrichment (see `required-config.ts`),
 * so its absence is answered as "not checked" below before `callApi` is reached,
 * and by then the requirement is met.
 */
const KG_KEY_REQUIREMENT: ConfigRequirement = {
  variable: "GOOGLE_KG_API_KEY",
  purpose: "ask Google's Knowledge Graph Search API whether it holds an entity for the brand",
  howToGet:
    "Create an API key at https://console.cloud.google.com/apis/credentials and enable the " +
    "Knowledge Graph Search API for its project.",
};

const KNOWLEDGE_GRAPH = {
  name: "Google's Knowledge Graph Search API",
  key: { requirement: KG_KEY_REQUIREMENT, in: "query", param: "key" },
  timeoutMs: 8_000,
  // Google publishes no per-minute figure for this API
  // (https://developers.google.com/knowledge-graph, read 2026-09-24), so the
  // default ceiling applies: one lookup per brand is all any Tool asks for.
  perMinute: DEFAULT_PER_MINUTE,
} satisfies ThirdPartyService;

export type KnowledgeGraphMatch = {
  /** `null` when we did not find out. Never a stand-in for "no". */
  found: boolean | null;
  /** Why there is no answer. Present only when `found` is `null`. */
  reason?: string;
};

export async function lookupKnowledgeGraph(brandName: string): Promise<KnowledgeGraphMatch> {
  // Our deployment, not their site. `null` says we did not find out, which is the
  // truth, and the reason says whose problem it is.
  if (!readOptionalConfig(KG_KEY_REQUIREMENT.variable)) return { found: null, reason: "the Knowledge Graph API is not configured on this deployment" };

  try {
    const { body } = await callApi(KNOWLEDGE_GRAPH, {
      url: "https://kgsearch.googleapis.com/v1/entities:search",
      query: { query: brandName, limit: "1" },
    });
    const data = body as { itemListElement?: unknown[] };
    return { found: (data.itemListElement?.length ?? 0) > 0 };
  } catch (error) {
    // A refusal names its status. A timeout, an unreadable answer or a network
    // failure has no status worth naming, and all three are "did not respond".
    if (error instanceof UpstreamApiError && !(error instanceof UpstreamUnansweredError)) {
      return { found: null, reason: `the Knowledge Graph API returned HTTP ${error.status}` };
    }
    return { found: null, reason: "the Knowledge Graph API did not respond" };
  }
}
