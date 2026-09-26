/**
 * What Search Console rows mean, separated from the Tools that print them.
 *
 * Every function here is pure: rows in, findings out. That is what lets fifteen
 * Tools share one set of thresholds instead of each carrying its own copy — the
 * retired product had the position window for a quick win written out in three
 * places, and they had drifted.
 *
 * ── The rule these all obey ──
 *
 * A finding is a description of the rows, never a verdict about the site. Search
 * Console shows a sample, lags by days, and withholds queries it considers
 * personal, so "no cannibalization found" means "none in these rows" and the
 * Tools say so. Where a threshold is ours rather than Google's, it is named as
 * ours at the point it is applied.
 */
import type { SearchAnalyticsRow } from "./reader";

/** A row's first dimension value, which is the one every grouping keys on. */
export function keyOf(row: SearchAnalyticsRow, index = 0): string {
  return row.keys?.[index] ?? "(none)";
}

export interface Totals {
  clicks: number;
  impressions: number;
  ctr: number;
  position: number;
}

/**
 * Roll rows up into one set of totals.
 *
 * CTR and position are **recomputed**, never averaged across rows. Averaging
 * position gives every query equal weight regardless of how often it was seen,
 * so one impression at rank 90 drags the site's average down as hard as ten
 * thousand at rank 3. Google's own average is impression-weighted and this
 * matches it.
 */
export function totalsOf(rows: readonly SearchAnalyticsRow[]): Totals {
  const clicks = rows.reduce((sum, row) => sum + row.clicks, 0);
  const impressions = rows.reduce((sum, row) => sum + row.impressions, 0);
  const weighted = rows.reduce((sum, row) => sum + row.position * row.impressions, 0);

  return {
    clicks,
    impressions,
    ctr: impressions > 0 ? clicks / impressions : 0,
    position: impressions > 0 ? weighted / impressions : 0,
  };
}

// ── Quick wins ───────────────────────────────────────────────────────────────

export interface QuickWinsConfig {
  minImpressions: number;
  /** As a percentage, because that is how a person says it. */
  maxCtr: number;
  positionMin: number;
  positionMax: number;
  targetCtr: number;
}

/**
 * What counts as a quick win, and every number here is **ours**.
 *
 * Google publishes no such notion. The shape being looked for is a query that is
 * already being seen a lot, sits just below the fold, and is not being clicked —
 * because that combination is usually a title and description problem rather
 * than a ranking problem, and a title is something an Operator can change this
 * afternoon.
 *
 * Positions 4 to 10: above 4 the CTR is already what it is going to be, and
 * below 10 the page is not on the first screen, so a better title changes
 * nothing. 5% as the target CTR is a modest number for a first-page result and
 * deliberately not an ambitious one — the estimate below is meant to be a floor.
 */
export const DEFAULT_QUICK_WINS: QuickWinsConfig = {
  minImpressions: 50,
  maxCtr: 2.0,
  positionMin: 4,
  positionMax: 10,
  targetCtr: 5.0,
};

export interface QuickWin {
  query: string;
  impressions: number;
  clicks: number;
  ctr: number;
  position: number;
  /** How many more clicks the target CTR would imply. A floor, not a forecast. */
  potentialClicks: number;
}

/**
 * Queries worth rewriting a title for.
 *
 * Ranked by potential clicks rather than by impressions: the point is the size
 * of the gap, and a query with a million impressions already converting well is
 * not an opportunity.
 */
export function quickWins(
  rows: readonly SearchAnalyticsRow[],
  config: QuickWinsConfig = DEFAULT_QUICK_WINS,
): QuickWin[] {
  return rows
    .filter(
      (row) =>
        row.impressions >= config.minImpressions &&
        row.ctr * 100 <= config.maxCtr &&
        row.position >= config.positionMin &&
        row.position <= config.positionMax,
    )
    .map((row) => ({
      query: keyOf(row),
      impressions: row.impressions,
      clicks: row.clicks,
      ctr: row.ctr,
      position: row.position,
      potentialClicks: Math.max(
        0,
        Math.round(row.impressions * (config.targetCtr / 100) - row.clicks),
      ),
    }))
    .sort((a, b) => b.potentialClicks - a.potentialClicks);
}

