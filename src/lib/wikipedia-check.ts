/**
 * Whether Wikipedia has an article for a brand.
 *
 * ── Why a module ──
 *
 * Five external lookups back `entity_mentions`. Three had a module of their own —
 * `wikidata-check`, `knowledge-graph`, and the URL-shaped ones through
 * `well-known` — and two, Wikipedia and Reddit, sat inline in the Tool handler
 * calling the global `fetch`. Those were the only raw `fetch` calls anywhere in
 * `src/tools/`.
 *
 * The cost was that the three-state mapping was re-derived per probe. `fromHead`
 * in the Tool already shows the deep shape for the URL-shaped platforms, and says
 * why: "so the three URL-shaped platforms cannot drift apart on what a 403
 * means." The API-shaped ones had no equivalent, so `!res.ok → not-evaluated`,
 * `404 → absent` and `catch → not-evaluated` were written out per probe.
 *
 * Modelled on `wikidata-check.ts`, including the `found: boolean | null`
 * three-state and the reason for it.
 */
import { fetchThirdPartyApi } from "./http-client";
import { PAGE_AUDIT_USER_AGENT } from "./bot-identity";

/** How long to wait on one Wikipedia edition. */
const LOOKUP_TIMEOUT = 8_000;

export type WikipediaMatch = {
  /**
   * Whether an article exists, or `null` when we never found out.
   *
   * `null` is not a third kind of "no", for the reason `wikidata-check.ts` sets
   * out at length: a 404 is evidence the brand has no article, and a 429 or a 5xx
   * is evidence of nothing at all. Reporting the second as the first is how a
   * Tool tells a confident lie — and this one did, printing `✗ Wikipedia — NOT
   * FOUND` about a brand that may well have an article and counting it into the
   * summary as an absence nobody established.
   */
  found: boolean | null;
  /** Why there is no answer. Present only when `found` is `null`. */
  reason?: string;
  /** The article's title, when there is one. */
  title?: string;
  /** The article's URL, when there is one. */
  url?: string;
  /** Which editions were searched, so a report can say where it looked. */
  searched: string[];
};

/** One edition's answer. `null` means it did not tell us. */
async function summary(
  brand: string,
  lang: string,
): Promise<{ found: boolean | null; title?: string; url?: string; status?: number }> {
  try {
    const res = await fetchThirdPartyApi(
      `https://${lang}.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(brand)}`,
      {
        timeout: LOOKUP_TIMEOUT,
        // Wikipedia's API policy asks for a descriptive agent with a way to reach
        // the operator.
        headers: { "User-Agent": PAGE_AUDIT_USER_AGENT },
      },
    );

    // A 404 is the answer: this edition has no article under that title.
    if (res.status === 404) return { found: false };
    if (!res.ok) return { found: null, status: res.status };

    const data = (await res.json()) as {
      title?: string;
      content_urls?: { desktop?: { page?: string } };
    };
    return { found: true, title: data.title, url: data.content_urls?.desktop?.page };
  } catch {
    return { found: null };
  }
}

/**
 * Look for an article, in the page's own language first.
 *
 * `en.wikipedia.org` hard-coded meant a Spanish company with a Spanish article
 * and no English one was reported as having no Wikipedia presence.
 *
 * Asymmetric, so it costs nothing in the common case: an article found in the
 * page's own language is conclusive and English is never asked. Only a negative
 * spends the second request, because a brand writing in Spanish may perfectly
 * well have an English article and nothing else.
 *
 * @param language the page's declared base language, or `null` for English only.
 */
export async function lookupWikipedia(
  brand: string,
  language: string | null,
): Promise<WikipediaMatch> {
  const searched = language && language !== "en" ? [language, "en"] : ["en"];
  let unanswered: number | undefined;
  let anyUnanswered = false;

  for (const lang of searched) {
    const hit = await summary(brand, lang);
    if (hit.found === true) {
      return { found: true, title: hit.title, url: hit.url, searched };
    }
    if (hit.found === null) {
      anyUnanswered = true;
      if (hit.status !== undefined) unanswered = hit.status;
    }
  }

  // An edition that would not answer leaves the whole question open: the article
  // could be in the one we could not read.
  if (anyUnanswered) {
    return {
      found: null,
      reason:
        unanswered !== undefined
          ? `Wikipedia answered HTTP ${unanswered}`
          : "the request to Wikipedia failed or timed out",
      searched,
    };
  }

  return { found: false, searched };
}
