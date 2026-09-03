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