// ── Cannibalization ──────────────────────────────────────────────────────────

export interface Cannibalization {
  query: string;
  pages: Array<{ page: string; clicks: number; impressions: number; position: number }>;
  /** The best position any of these pages reached. */
  bestPosition: number;
}

/**
 * Queries where more than one page of the site competes.
 *
 * ── Why the impression floor, and why it is not zero ──
 *
 * Two pages both appearing once for a long-tail query is not cannibalization; it
 * is Google trying things. Requiring each competing page to clear a floor is what
 * separates a pattern from noise, and without it a large site reports thousands
 * of "conflicts" that no one can act on.
 *
 * ── What this cannot tell you ──
 *
 * That two pages appear for one query is a fact. That they are *competing* is an
 * interpretation, and often a wrong one: a category page and a product page
 * ranking for the same term is usually correct. The Tools say this rather than
 * presenting the list as a defect.
 *
 * Takes rows dimensioned `["query", "page"]`.
 */
export function cannibalization(
  rows: readonly SearchAnalyticsRow[],
  minImpressionsPerPage = 10,
): Cannibalization[] {
  const byQuery = new Map<string, Cannibalization["pages"]>();

  for (const row of rows) {
    if (row.impressions < minImpressionsPerPage) continue;
    const query = keyOf(row, 0);
    const page = keyOf(row, 1);
    byQuery.set(query, [
      ...(byQuery.get(query) ?? []),
      { page, clicks: row.clicks, impressions: row.impressions, position: row.position },
    ]);
  }

  return [...byQuery.entries()]
    .filter(([, pages]) => pages.length > 1)
    .map(([query, pages]) => ({
      query,
      pages: [...pages].sort((a, b) => b.impressions - a.impressions),
      bestPosition: Math.min(...pages.map((page) => page.position)),
    }))
    .sort((a, b) => b.pages.length - a.pages.length);
}

// ── Comparing two windows ────────────────────────────────────────────────────

export interface Movement {
  key: string;
  now: Totals;
  before: Totals;
  clicksChange: number;
  impressionsChange: number;
  /** Positive means the page moved *down* the results. See the Tools' wording. */
  positionChange: number;
}

/**
 * The same keys measured in two windows, paired up.
 *
 * A key present in only one window is included, with zeroes on the other side,
 * because that is the interesting case — a query that appeared or vanished is
 * the finding, not an edge case to drop. What the Tools must not do is call a
 * missing key "zero traffic": Search Console withholds low-volume and personal
 * queries, so absence has more than one cause.
 */
export function compareWindows(
  now: readonly SearchAnalyticsRow[],
  before: readonly SearchAnalyticsRow[],
): Movement[] {
  const nowBy = new Map(now.map((row) => [keyOf(row), row]));
  const beforeBy = new Map(before.map((row) => [keyOf(row), row]));
  const zero: Totals = { clicks: 0, impressions: 0, ctr: 0, position: 0 };

  const keys = new Set([...nowBy.keys(), ...beforeBy.keys()]);
  const movements: Movement[] = [];

  for (const key of keys) {
    const a = nowBy.get(key);
    const b = beforeBy.get(key);
    const nowTotals = a ? totalsOf([a]) : zero;
    const beforeTotals = b ? totalsOf([b]) : zero;

    movements.push({
      key,
      now: nowTotals,
      before: beforeTotals,
      clicksChange: nowTotals.clicks - beforeTotals.clicks,
      impressionsChange: nowTotals.impressions - beforeTotals.impressions,
      // Only meaningful when both windows have a position. A key absent from one
      // has no rank there, and subtracting from zero would report a query that
      // just appeared at rank 12 as having fallen twelve places.
      positionChange:
        a && b ? nowTotals.position - beforeTotals.position : Number.NaN,
    });
  }

  return movements;
}

