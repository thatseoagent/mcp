/**
 * What a Site's numbers were, run after run.
 *
 * History is the only reason this server has a database. A single audit is
 * something the credential-free Tools already produce; what they cannot answer
 * is "is this better than last month", and that question is why an Operator
 * keeps a server running rather than pasting a URL into a web form.
 *
 * ── The registry, and why it is closed ──
 *
 * A metric is a dotted key from {@link METRICS} and nothing else. The
 * alternative — any string a caller passes — produces `geo.score`,
 * `geoScore` and `geo_score` in one table within a year, and a trend query
 * that quietly covers a third of the history. Adding a metric means adding it
 * here, where its label and its direction live too.
 *
 * ── `null` and absent are different, and neither is zero ──
 *
 * A row with `value = null` means the section ran and could not answer. **No
 * row** means the section did not run. Neither is ever written as `0`: a
 * timed-out PageSpeed recorded as "performance: 0" is an invented collapse, and
 * a trend built on it shows a cliff that never happened.
 */
import { and, desc, eq, gte, sql } from "drizzle-orm";
import { siteMetricHistory, siteMetricMonthly, type SiteMetricReading } from "./db/schema";
import { now } from "./db/instants";
import { database } from "./db/runtime";

/** Which way is better, for a metric whose movement is being described. */
export type Direction = "up-is-better" | "down-is-better";

export interface MetricDefinition {
  key: string;
  label: string;
  direction: Direction;
  /** How to render a value, when it is not a bare number. */
  unit?: "percent" | "score" | "count" | "seconds";
}

/**
 * Every metric the audit records.
 *
 * Deliberately small. Each one has to be a number an Operator would recognise
 * and act on; a metric nobody reads is a column that makes the table slower and
 * the report longer.
 */
export const METRICS: readonly MetricDefinition[] = [
  { key: "gsc.clicks", label: "Search clicks", direction: "up-is-better", unit: "count" },
  { key: "gsc.impressions", label: "Search impressions", direction: "up-is-better", unit: "count" },
  { key: "gsc.ctr", label: "Search CTR", direction: "up-is-better", unit: "percent" },
  { key: "gsc.position", label: "Average position", direction: "down-is-better", unit: "score" },
  { key: "ga4.sessions", label: "Sessions", direction: "up-is-better", unit: "count" },
  { key: "ga4.aiSessions", label: "AI assistant sessions", direction: "up-is-better", unit: "count" },
  { key: "geo.score", label: "GEO score", direction: "up-is-better", unit: "score" },
  { key: "eeat.score", label: "E-E-A-T score", direction: "up-is-better", unit: "score" },
  { key: "security.score", label: "Security header score", direction: "up-is-better", unit: "score" },
] as const;

const BY_KEY = new Map(METRICS.map((metric) => [metric.key, metric]));

export function metricDefinition(key: string): MetricDefinition | null {
  return BY_KEY.get(key) ?? null;
}

/** One number an audit measured, or the fact that it could not measure it. */
export interface Reading {
  metric: string;
  /** `null` when the section ran and could not answer. Never `0` for that. */
  value: number | null;
  grade?: string | null;
}

/**
 * Store the readings from one audit run.
 *
 * `refreshId` is carried so a re-run against the same refresh replaces rather
 * than duplicates — the unique index on `(refresh_id, metric)` is what enforces
 * that. Rows whose refresh is later purged hold `null` there and are exempt,
 * which is correct: nothing writes a reading for a refresh that no longer
 * exists.
 *
 * A reading whose metric is not in the registry is dropped rather than stored.
 * Storing it would put a key in the table that no trend query will ever ask for,
 * which is worse than losing it: it looks like history and is not.
 */
export function recordReadings(
  siteId: string,
  refreshId: string | null,
  readings: readonly Reading[],
  capturedAt = now(),
): number {
  const db = database();
  if (!db) return 0;

  const rows = readings
    .filter((reading) => BY_KEY.has(reading.metric))
    .map((reading) => ({
      siteId,
      refreshId,
      capturedAt,
      metric: reading.metric,
      value: reading.value,
      grade: reading.grade ?? null,
    }));

  if (rows.length === 0) return 0;

  db.insert(siteMetricHistory)
    .values(rows)
    .onConflictDoUpdate({
      target: [siteMetricHistory.refreshId, siteMetricHistory.metric],
      set: { value: sql`excluded.value`, grade: sql`excluded.grade`, capturedAt },
    })
    .run();

  return rows.length;
}

/** Every reading of one metric for one Site, newest first. */
export function readSeries(siteId: string, metric: string, since?: Date): SiteMetricReading[] {
  const db = database();
  if (!db) return [];

  return db
    .select()
    .from(siteMetricHistory)
    .where(
      and(
        eq(siteMetricHistory.siteId, siteId),
        eq(siteMetricHistory.metric, metric),
        ...(since ? [gte(siteMetricHistory.capturedAt, since)] : []),
      ),
    )
    .orderBy(desc(siteMetricHistory.capturedAt))
    .all();
}

