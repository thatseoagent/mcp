/**
 * How many people read a brand's Wikipedia article, month by month.
 *
 * Google Trends would be the obvious series for "is interest in this brand
 * rising?", and its API is an application-only alpha. Wikimedia's Analytics API
 * publishes per-article pageviews for every Wikipedia edition since July 2015,
 * free and without a key, which makes it the closest public series there is. It
 * is a **proxy**: it counts people reading an encyclopedia article, which moves
 * with news, controversies and anything else sharing the name, not people
 * searching for the brand.
 *
 * ── What it reads from `wikipedia-check.ts` ──
 *
 * That module answers "is there an article?", and this needs two more things
 * from the same summary endpoint: the **canonical** title and the page **type**.
 * Pageviews are counted per title as requested, so asking for "SEO" returns the
 * views of the redirect page and not of "Search_engine_optimization"; the
 * summary endpoint follows the redirect and names the target in
 * `titles.canonical`. And a brand called "Mercury" lands on a disambiguation
 * page, whose readers are looking for a planet, an element and a god — a series
 * about them is not about the brand. `readWikipediaSummary` keeps both, so the
 * one read serves both questions; this module used to repeat the request with
 * its own encoding and its own timeout. `wikidata-check.ts` would find an item,
 * and its sitelinks would need a second request to reach the same title.
 *
 * ── Facts about the API this is written to (read 2026-09-24) ──
 *
 * - `GET https://wikimedia.org/api/rest_v1/metrics/pageviews/per-article/{project}/
 *   {access}/{agent}/{article}/{granularity}/{start}/{end}`, timestamps
 *   `YYYYMMDDHH`, granularity `daily` or `monthly`, agent `user` for human
 *   traffic. The answer is `{ items: [{ timestamp, views, … }] }`.
 * - A 404 means no data for the title in the window — an article with no views
 *   yet, or one that does not exist. The summary lookup has already told the two
 *   apart by then.
 * - The current month is returned **partial**: asking on the 24th returned the
 *   views so far. So a monthly window ends at the last complete month.
 * - Wikimedia rate-limits unidentified clients to 10 requests a minute and
 *   identified ones to 200, and identified means a User-Agent with contact
 *   details. `PAGE_AUDIT_USER_AGENT` carries a URL; each call makes two requests.
 */
import { callApi, type ThirdPartyService } from "./third-party-api";
import { readWikipediaSummary, WIKIMEDIA_CEILING, type WikipediaSummary } from "./wikipedia-check";
import { createSingleFlightCache } from "./single-flight";
import { isRecord } from "./type-guards";

const PAGEVIEWS = {
  name: "Wikimedia's Analytics API",
  timeoutMs: 15_000,
  // No data for the title in the window. See the header for why that is an
  // answer by the time this is asked.
  noDataStatuses: [404],
  // Counted with Wikipedia's lookups: Wikimedia's limit is one for all of its
  // APIs. See `WIKIMEDIA_CEILING`.
  ...WIKIMEDIA_CEILING,
} satisfies ThirdPartyService;

/** The first day Wikimedia serves per-article data for. */
export const DATA_START = "20150701";

/** What the summary endpoint said about a title. */
export type ArticleLookup =
  | {
      kind: "article";
      /** The title as the API keys it, underscores for spaces. */
      canonical: string;
      /** The title for reading, spaces restored. */
      title: string;
      language: string;
      url: string;
      description: string | null;
    }
  | { kind: "disambiguation"; title: string; language: string; url: string }
  | { kind: "none"; language: string };

const viewsCache = createSingleFlightCache<PageviewSeries>();

/**
 * One edition's answer about one title.
 *
 * @throws {UpstreamApiError} when Wikipedia answers with anything but the page or
 *         a 404. A 429 or a 5xx is evidence of nothing, and reporting it as "no
 *         article" is the confident lie `wikipedia-check.ts` warns about.
 */
export async function lookupArticle(title: string, language: string): Promise<ArticleLookup> {
  return readSummary(await readWikipediaSummary(title, language), language);
}

/**
 * The summary, as the question this module asks. Exported for its test.
 *
 * A page with no canonical title is no article: there is no title to count
 * views of, and guessing one from the request would count a redirect's.
 */
export function readSummary(summary: WikipediaSummary, language: string): ArticleLookup {
  if (summary.kind === "none" || !summary.canonical) return { kind: "none", language };

  const canonical = summary.canonical;
  const title = canonical.replace(/_/g, " ");
  const url = summary.url ?? `https://${language}.wikipedia.org/wiki/${encodeURIComponent(canonical)}`;

  if (summary.type === "disambiguation") return { kind: "disambiguation", title, language, url };
  return { kind: "article", canonical, title, language, url, description: summary.description };
}

export type Granularity = "monthly" | "daily";

export interface PageviewPoint {
  /** `YYYY-MM` for a monthly point, `YYYY-MM-DD` for a daily one. */
  period: string;
  views: number;
}

export interface PageviewSeries {
  /** Oldest first. A period the API returned no row for is absent. */
  points: PageviewPoint[];
  /** What was asked for, as `YYYYMMDD`, so the Tool can say so. */
  start: string;
  end: string;
}

/**
 * Human pageviews for one article over a window, every device combined.
 *
 * `start` and `end` are `YYYYMMDD`. An empty series is an answer: the article has
 * no recorded views in the window.
 *
 * @throws {UpstreamApiError} when the API refuses or fails.
 */
export function readPageviews(
  article: { canonical: string; language: string },
  granularity: Granularity,
  start: string,
  end: string,
): Promise<PageviewSeries> {
  const key = `${article.language} ${article.canonical} ${granularity} ${start} ${end}`;
  return viewsCache.run(key, async () => {
    const url =
      "https://wikimedia.org/api/rest_v1/metrics/pageviews/per-article/" +
      `${article.language}.wikipedia.org/all-access/user/${encodeURIComponent(article.canonical)}/` +
      `${granularity}/${start}00/${end}00`;
    const answer = await callApi(PAGEVIEWS, { url });
    if (answer.kind === "no-data") return { points: [], start, end };
    return { points: readItems(answer.body, granularity), start, end };
  });
}

/** Exported for its test. A row without a readable timestamp or count is dropped, never zeroed. */
export function readItems(payload: unknown, granularity: Granularity): PageviewPoint[] {
  const items = isRecord(payload) && Array.isArray(payload.items) ? payload.items : [];
  const points: PageviewPoint[] = [];
  for (const item of items) {
    if (!isRecord(item)) continue;
    const { timestamp, views } = item;
    if (typeof timestamp !== "string" || !/^\d{8,10}$/.test(timestamp)) continue;
    if (typeof views !== "number" || !Number.isFinite(views) || views < 0) continue;
    const month = `${timestamp.slice(0, 4)}-${timestamp.slice(4, 6)}`;
    points.push({
      period: granularity === "monthly" ? month : `${month}-${timestamp.slice(6, 8)}`,
      views,
    });
  }
  return points;
}
