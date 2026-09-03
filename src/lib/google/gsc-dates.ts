/**
 * The date window a Search Console query actually gets.
 *
 * ── Search Console is not live, and pretending otherwise invents a drop ──
 *
 * Google's data lags by two to three days. A query whose window ends *today*
 * therefore ends with two or three days of zeroes, and every comparison built on
 * it — week over week, trend, anomaly — reads that as traffic collapsing. The
 * retired product shipped that bug and it produced the most alarming false
 * finding it had.
 *
 * So the default window ends {@link LAG_DAYS} days ago, and a caller who names
 * an end date is left alone: they asked for something specific, and silently
 * moving it would be a different lie.
 *
 * ── Sixteen months, and no further ──
 *
 * Google keeps Search Analytics for sixteen months. A start date before that
 * returns nothing for the missing part, which reads as a site that did not exist
 * yet. Clamping it and saying so is the honest shape.
 */

/** How far behind Search Console runs. Google documents two to three days. */
export const LAG_DAYS = 3;

/** Google's retention for Search Analytics. */
export const RETENTION_DAYS = 16 * 30;

/** `YYYY-MM-DD` for a date, in UTC, which is the only timezone Google uses here. */
export function isoDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

/** `YYYY-MM-DD` for a number of days before now. */
export function daysAgo(days: number, from = new Date()): string {
  const date = new Date(from);
  date.setUTCDate(date.getUTCDate() - days);
  return isoDate(date);
}

export interface DateWindow {
  startDate: string;
  endDate: string;
  /** What to tell the reader about the window, when it is not what they asked for. */
  notes: string[];
}

/**
 * The window to query, and what to say about it.
 *
 * @param days how many days the caller wants, when they gave no explicit dates.
 */
export function resolveWindow(
  options: { startDate?: string; endDate?: string; days?: number },
  now = new Date(),
): DateWindow {
  const notes: string[] = [];

  const endDate = options.endDate ?? daysAgo(LAG_DAYS, now);
  if (!options.endDate) {
    notes.push(
      `The window ends ${endDate}, ${LAG_DAYS} days back: Search Console data lags by two to ` +
        `three days, and including today would end the range with days that are empty because ` +
        `they have not been processed yet — not because traffic fell.`,
    );
  }

  const requestedStart = options.startDate ?? daysAgo(LAG_DAYS + (options.days ?? 28), now);
  const earliest = daysAgo(RETENTION_DAYS, now);

  let startDate = requestedStart;
  if (requestedStart < earliest) {
    startDate = earliest;
    notes.push(
      `The window starts ${startDate} rather than ${requestedStart}: Google keeps Search ` +
        `Analytics for sixteen months, and the earlier part would come back empty because it ` +
        `no longer exists, not because the site had no traffic.`,
    );
  }

  return { startDate, endDate, notes };
}
