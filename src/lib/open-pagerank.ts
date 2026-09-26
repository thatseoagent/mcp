/**
 * Open PageRank: a 0–10 link-authority score per domain, computed by a third
 * party from the Common Crawl web graph.
 *
 * It is **not a Google metric**. Open PageRank runs the PageRank idea over
 * Common Crawl's public domain-to-domain link graph, combines it with an
 * authority-weighted count of referring domains, and publishes the result on a
 * logarithmic 0–10 scale. What it is good for here is comparison: the same
 * yardstick held against a site and its competitors. Their own methodology page
 * states the limits the Tool repeats — coverage follows Common Crawl, a new or
 * crawler-blocking site reads low, and it measures links rather than traffic.
 *
 * ── The API this is written to (read 2026-09-24) ──
 *
 * The service moved to `openpagerank.keywordseverywhere.com` and changed shape.
 * The older `GET /api/v1.0/getPageRank` with an `API-OPR` header and
 * `page_rank_decimal` / `status_code` fields now answers 404 on the new host, and
 * the old `openpagerank.com` redirects there. The current contract, from the docs
 * and the OpenAPI spec at `/v1/openapi.json`:
 *
 * - `POST /v1/domains/bulk`, `Authorization: Bearer <key>`, body
 *   `{ domains: string[], include_history?: boolean }`, up to 100 domains.
 * - Each result has `domain` (the registered domain the input reduced to),
 *   `found`, `open_page_rank` (0–10, two decimals, `null` when not found),
 *   `rank` (global position, 1 is highest), `referring_domains`, and a monthly
 *   `history` of `{ date, open_page_rank, estimated }`. A subdomain input adds a
 *   `hosts` entry on its root domain's result, with its own score.
 * - The response carries `as_of`, the data release's date.
 * - 401 for a missing or wrong key, 429 for the monthly domain allowance or the
 *   per-minute rate, both with a JSON `error` we do not forward.
 *
 * Every unique domain counts once against a monthly allowance (30,000 free),
 * history or not, so history is asked for: it costs nothing more and gives a
 * year-ago figure to compare with.
 */
import type { ConfigRequirement } from "./required-config";
import { callApi, type ThirdPartyService } from "./third-party-api";
import { createSingleFlightCache } from "./single-flight";
import { isRecord } from "./type-guards";

export const OPEN_PAGERANK_REQUIREMENT: ConfigRequirement = {
  variable: "OPEN_PAGERANK_API_KEY",
  purpose: "call the Open PageRank API, which scores domains from the Common Crawl link graph",
  howToGet:
    "Sign in at https://openpagerank.keywordseverywhere.com/dashboard with a Keywords Everywhere " +
    "API key (a free one is offered on that page) and create an OPR API key there. The free plan " +
    "covers 30,000 domain lookups a month at 60 requests a minute, with no card.",
};

const OPEN_PAGERANK = {
  name: "The Open PageRank API",
  key: { requirement: OPEN_PAGERANK_REQUIREMENT, in: "bearer" },
  timeoutMs: 15_000,
  // The free plan's 60 requests a minute, the figure the dashboard states and
  // the requirement above repeats (https://openpagerank.keywordseverywhere.com/docs).
  // Its 429 is also the monthly allowance, which waiting cannot help; this
  // keeps the per-minute one from ever being what it means.
  perMinute: 60,
} satisfies ThirdPartyService;

const ENDPOINT = "https://openpagerank.keywordseverywhere.com/v1/domains/bulk";

export interface ScorePoint {
  /** `YYYY-MM-DD`, the first of a month. */
  date: string;
  score: number;
  /** True for a month without a Common Crawl release, interpolated by Open PageRank. */
  estimated: boolean;
}

export interface HostScore {
  host: string;
  found: boolean;
  score: number | null;
  rank: number | null;
}

export interface DomainScore {
  domain: string;
  found: boolean;
  /** 0–10, or `null` when the domain is not in their dataset — never 0 for that. */
  score: number | null;
  rank: number | null;
  referringDomains: number | null;
  history: ScorePoint[];
  hosts: HostScore[];
}

export interface PageRankRead {
  /** The data release, `YYYY-MM-DD`, or `null` when the response did not say. */
  asOf: string | null;
  results: DomainScore[];
}

const cache = createSingleFlightCache<PageRankRead>();

/**
 * Scores for up to 100 hosts, in one request.
 *
 * @throws {MissingConfigError} before any request, when no key is configured.
 * @throws {UpstreamApiError} when the API refuses, is over quota, or fails.
 */
export function readOpenPageRank(hosts: string[]): Promise<PageRankRead> {
  return cache.run(hosts.join(" "), async () => {
    const { body } = await callApi(OPEN_PAGERANK, {
      url: ENDPOINT,
      json: { domains: hosts, include_history: true },
    });
    return readBulk(body);
  });
}

/** Exported for its test, against the documented payload. */
export function readBulk(payload: unknown): PageRankRead {
  const data = isRecord(payload) ? payload : {};
  const results = Array.isArray(data.results) ? data.results : [];
  return {
    asOf: typeof data.as_of === "string" ? data.as_of : null,
    results: results.filter(isRecord).flatMap((row) => {
      if (typeof row.domain !== "string") return [];
      const score = toScore(row.open_page_rank);
      return [
        {
          domain: row.domain.toLowerCase(),
          // `found` and the score must agree: a "found" row with no readable score
          // is printed as not ranked rather than as a number we made up.
          found: row.found === true && score !== null,
          score,
          rank: toCount(row.rank),
          referringDomains: toCount(row.referring_domains),
          history: readHistory(row.history),
          hosts: Array.isArray(row.hosts) ? row.hosts.filter(isRecord).flatMap(readHost) : [],
        },
      ];
    }),
  };
}

function readHost(row: Record<string, unknown>): HostScore[] {
  if (typeof row.host !== "string") return [];
  const score = toScore(row.open_page_rank);
  return [{ host: row.host.toLowerCase(), found: row.found === true && score !== null, score, rank: toCount(row.rank) }];
}

function readHistory(value: unknown): ScorePoint[] {
  if (!Array.isArray(value)) return [];
  return value.filter(isRecord).flatMap((point) => {
    const score = toScore(point.open_page_rank);
    if (typeof point.date !== "string" || score === null) return [];
    return [{ date: point.date, score, estimated: point.estimated === true }];
  });
}

/** A score on their scale, or `null` — never `NaN`, never a zero for "missing". */
function toScore(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 10 ? value : null;
}

function toCount(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : null;
}