/** Keys that had traffic before and have none now. */
export function lost(movements: readonly Movement[], minImpressionsBefore = 20): Movement[] {
  return movements
    .filter(
      (movement) =>
        movement.before.impressions >= minImpressionsBefore && movement.now.impressions === 0,
    )
    .sort((a, b) => b.before.clicks - a.before.clicks);
}

/** Keys that moved most, in either direction, by clicks. */
export function biggestMovers(movements: readonly Movement[], minClicks = 5): Movement[] {
  return movements
    .filter((movement) => Math.max(movement.now.clicks, movement.before.clicks) >= minClicks)
    .sort((a, b) => Math.abs(b.clicksChange) - Math.abs(a.clicksChange));
}

// ── Anomalies ────────────────────────────────────────────────────────────────

export interface Anomaly {
  date: string;
  clicks: number;
  /** How many standard deviations from the window's mean. */
  deviations: number;
}

/**
 * Days that do not look like the rest of the window.
 *
 * A standard-deviation test, which is the crudest thing that works and is chosen
 * for exactly that reason: anything cleverer needs assumptions about seasonality
 * that a single Search Console window cannot support, and would present a
 * confident answer built on them.
 *
 * Two guards on the arithmetic. A window with fewer than
 * {@link MIN_DAYS_FOR_ANOMALY} days produces no findings at all, because a mean
 * over four days is not a baseline. And a window where every day is identical has
 * no deviation to divide by, so it reports nothing rather than dividing by zero
 * and calling every day infinitely anomalous.
 *
 * Takes rows dimensioned `["date"]`.
 */
export const MIN_DAYS_FOR_ANOMALY = 14;

export function anomalies(rows: readonly SearchAnalyticsRow[], threshold = 2): Anomaly[] {
  if (rows.length < MIN_DAYS_FOR_ANOMALY) return [];

  const days = rows.map((row) => ({ date: keyOf(row), clicks: row.clicks }));
  const mean = days.reduce((sum, day) => sum + day.clicks, 0) / days.length;
  const variance =
    days.reduce((sum, day) => sum + (day.clicks - mean) ** 2, 0) / days.length;
  const deviation = Math.sqrt(variance);

  if (deviation === 0) return [];

  return days
    .map((day) => ({ ...day, deviations: (day.clicks - mean) / deviation }))
    .filter((day) => Math.abs(day.deviations) >= threshold)
    .sort((a, b) => Math.abs(b.deviations) - Math.abs(a.deviations));
}

// ── Branded and unbranded ────────────────────────────────────────────────────

/**
 * Which queries mention the brand.
 *
 * Matched on a word boundary, not a substring: `ex` as a brand term would
 * otherwise claim every query containing "example", "expert" and "next". The
 * terms are supplied by the caller because only they know what their brand is
 * called — deriving it from the domain gets `johndoe` right and `acme-group-uk`
 * wrong, and a wrong split makes both halves of the report meaningless.
 */
export function isBranded(query: string, terms: readonly string[]): boolean {
  const haystack = query.toLowerCase();
  return terms.some((term) => {
    const needle = term.trim().toLowerCase();
    if (needle.length === 0) return false;
    // Escaped, because a brand can legitimately contain `.` or `+`.
    const escaped = needle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return new RegExp(`(^|[^a-z0-9])${escaped}([^a-z0-9]|$)`, "i").test(haystack);
  });
}

export interface BrandedSplit {
  branded: Totals;
  unbranded: Totals;
  brandedQueries: number;
  unbrandedQueries: number;
}

export function brandedSplit(
  rows: readonly SearchAnalyticsRow[],
  terms: readonly string[],
): BrandedSplit {
  const branded = rows.filter((row) => isBranded(keyOf(row), terms));
  const unbranded = rows.filter((row) => !isBranded(keyOf(row), terms));

  return {
    branded: totalsOf(branded),
    unbranded: totalsOf(unbranded),
    brandedQueries: branded.length,
    unbrandedQueries: unbranded.length,
  };
}

