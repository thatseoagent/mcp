/**
 * The Chrome UX Report History API: field data as a series rather than a reading.
 *
 * `pagespeed_insights` reports CrUX as one number per vital — the p75 over the
 * last 28 days. That answers "is this page fast?" and cannot answer the question
 * an Operator asks after shipping a fix, which is "did it move?". The History API
 * returns the same measurement for each of the last 25 weekly collection periods,
 * so the answer is on the page instead of in a note to check back in a month.
 *
 * ── What a point in the series is ──
 *
 * **Each point is a 28-day window, and the windows end a week apart.** So
 * neighbouring points share three of their four weeks, and a change that took
 * effect on one day arrives over four points rather than as a step. A reader who
 * treats the series as 25 independent weekly readings will see a trend in what
 * is mostly overlap, and a report that did not say so would invite exactly that.
 *
 * ── Why this is its own module ──
 *
 * The key is `PAGESPEED_API_KEY`: a Google Cloud key works for every API enabled
 * on its project, and asking the Operator for a second key for the same console
 * would be a second thing to configure for no gain. What differs is the API it
 * needs enabled, which is why the requirement below is its own sentence rather
 * than `PAGESPEED_KEY_REQUIREMENT` reused — that one tells the Operator to enable
 * the PageSpeed API, and following it would leave this Tool refused with a 403.
 */
import { fetchThirdPartyApi } from "./http-client";
import { requireConfig, type ConfigRequirement } from "./required-config";
import { UpstreamApiError } from "./upstream-api-error";
import { createSingleFlightCache } from "./single-flight";
import { isRecord } from "./type-guards";
import type { VitalKey } from "./analyzers/vital-thresholds";

export const CRUX_KEY_REQUIREMENT: ConfigRequirement = {
  variable: "PAGESPEED_API_KEY",
  purpose: "call Google's Chrome UX Report API, which is where real-user field data comes from",
  howToGet:
    "Create an API key at https://console.cloud.google.com/apis/credentials and enable the " +
    "Chrome UX Report API for its project. The key pagespeed_insights uses works, once that " +
    "API is enabled beside the PageSpeed Insights API; it needs no billing account.",
};

/** How the API is named in a refusal. */
const SERVICE = "Google's Chrome UX Report API";

const ENDPOINT = "https://chromeuxreport.googleapis.com/v1/records:queryHistoryRecord";

/**
 * A bounded request. CrUX answers from a precomputed dataset in well under a
 * second; the ceiling exists because Node's `fetch` has none.
 */
const CRUX_REQUEST_TIMEOUT_MS = 15_000;

export type FormFactor = "PHONE" | "DESKTOP" | "TABLET";

/**
 * The API's metric names, mapped to the keys `vital-thresholds` rates.
 *
 * Only these are read. The response carries others — navigation types, round
 * trip time, form-factor shares — and each would need its own reading; listing
 * the five here is what keeps an unrecognised one from being printed as if it
 * were rated.
 */
const METRICS: ReadonlyArray<[string, VitalKey]> = [
  ["largest_contentful_paint", "lcp"],
  ["interaction_to_next_paint", "inp"],
  ["cumulative_layout_shift", "cls"],
  ["first_contentful_paint", "fcp"],
  ["experimental_time_to_first_byte", "ttfb"],
];

export interface CruxQuery {
  /** A page URL or an origin, according to `scope`. */
  url: string;
  scope: "page" | "origin";
  /** Omitted: every device combined, which is what the API reports by default. */
  formFactor?: FormFactor;
}

export interface CruxSeries {
  key: VitalKey;
  /** p75 per collection period, oldest first. `null` where CrUX had too few samples. */
  p75s: Array<number | null>;
  /** The share of visits in the "good" bucket per period, 0–1, or `null`. */
  goodShares: Array<number | null>;
}

export interface CruxHistory {
  /** What CrUX actually looked up, after its own normalisation of the URL. */
  subject: string;
  scope: "page" | "origin";
  formFactor: FormFactor | "ALL";
  /** The last day of each collection period, `YYYY-MM-DD`, oldest first. */
  periodEnds: string[];
  series: CruxSeries[];
}

/**
 * Either the history, or CrUX's definite answer that it has none.
 *
 * `no-data` is a result, not a failure: CrUX reports on a page or origin only
 * once it has enough Chrome traffic, and saying so is the correct and complete
 * answer for most pages. It is the same stance `pagespeed_insights` takes on
 * absent field data.
 */
export type CruxHistoryResult =
  | { kind: "history"; history: CruxHistory }
  | { kind: "no-data"; subject: string; scope: "page" | "origin"; formFactor: FormFactor | "ALL" };

