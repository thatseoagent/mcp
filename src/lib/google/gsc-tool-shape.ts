/**
 * The shape every analysis Tool shares: a property, a window, and rows.
 *
 * Fifteen Tools ask Search Console the same three questions before they can do
 * anything interesting — which property, over what dates, at what grain — and
 * each one wrote out the resolution, the fallback, the lag note and the header
 * itself. That is fifteen chances for one of them to forget the lag note and
 * report a two-day dip as a collapse.
 */
import { z } from "zod";
import { refreshable } from "../with-cache";
import { withPropertyFallback } from "./property";
import { resolveWindow } from "./gsc-dates";
import type { SearchAnalyticsRow, SearchConsoleReader } from "./reader";

/** The arguments every analysis Tool takes, described once. */
export const gscWindowSchema = {
  ...refreshable,
  siteUrl: z
    .string()
    .describe(
      "The Search Console property, or just the domain. `example.com`, " +
        "`sc-domain:example.com` and `https://example.com/` are all accepted.",
    ),
  startDate: z.string().optional().describe("YYYY-MM-DD. Defaults to `days` before the end date."),
  endDate: z
    .string()
    .optional()
    .describe("YYYY-MM-DD. Defaults to 3 days ago, because Search Console data lags."),
  days: z.number().int().optional().describe("Window length when no dates are given. Default 28."),
};

export interface WindowArgs {
  siteUrl: string;
  startDate?: string;
  endDate?: string;
  days?: number;
}

export interface FetchedRows {
  property: string;
  startDate: string;
  endDate: string;
  rows: SearchAnalyticsRow[];
  /** The header lines every analysis Tool opens with. */
  header: string[];
}

/** Google's ceiling for one Search Analytics request. */
export const MAX_ROWS = 25_000;

/**
 * Resolve the property, resolve the window, and read the rows.
 *
 * The row limit defaults high because these Tools analyse rather than list: a
 * truncated read silently drops the queries below the cut, and a "no
 * cannibalization found" built on the top 25 rows is a false all-clear rather
 * than a short answer.
 */
export async function fetchRows(
  reader: SearchConsoleReader,
  args: WindowArgs,
  options: { dimensions?: string[]; rowLimit?: number; type?: string; title: string },
): Promise<FetchedRows> {
  const window = resolveWindow(args);

  const { result: rows, siteUrl: property } = await withPropertyFallback(
    reader,
    args.siteUrl,
    (resolved) =>
      reader.searchAnalytics({
        siteUrl: resolved,
        startDate: window.startDate,
        endDate: window.endDate,
        dimensions: options.dimensions,
        type: options.type,
        rowLimit: options.rowLimit ?? 5_000,
      }),
  );

  const header = [`=== ${options.title} ===`];
  header.push(`Property: ${property}`);
  header.push(`Window: ${window.startDate} to ${window.endDate}`);
  header.push(`Rows read: ${rows.length}`);
  for (const note of window.notes) {
    header.push("");
    header.push(`Note: ${note}`);
  }

  return { property, startDate: window.startDate, endDate: window.endDate, rows, header };
}

/** The window immediately before this one, of the same length. */
export function precedingWindow(startDate: string, endDate: string): { startDate: string; endDate: string } {
  const start = Date.parse(startDate);
  const end = Date.parse(endDate);
  // Both ends inclusive, so the length is the difference plus one day. Getting
  // this wrong by a day makes the current window longer than the comparison and
  // inflates every delta — a bug the retired product shipped.
  const length = end - start + 86_400_000;
  return {
    startDate: new Date(start - length).toISOString().slice(0, 10),
    endDate: new Date(start - 86_400_000).toISOString().slice(0, 10),
  };
}

/**
 * The sentence every analysis Tool ends with.
 *
 * Search Console shows what it shows: it withholds queries it considers
 * personal, it samples, and it lags. A finding is therefore about the rows, and
 * an *absence* of findings is about the rows too — which is the half a reader
 * will otherwise take as a clean bill of health.
 */
export function whatTheseRowsAre(rowCount: number, limit = 5_000): string[] {
  const lines = [
    "",
    "=== WHAT THIS IS BASED ON ===",
    `${rowCount} row(s) from Search Console for this window.`,
  ];

  if (rowCount >= limit) {
    lines.push(
      `That is the full page asked for, so there are almost certainly more rows and this ` +
        `analysis has not seen them. Narrow the window or raise the limit.`,
    );
  }

  lines.push(
    "Search Console withholds queries it considers personal and does not report every " +
      "impression, so an absence here is an absence in these rows rather than a fact about " +
      "the site.",
  );

  return lines;
}