// ── Segment gaps ─────────────────────────────────────────────────────────────

export interface SegmentShare {
  segment: string;
  totals: Totals;
  /** This segment's share of impressions, 0 to 1. */
  impressionShare: number;
  /** This segment's CTR against the whole, as a ratio. 1 means the same. */
  ctrRatio: number;
}

/**
 * How each segment performs against the property as a whole.
 *
 * Used for device and country. A ratio rather than a difference, because the
 * question is "is mobile converting like the rest of the site", and a two-point
 * CTR gap means something very different at 3% than at 30%.
 *
 * Segments with no impressions are dropped: a ratio against zero is not a
 * finding, it is a division nobody should print.
 */
export function segmentShares(rows: readonly SearchAnalyticsRow[]): SegmentShare[] {
  const whole = totalsOf(rows);

  return rows
    .filter((row) => row.impressions > 0)
    .map((row) => {
      const totals = totalsOf([row]);
      return {
        segment: keyOf(row),
        totals,
        impressionShare: whole.impressions > 0 ? totals.impressions / whole.impressions : 0,
        ctrRatio: whole.ctr > 0 ? totals.ctr / whole.ctr : 0,
      };
    })
    .sort((a, b) => b.totals.impressions - a.totals.impressions);
}

// ── Hours ────────────────────────────────────────────────────────────────────

export interface HourKey {
  /** `YYYY-MM-DD`, the Pacific day the hour belongs to. */
  date: string;
  /** `00` to `23`, Pacific. */
  hour: string;
  /** Milliseconds since the epoch, for ordering and for comparing with `firstIncompleteHour`. */
  instant: number;
}

/**
 * `2025-04-07T14:00:00-07:00`, read into its day, its hour and its instant.
 *
 * The day and hour are read off the string rather than computed from the
 * instant, because the string is already in Pacific Time and a `Date` would
 * move it into whatever timezone the server runs in. `null` for anything else,
 * so a key that is not an hour is left out rather than parsed into a wrong one.
 */
export function parseHourKey(key: string): HourKey | null {
  const match = /^(\d{4}-\d{2}-\d{2})T(\d{2}):\d{2}:\d{2}(?:[+-]\d{2}:\d{2}|Z)$/.exec(key);
  if (!match) return null;
  const instant = Date.parse(key);
  if (!Number.isFinite(instant)) return null;
  return { date: match[1], hour: match[2], instant };
}

export interface HourReading {
  date: string;
  hour: string;
  clicks: number;
  impressions: number;
  /** At or after Google's first incomplete hour: still being collected, so still rising. */
  partial: boolean;
  /**
   * Mean clicks in the same hour on the earlier days of the window, counting
   * only hours Google has finished. `null` when there is no earlier day to
   * compare with, which is an absence and not a zero.
   */
  baselineClicks: number | null;
  baselineImpressions: number | null;
  /** How many earlier days the baseline is the mean of. */
  baselineDays: number;
  /** Clicks in the same hour exactly seven days earlier, when the window reaches that far. */
  weekAgoClicks: number | null;
}

/**
 * Every hour, with the same hour on the days before it as its baseline.
 *
 * ── Why the same hour, and not the hour before ──
 *
 * Search traffic has a daily shape: three in the morning is quiet everywhere,
 * lunchtime is not. Comparing 14:00 with 13:00 measures that shape, and a deploy
 * at 14:00 on a site whose afternoons are always busier would look like a win
 * every day. Comparing 14:00 today with 14:00 on the previous days holds the
 * shape still, which is what Google's own announcement suggests the hourly data
 * is for — "compare the most recent day to the same day in the previous week".
 *
 * Partial hours are kept, marked, and left out of every baseline: a baseline
 * that averaged in an hour still being counted would be pulled down by it.
 *
 * Takes rows dimensioned `["hour"]`. Rows whose key is not an hour are dropped,
 * and counted by the caller from the difference in lengths.
 */
