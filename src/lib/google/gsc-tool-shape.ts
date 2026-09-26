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
import { basisSection, type Basis } from "../render-basis";
import type { SearchAnalyticsQuery, SearchAnalyticsRow, SearchConsoleReader } from "./reader";

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
  /**
   * What these rows are, as a part of the basis section: how many were read,
   * whether that was the whole answer, and what Search Console never reports.
   *
   * A part rather than finished lines because most Tools read more than rows —
   * a sample drawn from them, a sitemap, a GA4 report — and the section is one
   * section however many reads fed it: `basisSection(fetched.basis, sample)`.
   * A Tool that read nothing else prints {@link footer}.
   */
  basis: Basis;
  /**
   * The basis section for a Tool whose answer rests on these rows alone.
   *
   * Symmetric with `header`, and it was not. `whatTheseRowsAre(rows.length, limit)`
   * had to be handed the row limit **a second time** to decide whether to warn
   * that the read was truncated, so nine Tools wrote the same constant twice —
   * `gsc-detect-cannibalization` said `10_000` at its `fetchRows` call and again
   * at each of its two footers. All nine agreed, and the failure mode of
   * disagreeing is the one this sentence exists to prevent: a false all-clear on
   * a truncated read.
   *
   * Computed here because both inputs are known here, which is the whole reason
   * the restatement was avoidable.
   */
  footer: string[];
  /**
   * What Google said about how complete the rows are, when the read asked for
   * fresh data. Absent on a `final` read, where there is nothing to say: every
   * day in it is finished. See {@link ReadOptions.dataState}.
   */
  firstIncompleteDate?: string;
  firstIncompleteHour?: string;
}

/**
 * How many rows these Tools ask for when they do not say.
 *
 * 50,000 because that is the most Google will ever return: it keeps at most
 * 50,000 rows per day per search type, whatever the request asks for. The reader
 * pages past Google's 25,000-row request ceiling, and stops at the first short
 * page, so a small property still costs one request.
 *
 * High because they analyse rather than list: a truncated read silently drops
 * the queries below the cut, and a "no cannibalization found" built on the top
 * slice of the rows is a false all-clear rather than a short answer. It was
 * 5,000 while the reader could not page, which on a large property was that
 * all-clear with a footer to say so.
 *
 * One constant rather than a `?? 5_000` in each function that needs it. It was
 * written four times — the default here, the default in `whatTheseRowsAre`, and
 * inline in the two Tools that read a second window by hand — which is four
 * places for the number that decides "is this read complete?" to disagree with
 * the number that asks the question.
 */
export const DEFAULT_ROW_LIMIT = 50_000;

/** What a read of Search Console asks for, apart from which property and when. */
interface ReadOptions {
  dimensions?: string[];
  rowLimit?: number;
  type?: string;
  /**
   * Narrow the read to one page, one query, and so on, in Google's own shape.
   *
   * Passed through rather than modelled: Google's filter groups are already the
   * smallest honest description of "only this page", and a second vocabulary
   * for them would be one more thing to translate wrongly.
   */
  dimensionFilterGroups?: SearchAnalyticsQuery["dimensionFilterGroups"];
  /**
   * Ask for data Google is still collecting.
   *
   * Absent means Google's default, `final`, and the read goes through
   * `searchAnalytics` exactly as it always did. Set, the read goes through
   * `searchAnalyticsWithMetadata` instead, because a read of partial data that
   * dropped Google's statement of *which* data is partial would hand a Tool a
   * number that is still rising with nothing to say so.
   */
  dataState?: SearchAnalyticsQuery["dataState"];
}

/** One read, through whichever method returns what the options need. */
async function read(
  reader: SearchConsoleReader,
  query: SearchAnalyticsQuery,
): Promise<{ rows: SearchAnalyticsRow[]; firstIncompleteDate?: string; firstIncompleteHour?: string }> {
  if (!query.dataState) return { rows: await reader.searchAnalytics(query) };
  return reader.searchAnalyticsWithMetadata(query);
}

/** The request, from the property, the window and the options. Written once for both reads. */
function queryFor(
  siteUrl: string,
  window: { startDate: string; endDate: string },
  options: ReadOptions,
  limit: number,
): SearchAnalyticsQuery {
  return {
    siteUrl,
    startDate: window.startDate,
    endDate: window.endDate,
    dimensions: options.dimensions,
    type: options.type,
    rowLimit: limit,
    // Only when asked for, so a read that did not ask sends exactly the request
    // it sent before these existed.
    ...(options.dimensionFilterGroups ? { dimensionFilterGroups: options.dimensionFilterGroups } : {}),
    ...(options.dataState ? { dataState: options.dataState } : {}),
  };
}

/**
 * Resolve the property, resolve the window, and read the rows.
 *
 * Returns the header *and* the basis, so a Tool never restates what it asked
 * for. See {@link FetchedRows.basis}.
 */