/** Which metrics this Site has any history for. */
export function metricsWithHistory(siteId: string): string[] {
  const db = database();
  if (!db) return [];

  return db
    .selectDistinct({ metric: siteMetricHistory.metric })
    .from(siteMetricHistory)
    .where(eq(siteMetricHistory.siteId, siteId))
    .all()
    .map((row) => row.metric);
}

export interface Movement {
  metric: MetricDefinition;
  /** Newest first. Readings that could not answer are included, as `null`. */
  points: Array<{ at: Date; value: number | null; grade: string | null }>;
  latest: number | null;
  previous: number | null;
  /** `null` when there is nothing to compare against, or one side is unanswered. */
  change: number | null;
  /** `true`, `false`, or `null` when `change` is null. */
  improved: boolean | null;
}

/**
 * How a metric has moved.
 *
 * The comparison is against the previous **answered** reading, not simply the
 * previous row. A run where PageSpeed timed out records `null`, and comparing
 * against that would report a collapse and then a recovery, neither of which
 * happened to the site.
 */
export function movementOf(siteId: string, metric: string, since?: Date): Movement | null {
  const definition = metricDefinition(metric);
  if (!definition) return null;

  const rows = readSeries(siteId, metric, since);
  const points = rows.map((row) => ({ at: row.capturedAt, value: row.value, grade: row.grade }));

  const answered = points.filter((point) => point.value !== null);
  const latest = answered[0]?.value ?? null;
  const previous = answered[1]?.value ?? null;

  const change = latest !== null && previous !== null ? latest - previous : null;
  const improved =
    change === null || change === 0
      ? change === 0
        ? false
        : null
      : definition.direction === "up-is-better"
        ? change > 0
        : change < 0;

  return { metric: definition, points, latest, previous, change, improved };
}

/** `YYYY-MM` for an instant, in UTC. See `schema.ts` on why a month is text. */
export function monthOf(at: Date): string {
  return at.toISOString().slice(0, 7);
}

export interface MonthlySummary {
  month: string;
  readings: number;
  metrics: Record<string, { last: number | null; min: number | null; max: number | null }>;
}

/**
 * Fold a Site's readings into one row per month.
 *
 * The long trend, and the one that survives a retention sweep of the detail.
 * Six months of readings answers "what broke recently" and cannot answer "this
 * has been sliding all year", which is the comparison an owner actually asks
 * for.
 *
 * Recomputed rather than appended: a month is upserted on its unique
 * `(site_id, month)`, so running this twice produces the same row, and running
 * it after a late audit corrects the month rather than duplicating it.
 */
export function rollUpMonths(siteId: string): number {
  const db = database();
  if (!db) return 0;

  const rows = db
    .select()
    .from(siteMetricHistory)
    .where(eq(siteMetricHistory.siteId, siteId))
    .orderBy(siteMetricHistory.capturedAt)
    .all();

  const byMonth = new Map<string, SiteMetricReading[]>();
  for (const row of rows) {
    const month = monthOf(row.capturedAt);
    byMonth.set(month, [...(byMonth.get(month) ?? []), row]);
  }

  for (const [month, readings] of byMonth) {
    const metrics: MonthlySummary["metrics"] = {};

    for (const definition of METRICS) {
      const forMetric = readings.filter((row) => row.metric === definition.key);
      if (forMetric.length === 0) continue;

      // Only answered readings feed min, max and last. A `null` folded in as 0
      // would make the month's minimum a number the site never had.
      const values = forMetric
        .map((row) => row.value)
        .filter((value): value is number => value !== null);

      metrics[definition.key] = {
        last: values.length > 0 ? values[values.length - 1] : null,
        min: values.length > 0 ? Math.min(...values) : null,
        max: values.length > 0 ? Math.max(...values) : null,
      };
    }

    // How many *runs* the month is built from, not how many rows: a month built
    // from one audit and one built from four are not comparable, and the row
    // count would just say how many metrics the audit records.
    const runs = new Set(readings.map((row) => row.capturedAt.getTime())).size;

    db.insert(siteMetricMonthly)
      .values({ siteId, month, readings: runs, metrics, createdAt: now(), updatedAt: now() })
      .onConflictDoUpdate({
        target: [siteMetricMonthly.siteId, siteMetricMonthly.month],
        set: { readings: runs, metrics, updatedAt: now() },
      })
      .run();
  }

  return byMonth.size;
}

/** The stored monthly rollups for a Site, oldest first. */
export function readMonths(siteId: string): MonthlySummary[] {
  const db = database();
  if (!db) return [];

  return db
    .select()
    .from(siteMetricMonthly)
    .where(eq(siteMetricMonthly.siteId, siteId))
    .orderBy(siteMetricMonthly.month)
    .all()
    .map((row) => ({
      month: row.month,
      readings: row.readings,
      metrics: row.metrics as MonthlySummary["metrics"],
    }));
}
