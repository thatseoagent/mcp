/**
 * The Chrome UX Report History API: field data as a series rather than a reading.
 *
 * `pagespeed_insights` reports CrUX as one number per vital — the p75 over the
 * last 28 days. That answers "is this page fast?" and cannot answer the question
 * an Operator asks after shipping a fix, which is "did it move?". The History API
 * returns the same measurement for each of up to 40 weekly collection periods —
 * the most it serves, about nine months — so the answer is on the page instead
 * of in a note to check back in a month. This module asked for the API's
 * default, 25, until 2026-09, which put a fix shipped six months earlier just
 * outside the series it was meant to show.
 *
 * ── What a point in the series is ──
 *
 * **Each point is a 28-day window, and the windows end a week apart.** So
 * neighbouring points share three of their four weeks, and a change that took
 * effect on one day arrives over four points rather than as a step. A reader who
 * treats the series as 40 independent weekly readings will see a trend in what
 * is mostly overlap, and a report that did not say so would invite exactly that.
 *
 * ── What it shares with `crux-record.ts` ──
 *
 * The key, the quota, the 404 convention, the number formats and the list of
 * metrics are common to both CrUX endpoints and live in `crux-record.ts`, which
 * this module reads through. The requirement and the form factor are re-exported
 * from here so the callers that already name them keep working.
 *
 * ── Diagnostics, as a series ──
 *
 * The History API serves the same diagnostic metrics as the daily one — the LCP
 * image parts, the LCP element type, navigation types, round trip time — and
 * they answer the question after "did LCP move?", which is "which part of it
 * moved?". They are read into their own shape because they are not rated: see
 * `crux-record.ts` for why nothing here puts a threshold on them. The fractional
 * ones arrive as `fractionTimeseries` (`{label: {fractions: [...]}}`) rather than
 * as a histogram, and a period without one is `"NaN"` in every array.
 */
import { isRecord } from "./type-guards";
import { createSingleFlightCache } from "./single-flight";
import {
  cruxDate,
  cruxNumber,
  cruxRecordSubject,
  cruxSubjectOf,
  queryCrux,
  LCP_SUBPARTS,
  RATED_METRICS,
  type CruxDiagnostics,
  type CruxQuery,
  type FormFactor,
  type LcpSubpart,
} from "./crux-record";
import type { VitalKey } from "./analyzers/vital-thresholds";

export { CRUX_KEY_REQUIREMENT, type CruxQuery, type FormFactor } from "./crux-record";

const ENDPOINT = "https://chromeuxreport.googleapis.com/v1/records:queryHistoryRecord";

/**
 * How many weekly periods to ask for: the API's maximum.
 *
 * The request costs the same whatever the count, and a longer series is the
 * one that still contains the week a fix shipped. A subject CrUX has tracked
 * for less time simply comes back shorter, with `null` for the periods before.
 */
export const COLLECTION_PERIOD_COUNT = 40;

export interface CruxSeries {
  key: VitalKey;
  /** p75 per collection period, oldest first. `null` where CrUX had too few samples. */
  p75s: Array<number | null>;
  /** The share of visits in the "good" bucket per period, 0–1, or `null`. */
  goodShares: Array<number | null>;
}

/**
 * The unrated metrics, one value per collection period, oldest first.
 *
 * The same four readings {@link CruxDiagnostics} holds for one point, as
 * arrays; {@link diagnosticsAt} takes one point back out of them.
 */
export interface CruxDiagnosticSeries {
  lcpSubparts: Array<{ part: LcpSubpart; p75s: Array<number | null> }>;
  lcpResourceType: Record<string, Array<number | null>>;
  navigationTypes: Record<string, Array<number | null>>;
  roundTripTime: Array<number | null>;
}

