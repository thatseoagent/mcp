/**
 * One encoding for every instant in the database, and the helpers that use it.
 *
 * Postgres had a type for this: `timestamptz` stored a point in time and gave one
 * back, and the driver did the rest. SQLite has no date type at all — every
 * column is text, integer, real or blob — so the encoding stops being the
 * database's decision and becomes ours. Left unmade, that decision gets made
 * differently in each table by whoever writes it: an ISO string here, a Unix
 * second there, a `datetime('now')` somewhere else. Rows then sort wrong against
 * each other, and a comparison across two tables silently compares a string to a
 * number.
 *
 * **The encoding is integer milliseconds since the Unix epoch, everywhere.**
 * Chosen over ISO text for three reasons: it sorts correctly as a number without
 * depending on the string being zero-padded and always UTC, it is exactly what
 * `Date.now()` already produces, and it cannot carry an offset — so there is no
 * way to write a local time and have it read back as UTC.
 *
 * Every column uses Drizzle's `timestamp_ms` mode, which applies precisely this
 * encoding and hands JavaScript a `Date`. The helpers below exist so nothing has
 * to reach for `new Date()` at a call site and no table can quietly adopt a
 * second convention.
 *
 * A calendar month is deliberately *not* an instant and does not use this: see
 * `siteMetricMonthly.month` in `schema.ts`.
 */
import { integer } from "drizzle-orm/sqlite-core";

/**
 * A column holding a point in time.
 *
 * Wrapped rather than writing `integer(name, { mode: "timestamp_ms" })` at each
 * of the fourteen places that need one, so the mode cannot be omitted or spelled
 * `timestamp` (seconds) by accident — a mistake that would be invisible until
 * some row came back dated 1970.
 */
export function instant(name: string) {
  return integer(name, { mode: "timestamp_ms" });
}

/**
 * Now, as the database will store it.
 *
 * One function rather than `new Date()` inline, so tests have a single seam to
 * freeze and so "now" means the same thing in every table written by one
 * operation — a refresh whose `started_at` and whose readings' `captured_at`
 * differ by a few milliseconds is a row nobody can join on cleanly.
 */
export function now(): Date {
  return new Date();
}

/** `now()` plus a duration, for expiry columns. */
export function inMs(milliseconds: number): Date {
  return new Date(Date.now() + milliseconds);
}