export async function fetchRows(
  reader: SearchConsoleReader,
  args: WindowArgs,
  options: ReadOptions & { title: string },
): Promise<FetchedRows> {
  const window = resolveWindow(args);
  const limit = options.rowLimit ?? DEFAULT_ROW_LIMIT;

  const { result, siteUrl: property } = await withPropertyFallback(reader, args.siteUrl, (resolved) =>
    read(reader, queryFor(resolved, window, options, limit)),
  );
  const { rows } = result;

  const basis = whatTheseRowsAre(rows.length, limit);
  const header = [`=== ${options.title} ===`];
  header.push(`Property: ${property}`);
  header.push(`Window: ${window.startDate} to ${window.endDate}`);
  header.push(`Rows read: ${rows.length}`);
  for (const note of window.notes) {
    header.push("");
    header.push(`Note: ${note}`);
  }

  return {
    property,
    startDate: window.startDate,
    endDate: window.endDate,
    rows,
    header,
    basis,
    footer: basisSection(basis),
    ...(result.firstIncompleteDate ? { firstIncompleteDate: result.firstIncompleteDate } : {}),
    ...(result.firstIncompleteHour ? { firstIncompleteHour: result.firstIncompleteHour } : {}),
  };
}

/**
 * Read again, against the property this read already resolved.
 *
 * `fetchRows` returns `property` but gave a caller no way to use it, so three
 * Tools re-entered `withPropertyFallback` by hand — the one thing `fetchRows`
 * exists to hide. Resolving a second time is not merely repetition: the fallback
 * can land on a *different* property than the first call did, and then the two
 * reads a Tool is comparing are about two different sites.
 */
export async function readAgain(
  reader: SearchConsoleReader,
  fetched: FetchedRows,
  // `window` defaults to the one already read, because that is the commoner ask:
  // `gsc_serp_features_gap` wants the property's own totals over the same dates,
  // at a different grain. Only a comparison names a different window.
  options: ReadOptions & { window?: { startDate: string; endDate: string } } = {},
): Promise<SearchAnalyticsRow[]> {
  const window = options.window ?? fetched;
  const { result } = await withPropertyFallback(reader, fetched.property, (resolved) =>
    read(reader, queryFor(resolved, window, options, options.rowLimit ?? DEFAULT_ROW_LIMIT)),
  );
  return result.rows;
}

/** A window read for comparison, and the line that says which window it was. */
export interface Comparison {
  rows: SearchAnalyticsRow[];
  startDate: string;
  endDate: string;
  /** `Compared against: … (N rows)`, which both callers wrote identically. */
  line: string;
}

/**
 * The window immediately before this one, read against the same property.
 *
 * `gsc_detect_trends` and `gsc_detect_lost_queries` were a 23-line block whose
 * only difference was the one analysis line: the `precedingWindow` call, the
 * hand-rolled `withPropertyFallback`, the inline `rowLimit: 5_000` and the
 * `Compared against:` line were character-identical in both. That block is this
 * function.
 */
export async function readPrecedingWindow(
  reader: SearchConsoleReader,
  fetched: FetchedRows,
  options: ReadOptions = {},
): Promise<Comparison> {
  const before = precedingWindow(fetched.startDate, fetched.endDate);
  const rows = await readAgain(reader, fetched, { ...options, window: before });

  return {
    rows,
    ...before,
    line: `Compared against: ${before.startDate} to ${before.endDate} (${rows.length} rows)`,
  };
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
 * What every analysis Tool's answer rests on, as far as Search Console goes.
 *
 * Search Console shows what it shows: it withholds queries it considers
 * personal, it samples, and it lags. A finding is therefore about the rows, and
 * an *absence* of findings is about the rows too — which is the half a reader
 * will otherwise take as a clean bill of health.
 *
 * The truncation sentence is `read`, not a caveat, because it is about this
 * read and begins "That is": it has to follow the row count it refers to, which
 * the caveats, printed after every part's `read`, would not.
 *
 * Private. It used to be exported and called at 19 sites, each of which had to
 * repeat the row limit it had already given `fetchRows`. Callers read
 * {@link FetchedRows.basis} instead, where the limit is the one this read
 * actually used rather than the one a second argument claimed.
 */
function whatTheseRowsAre(rowCount: number, limit: number): Basis {
  const read = [`${rowCount} row(s) from Search Console for this window.`];

  if (rowCount >= limit) {
    read.push(
      `That is the full page asked for, so there are almost certainly more rows and this ` +
        `analysis has not seen them. Narrow the window or raise the limit.`,
    );
  }

  return {
    read,
    limits: [
      "Search Console withholds queries it considers personal and does not report every " +
        "impression, so an absence here is an absence in these rows rather than a fact about " +
        "the site.",
    ],
  };
}