const historyCache = createSingleFlightCache<CruxHistoryResult>();

/**
 * Read the field-data history for a page or an origin.
 *
 * @throws {MissingConfigError} when no key is configured, before any request.
 * @throws {UpstreamApiError} when the API answers with anything but data or a
 *         definite "no data".
 */
export function readCruxHistory(query: CruxQuery): Promise<CruxHistoryResult> {
  const subject = subjectOf(query);
  const key = `${query.scope} ${subject} ${query.formFactor ?? "ALL"}`;
  return historyCache.run(key, () => fetchHistory(query, subject));
}

/** The origin, when asked for one: CrUX refuses an origin with a path on it. */
function subjectOf(query: CruxQuery): string {
  return query.scope === "origin" ? new URL(query.url).origin : query.url;
}

async function fetchHistory(query: CruxQuery, subject: string): Promise<CruxHistoryResult> {
  const apiKey = requireConfig(CRUX_KEY_REQUIREMENT);
  const formFactor = query.formFactor ?? "ALL";

  const apiUrl = new URL(ENDPOINT);
  apiUrl.searchParams.set("key", apiKey);

  const response = await fetchThirdPartyApi(apiUrl.toString(), {
    timeout: CRUX_REQUEST_TIMEOUT_MS,
    json: {
      [query.scope === "origin" ? "origin" : "url"]: subject,
      ...(query.formFactor ? { formFactor: query.formFactor } : {}),
    },
  });

  // 404 is how CrUX says "not enough traffic to report on" — its documented
  // answer for a page or origin below its threshold, not a missing endpoint.
  if (response.status === 404) {
    await response.body?.cancel();
    return { kind: "no-data", subject, scope: query.scope, formFactor };
  }
  if (!response.ok) {
    throw await UpstreamApiError.fromResponse(SERVICE, response);
  }

  return readHistory(await response.json(), query.scope, subject, formFactor);
}

/**
 * The response, read defensively and separated from the fetch so it can be
 * tested against a captured payload.
 *
 * Exported for that test alone.
 */
export function readHistory(
  payload: unknown,
  scope: "page" | "origin",
  asked: string,
  formFactor: FormFactor | "ALL",
): CruxHistoryResult {
  const data = isRecord(payload) ? payload : {};
  const record = isRecord(data.record) ? data.record : null;
  if (!record) return { kind: "no-data", subject: asked, scope, formFactor };

  const recordKey = isRecord(record.key) ? record.key : {};
  const subject =
    typeof recordKey.url === "string"
      ? recordKey.url
      : typeof recordKey.origin === "string"
        ? recordKey.origin
        : asked;

  const periods = Array.isArray(record.collectionPeriods) ? record.collectionPeriods : [];
  const periodEnds = periods.map((period) =>
    isRecord(period) ? formatDate(period.lastDate) : "unknown",
  );

  const metrics = isRecord(record.metrics) ? record.metrics : {};
  const series: CruxSeries[] = [];
  for (const [apiName, key] of METRICS) {
    const metric = metrics[apiName];
    if (!isRecord(metric)) continue;
    const percentiles = isRecord(metric.percentilesTimeseries) ? metric.percentilesTimeseries : {};
    const p75s = Array.isArray(percentiles.p75s) ? percentiles.p75s.map(toNumber) : [];
    const histogram = Array.isArray(metric.histogramTimeseries) ? metric.histogramTimeseries : [];
    // The first bin is "good": CrUX's bins are the three rating buckets, in order.
    const firstBin = isRecord(histogram[0]) ? histogram[0] : {};
    const goodShares = Array.isArray(firstBin.densities) ? firstBin.densities.map(toNumber) : [];
    series.push({ key, p75s, goodShares });
  }

  return {
    kind: "history",
    history: { subject, scope, formFactor, periodEnds, series },
  };
}

/**
 * A reading, or `null` for a period without one.
 *
 * CrUX writes a missing p75 as `null` and a missing density as the string
 * `"NaN"`, and writes CLS's p75 as a string ("0.05") because it is not an
 * integer. One reader for all three, so none of them becomes a zero — which would
 * be a perfect CLS or an instant LCP in a period where nothing was measured.
 */
function toNumber(value: unknown): number | null {
  const parsed = typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
  return Number.isFinite(parsed) ? parsed : null;
}

function formatDate(date: unknown): string {
  if (!isRecord(date)) return "unknown";
  const { year, month, day } = date;
  if (typeof year !== "number" || typeof month !== "number" || typeof day !== "number") {
    return "unknown";
  }
  return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}