export function hourlyReadings(
  rows: readonly SearchAnalyticsRow[],
  firstIncompleteHour?: string,
): HourReading[] {
  const incompleteFrom = firstIncompleteHour ? Date.parse(firstIncompleteHour) : Number.NaN;

  const hours = rows
    .map((row) => ({ row, key: parseHourKey(keyOf(row)) }))
    .filter((entry): entry is { row: SearchAnalyticsRow; key: HourKey } => entry.key !== null)
    .map(({ row, key }) => ({
      ...key,
      clicks: row.clicks,
      impressions: row.impressions,
      partial: Number.isFinite(incompleteFrom) && key.instant >= incompleteFrom,
    }))
    .sort((a, b) => a.instant - b.instant);

  const byDateHour = new Map(hours.map((hour) => [`${hour.date} ${hour.hour}`, hour]));

  return hours.map((hour) => {
    const earlier = hours.filter(
      (other) => other.hour === hour.hour && other.date < hour.date && !other.partial,
    );
    const weekAgo = byDateHour.get(`${shiftDay(hour.date, -7)} ${hour.hour}`);
    return {
      date: hour.date,
      hour: hour.hour,
      clicks: hour.clicks,
      impressions: hour.impressions,
      partial: hour.partial,
      baselineClicks: earlier.length > 0 ? mean(earlier.map((other) => other.clicks)) : null,
      baselineImpressions: earlier.length > 0 ? mean(earlier.map((other) => other.impressions)) : null,
      baselineDays: earlier.length,
      weekAgoClicks: weekAgo && !weekAgo.partial ? weekAgo.clicks : null,
    };
  });
}

