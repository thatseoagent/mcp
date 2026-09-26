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
 *
 * ── One reader of the summary endpoint ──
 *
 * `brand_pageviews` reads the same endpoint for a different question — which
 * article to count views of — and used to make the request itself, because
 * this module threw away the two fields it needed: the canonical title a
 * redirect lands on, and the page type that marks a disambiguation page. The two
 * copies had drifted apart on three things nobody chose: how the title was
 * encoded, how long to wait, and whether an answer was cached.
 * {@link readWikipediaSummary} is the one read now, and keeps every field
 * either caller interprets; each caller still decides what the fields mean.
 *
 * The title is sent with spaces as underscores, then percent-encoded, which is
 * what the endpoint's own reference asks for ("Use underscores instead of
 * spaces. Use percent-encoding. Example: `Main_Page`",
 * https://en.wikipedia.org/api/rest_v1/) — a title not in that normalised form
 * is documented to answer with a permanent redirect. This module sent `%20`,
 * which Wikipedia happens to accept today; `brand_pageviews` sent the documented
 * form, and the documented form is the one kept.
 */
import { callApi, UpstreamUnansweredError, type ThirdPartyService } from "./third-party-api";
import { UpstreamApiError } from "./upstream-api-error";
import { createSingleFlightCache } from "./single-flight";
import { isRecord } from "./type-guards";

/**
 * Wikimedia's one allowance, for every Wikimedia API this server calls.
 *
 * 200 requests a minute for an unauthenticated client with a compliant
 * User-Agent, against 10 by IP alone; ours carries `ThatSEOAgentBot` and a URL.
 * The limit "appl[ies] across all sites and platforms, including requests to the
 * Action API and REST APIs", so Wikipedia's REST API, Wikidata's search and the
 * Analytics API's pageviews are one window, not three
 * (https://www.mediawiki.org/wiki/Wikimedia_APIs/Rate_limits, read 2026-09-24;
 * `docs/research/api-surface-2026-09.md` §5).
 */
export const WIKIMEDIA_CEILING = { ceilingKey: "Wikimedia", perMinute: 200 } as const;

/**
 * Wikipedia's REST API, as `callApi` takes it.
 *
 * A 404 is the answer "this edition has no article under that title". The
 * budget is one edition's; a lookup that also asks English can take twice it.
 * Wikipedia's API policy asks for a descriptive agent with a way to reach the
 * operator, which every `callApi` request carries.
 */
const WIKIPEDIA = {
  name: "Wikipedia's REST API",
  timeoutMs: 10_000,
  noDataStatuses: [404],
  ...WIKIMEDIA_CEILING,
} satisfies ThirdPartyService;

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

/** What the summary endpoint said about a title, before anyone interprets it. */
export type WikipediaSummary =
  /** The edition has no page under that title. */
  | { kind: "none" }
  | {
      kind: "page";
      /** The title as displayed, spaces and all. */
      title: string | null;
      /** `titles.canonical`: the title as the API keys it, after any redirect. */
      canonical: string | null;
      /** `standard`, `disambiguation`, … as Wikipedia names it. */
      type: string | null;
      /** The article on the desktop site. */
      url: string | null;
      /** Wikidata's short description, when the page has one. */
      description: string | null;
    };

const summaryCache = createSingleFlightCache<WikipediaSummary>();

/**
 * One edition's summary of one title.
 *
 * @throws {UpstreamApiError} when Wikipedia answers with anything but the page or
 *         a 404, including no answer in time and an answer that is not JSON.
 */
export function readWikipediaSummary(title: string, language: string): Promise<WikipediaSummary> {
  const path = encodeURIComponent(title.trim().replace(/ /g, "_"));
  return summaryCache.run(`${language} ${path}`, async () => {
    const answer = await callApi(WIKIPEDIA, {
      url: `https://${language}.wikipedia.org/api/rest_v1/page/summary/${path}`,
    });
    if (answer.kind === "no-data") return { kind: "none" };

    // A JSON body that is not an object is not the endpoint's format, and
    // reading its absent fields as "no canonical title" would report a garbled
    // answer as a missing article.
    const data = answer.body;
    if (!isRecord(data)) throw UpstreamUnansweredError.unreadable(WIKIPEDIA.name, answer.status);
    const titles = isRecord(data.titles) ? data.titles : {};
    const desktop =
      isRecord(data.content_urls) && isRecord(data.content_urls.desktop) ? data.content_urls.desktop : {};
    return {
      kind: "page",
      title: stringOrNull(data.title),
      canonical: stringOrNull(titles.canonical),
      type: stringOrNull(data.type),
      url: stringOrNull(desktop.page),
      description: stringOrNull(data.description),
    };
  });
}

function stringOrNull(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

/** One edition's answer. `null` means it did not tell us. */
async function summary(
  brand: string,
  lang: string,
): Promise<{ found: boolean | null; title?: string; url?: string; status?: number }> {
  try {
    const page = await readWikipediaSummary(brand, lang);
    // A 404 is the answer: this edition has no article under that title.
    if (page.kind === "none") return { found: false };
    return { found: true, title: page.title ?? undefined, url: page.url ?? undefined };
  } catch (error) {
    // A status is worth naming; a timeout or an unreadable answer has none worth
    // naming, and is the "failed or timed out" the reason already says.
    if (error instanceof UpstreamApiError && !(error instanceof UpstreamUnansweredError)) {
      return { found: null, status: error.status };
    }
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
