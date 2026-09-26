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
const RETENTION_DAYS = 16 * 30;

/** `YYYY-MM-DD` for a date, in UTC, which is the only timezone Google uses here. */
function isoDate(date: Date): string {
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
  options: { startDate?: string; endDate?: string; days?: number; fresh?: boolean },
  now = new Date(),
): DateWindow {
  const notes: string[] = [];

  // Fresh data is the one case where ending today is the point rather than the
  // bug: the caller asked for the days still being collected, and Google says
  // which ones those are. The lag argument above still holds for what those days
  // *mean*, so the note says it rather than dropping it.
  const endDate = options.endDate ?? (options.fresh ? pacificToday(now) : daysAgo(LAG_DAYS, now));
  if (!options.endDate && options.fresh) {
    notes.push(
      `The window ends ${endDate}, today in Pacific Time, because fresh data was asked for. ` +
        `The last two or three days are still being collected: their numbers will rise, so they ` +
        `are not yet comparable with finished days.`,
    );
  } else if (!options.endDate) {
    notes.push(
      `The window ends ${endDate}, ${LAG_DAYS} days back: Search Console data lags by two to ` +
        `three days, and including today would end the range with days that are empty because ` +
        `they have not been processed yet — not because traffic fell.`,
    );
  }

  // Both ends are inclusive, so a window of `days` days starts `days - 1` before
  // its end. It started `days` before, which made the default "28 days" 29 —
  // one more day than it said, and one more than a GA4 `28daysAgo`–`yesterday`
  // window it might be set beside.
  const span = Math.max(1, options.days ?? 28);
  const requestedStart =
    options.startDate ??
    (options.fresh ? shiftDate(endDate, -(span - 1)) : daysAgo(LAG_DAYS + span - 1, now));
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

// ── Pacific Time ─────────────────────────────────────────────────────────────
//
// Search Console's dates are Pacific Time — Google's reference says so of every
// date in the API, and its hour keys carry the offset (`-07:00` or `-08:00`).
// The finished-data window above can afford UTC because it ends three days back
// and a few hours either way lands on the same day. A window that ends *today*
// cannot: for eight hours of every UTC day, UTC's today is a day Google has not
// started yet.

const PACIFIC = "America/Los_Angeles";

/** `YYYY-MM-DD` for today, in the timezone Search Console keeps its days in. */
export function pacificToday(now = new Date()): string {
  // `en-CA` formats as `YYYY-MM-DD`, which is the only reason it is chosen.
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: PACIFIC,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now);
}

/** A `YYYY-MM-DD` date moved by whole days. Calendar arithmetic, so no timezone applies. */
export function shiftDate(date: string, days: number): string {
  const moved = new Date(`${date}T00:00:00Z`);
  moved.setUTCDate(moved.getUTCDate() + days);
  return isoDate(moved);
}

/** How many days back Google keeps the hourly breakdown. */
export const HOURLY_RETENTION_DAYS = 10;

/**
 * The last `days` Pacific days, today included — the window an hourly read asks for.
 *
 * Today included because that is the question an hourly read exists for ("did
 * the 14:00 deploy change anything today?"). Clamped to Google's ten days,
 * because the eleventh would come back empty and read as a site that got no
 * traffic that day.
 */
export function hourlyWindow(days: number, now = new Date()): { startDate: string; endDate: string } {
  const span = Math.min(HOURLY_RETENTION_DAYS, Math.max(1, Math.floor(days)));
  const endDate = pacificToday(now);
  return { startDate: shiftDate(endDate, -(span - 1)), endDate };
}

// ── Calendar months ──────────────────────────────────────────────────────────

export interface CalendarMonth {
  /** `YYYY-MM`. */
  month: string;
  startDate: string;
  endDate: string;
}

export interface MonthsWindow {
  /** Oldest first, every one of them complete. */
  months: CalendarMonth[];
  startDate: string;
  endDate: string;
  notes: string[];
}

/**
 * The last `count` **complete** calendar months Search Console still holds.
 *
 * Complete, because a month-by-month comparison with a partial month at either
 * end is the lag bug again at a coarser grain: the current month is short by
 * however many days are left in it, and would read as a decline every time.
 * So the newest month is the last one whose final day is outside the lag, and
 * the oldest is dropped rather than half-read when retention has already eaten
 * its first days.
 */
export function calendarMonths(count: number, now = new Date()): MonthsWindow {
  const notes: string[] = [];
  const settled = daysAgo(LAG_DAYS, now);
  // The month before the one the last settled day is in. If that day is the
  // last of its month, the month is complete — but one day's head start is not
  // worth a second rule, and ending a month early is the conservative error.
  const [year, month] = settled.split("-").map(Number);
  const months: CalendarMonth[] = [];
  const earliest = daysAgo(RETENTION_DAYS, now);

  for (let back = count; back >= 1; back--) {
    const first = new Date(Date.UTC(year, month - 1 - back, 1));
    const last = new Date(Date.UTC(year, month - back, 0));
    const startDate = isoDate(first);
    if (startDate < earliest) continue;
    months.push({ month: startDate.slice(0, 7), startDate, endDate: isoDate(last) });
  }

  if (months.length < count) {
    notes.push(
      `${months.length} complete month(s) rather than ${count}: Google keeps Search Analytics ` +
        `for sixteen months, and a month whose first days have already been deleted would read ` +
        `as a quiet month rather than a missing one.`,
    );
  }
  notes.push(
    `The current month is left out because it is not over, and the newest month read is the ` +
      `last one outside Search Console's two-to-three-day lag.`,
  );

  return {
    months,
    startDate: months[0]?.startDate ?? settled,
    endDate: months[months.length - 1]?.endDate ?? settled,
    notes,
  };
}