function mean(values: readonly number[]): number {
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

/** A `YYYY-MM-DD` moved by whole days. */
function shiftDay(date: string, days: number): string {
  const moved = new Date(`${date}T00:00:00Z`);
  moved.setUTCDate(moved.getUTCDate() + days);
  return moved.toISOString().slice(0, 10);
}

// ── Content decay ────────────────────────────────────────────────────────────

export interface DecayConfig {
  /**
   * The peak three-month average, in clicks per month, a page must have had for
   * a fall to count. Below it, a page going from 6 clicks a month to 2 is a
   * 66% decline that nobody should spend an afternoon on.
   */
  minPeakClicks: number;
  /** How far below its peak the last three months must be, as a percentage. */
  minDecline: number;
}

/**
 * What counts as decay, and both numbers are **ours**.
 *
 * Google publishes no notion of content decay. Twenty clicks a month at peak is
 * the smallest page whose loss is worth a line in a report; 40% is a fall large
 * enough not to be a quiet quarter, and small enough to catch a page before it
 * has lost everything.
 */
export const DEFAULT_DECAY: DecayConfig = { minPeakClicks: 20, minDecline: 40 };

/** Three months: long enough to smooth one bad month, short enough to still be "recent". */
export const DECAY_SPAN = 3;

/**
 * Clicks per page per month, from one `["page"]` read per month.
 *
 * A page absent from a month's read is a zero *in these rows*. For pages that
 * is a smaller lie than for queries — Search Console does not anonymise pages —
 * but a page below the read's row limit is absent too, which is why the Tool
 * says which months were truncated.
 */
export function monthlyClicksByPage(
  months: ReadonlyArray<{ month: string; rows: readonly SearchAnalyticsRow[] }>,
): Map<string, number[]> {
  const byPage = new Map<string, number[]>();
  months.forEach(({ rows }, index) => {
    for (const row of rows) {
      const page = keyOf(row);
      const series = byPage.get(page) ?? new Array<number>(months.length).fill(0);
      series[index] += row.clicks;
      byPage.set(page, series);
    }
  });
  return byPage;
}

export type DecayReading =
  /** Down against its own peak, and down against the same months a year earlier. */
  | "decay"
  /** Down against its peak, but the same months last year were about as low. */
  | "seasonal"
  /** Down against its peak, and there is no year-earlier counterpart to tell the two apart. */
  | "unknown";

export interface DecayingPage {
  page: string;
  /** Mean monthly clicks over the best three consecutive months before the last three. */
  peakAverage: number;
  /** `YYYY-MM` of the first month of that peak. */
  peakFrom: string;
  /** Mean monthly clicks over the last three months. */
  recentAverage: number;
  /** 0 to 1: how far below the peak the last three months are. */
  decline: number;
  /**
   * Clicks in the recent months against the same months a year earlier, as a
   * ratio. `null` when the series does not reach back a year for any of them.
   */
  yearOverYear: number | null;
  /** How many of the recent months had a year-earlier counterpart. */
  yearOverYearMonths: number;
  reading: DecayReading;
}

/**
 * When the same months a year earlier count as "about as low".
 *
 * Within 20% of last year's clicks for the same months: a page that did this
 * last year too is following the calendar. Ours, like the thresholds above.
 */
export const SEASONAL_RATIO = 0.8;

/**
 * Pages whose last three months are well below their best three.
 *
 * ── Peak against recent, not first against last ──
 *
 * First month against last would call a page that launched mid-window and grew
 * a success, and a page that spiked once and settled a collapse. The best three
 * consecutive months before the recent three is the page's own high-water mark,
 * and it cannot overlap the months it is compared with.
 *
 * ── Seasonality, as far as sixteen months can tell ──
 *
 * A ski-hire page in July is below its January peak every year. When the series
 * reaches back twelve months for any of the recent months, their clicks are
 * compared with the same months a year earlier: about as low then means the
 * calendar, lower now means decay. With fewer than thirteen months there is no
 * counterpart, and the reading says it cannot tell rather than guessing. Either
 * way it is a heuristic over one page's clicks, not a model of seasonality.
 *
 * @param months `YYYY-MM`, oldest first, the same length as every series.
 */
export function decayingPages(
  months: readonly string[],
  byPage: ReadonlyMap<string, readonly number[]>,
  config: DecayConfig = DEFAULT_DECAY,
): DecayingPage[] {
  // Two spans at least: one to peak in, one to be recent.
  if (months.length < DECAY_SPAN * 2) return [];

  const recentStart = months.length - DECAY_SPAN;
  const findings: DecayingPage[] = [];

  for (const [page, series] of byPage) {
    let peakAverage = 0;
    let peakIndex = -1;
    for (let start = 0; start + DECAY_SPAN <= recentStart; start++) {
      const average = mean(series.slice(start, start + DECAY_SPAN));
      if (average > peakAverage) {
        peakAverage = average;
        peakIndex = start;
      }
    }
    if (peakIndex < 0 || peakAverage < config.minPeakClicks) continue;

    const recentAverage = mean(series.slice(recentStart));
    const decline = 1 - recentAverage / peakAverage;
    if (decline * 100 < config.minDecline) continue;

    let now = 0;
    let before = 0;
    let paired = 0;
    for (let index = recentStart; index < months.length; index++) {
      if (index - 12 < 0) continue;
      now += series[index];
      before += series[index - 12];
      paired++;
    }
    // A year-earlier total of zero is not a baseline: the page may not have
    // existed, and a ratio against nothing is a division nobody should print.
    const yearOverYear = paired > 0 && before > 0 ? now / before : null;
    const reading: DecayReading =
      yearOverYear === null ? "unknown" : yearOverYear >= SEASONAL_RATIO ? "seasonal" : "decay";

    findings.push({
      page,
      peakAverage,
      peakFrom: months[peakIndex],
      recentAverage,
      decline,
      yearOverYear,
      yearOverYearMonths: paired,
      reading,
    });
  }

  // Ranked by clicks lost a month, which is the size of the problem; a 90% fall
  // on a small page matters less than a 45% fall on the busiest one.
  return findings.sort(
    (a, b) => b.peakAverage - b.recentAverage - (a.peakAverage - a.recentAverage),
  );
}