export interface CruxHistory {
  /** What CrUX actually looked up, after its own normalisation of the URL. */
  subject: string;
  scope: "page" | "origin";
  formFactor: FormFactor | "ALL";
  /** The last day of each collection period, `YYYY-MM-DD`, oldest first. */
  periodEnds: string[];
  series: CruxSeries[];
  diagnostics: CruxDiagnosticSeries;
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
  const subject = cruxSubjectOf(query);
  const formFactor = query.formFactor ?? "ALL";
  const key = `${query.scope} ${subject} ${formFactor}`;
  return historyCache.run(key, async () => {
    const payload = await queryCrux(ENDPOINT, {
      [query.scope === "origin" ? "origin" : "url"]: subject,
      ...(query.formFactor ? { formFactor: query.formFactor } : {}),
      collectionPeriodCount: COLLECTION_PERIOD_COUNT,
    });
    if (payload === null) return { kind: "no-data", subject, scope: query.scope, formFactor };
    return readHistory(payload, query.scope, subject, formFactor);
  });
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

  const periods = Array.isArray(record.collectionPeriods) ? record.collectionPeriods : [];
  const periodEnds = periods.map((period) =>
    isRecord(period) ? cruxDate(period.lastDate) : "unknown",
  );

  const metrics = isRecord(record.metrics) ? record.metrics : {};
  const series: CruxSeries[] = [];
  for (const [apiName, key] of RATED_METRICS) {
    const metric = metrics[apiName];
    if (!isRecord(metric)) continue;
    const histogram = Array.isArray(metric.histogramTimeseries) ? metric.histogramTimeseries : [];
    // The first bin is "good": CrUX's bins are the three rating buckets, in order.
    const firstBin = isRecord(histogram[0]) ? histogram[0] : {};
    const goodShares = Array.isArray(firstBin.densities) ? firstBin.densities.map(cruxNumber) : [];
    series.push({ key, p75s: p75sOf(metric), goodShares });
  }

  return {
    kind: "history",
    history: {
      subject: cruxRecordSubject(record, asked),
      scope,
      formFactor,
      periodEnds,
      series,
      diagnostics: {
        lcpSubparts: LCP_SUBPARTS.map(({ metric, part }) => ({ part, p75s: p75sOf(metrics[metric]) })),
        lcpResourceType: fractionSeriesOf(metrics.largest_contentful_paint_resource_type),
        navigationTypes: fractionSeriesOf(metrics.navigation_types),
        roundTripTime: p75sOf(metrics.round_trip_time),
      },
    },
  };
}

function p75sOf(metric: unknown): Array<number | null> {
  if (!isRecord(metric)) return [];
  const percentiles = isRecord(metric.percentilesTimeseries) ? metric.percentilesTimeseries : {};
  return Array.isArray(percentiles.p75s) ? percentiles.p75s.map(cruxNumber) : [];
}

/** `{label: {fractions: [...]}}`, as label → one share per period. */
function fractionSeriesOf(metric: unknown): Record<string, Array<number | null>> {
  if (!isRecord(metric) || !isRecord(metric.fractionTimeseries)) return {};
  const out: Record<string, Array<number | null>> = {};
  for (const [label, entry] of Object.entries(metric.fractionTimeseries)) {
    if (isRecord(entry) && Array.isArray(entry.fractions)) out[label] = entry.fractions.map(cruxNumber);
  }
  return out;
}

/** The diagnostics at one period of the series, in the one-point shape `describeDiagnostics` reads. */
export function diagnosticsAt(series: CruxDiagnosticSeries, index: number): CruxDiagnostics {
  const at = (values: Array<number | null> | undefined) => values?.[index] ?? null;
  const each = (byLabel: Record<string, Array<number | null>>) =>
    Object.fromEntries(Object.entries(byLabel).map(([label, values]) => [label, at(values)]));
  return {
    lcpSubparts: series.lcpSubparts.map(({ part, p75s }) => ({ part, p75: at(p75s) })),
    lcpResourceType: each(series.lcpResourceType),
    navigationTypes: each(series.navigationTypes),
    roundTripTime: at(series.roundTripTime),
  };
}
