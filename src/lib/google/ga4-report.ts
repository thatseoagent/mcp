/**
 * Reading and rendering a GA4 report, shared by every ga4_* Tool.
 *
 * ── Two things a GA4 report can be while looking complete ──
 *
 * **Truncated.** The Data API returns `rowCount` alongside the rows, and a
 * report that hit its limit looks exactly like one that did not. A reader adding
 * up the rows shown and calling it the total is wrong by however much was left.
 *
 * **Thresholded.** GA4 withholds rows when they might identify individuals —
 * anything involving Google Signals, demographics, or a small enough audience.
 * Google announces this in `metadata`, and a report that drops the announcement
 * hands over a number that is quietly smaller than the truth.
 *
 * Both are stated in the output rather than left to be inferred. This is the
 * same rule the rest of the codebase applies to a check that could not run: a
 * partial result presented as a whole one is the failure worth preventing.
 *
 * ── Everything arrives as a string ──
 *
 * Every metric value in a GA4 response is a string, including integers. Summing
 * them without converting concatenates; comparing them sorts `"9"` above
 * `"10"`. The conversion happens here, once.
 */
import type { Ga4Report } from "./reader";
import { withheld } from "../render-list";

export interface ReportTable {
  dimensions: string[];
  metrics: string[];
  rows: Array<{ dimensions: string[]; metrics: number[] }>;
  /** Raw metric strings, kept for values that are not numbers (dates, currencies). */
  rawRows: Array<{ dimensions: string[]; metrics: string[] }>;
  totals: number[];
  /** How many rows the property has for this query, which may exceed `rows`. */
  rowCount: number;
  /** Sentences the reader is owed about what this report is not. */
  caveats: string[];
}

function toNumber(value: string | undefined): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

/** A GA4 response, read into something a renderer can walk. */
export function readReport(report: Ga4Report): ReportTable {
  const dimensions = (report.dimensionHeaders ?? []).map((header) => header.name ?? "");
  const metrics = (report.metricHeaders ?? []).map((header) => header.name ?? "");

  const rawRows = (report.rows ?? []).map((row) => ({
    dimensions: (row.dimensionValues ?? []).map((value) => value.value ?? ""),
    metrics: (row.metricValues ?? []).map((value) => value.value ?? ""),
  }));

  const rows = rawRows.map((row) => ({
    dimensions: row.dimensions,
    metrics: row.metrics.map(toNumber),
  }));

  const totals = (report.totals?.[0]?.metricValues ?? []).map((value) => toNumber(value.value));
  const rowCount = report.rowCount ?? rows.length;

  const caveats: string[] = [];
  if (rowCount > rows.length) {
    caveats.push(
      `This property has ${rowCount} rows for this query and ${rows.length} came back. ` +
        `Adding up the rows below does not give the property's total — use the totals line, ` +
        `or raise \`limit\` to see the rest.`,
    );
  }

  // Google's own announcement, in its own field. Both spellings appear across
  // API versions, so both are read.
  const metadata = report.metadata ?? {};
  if (metadata.dataLossFromOtherRow === true) {
    caveats.push(
      "GA4 collapsed some rows into an `(other)` bucket because the query exceeded its " +
        "cardinality limit. The rows below are real; the ones missing are inside `(other)`.",
    );
  }
  const thresholds = metadata.samplingMetadatas ?? metadata.subjectToThresholding;
  if (thresholds) {
    caveats.push(
      "GA4 applied data thresholding to this report: rows that might identify individuals " +
        "were withheld. The numbers below are therefore lower bounds, not counts.",
    );
  }

  return { dimensions, metrics, rows, rawRows, totals, rowCount, caveats };
}

/** How many rows to print before saying how many were withheld. */
const MAX_ROWS_SHOWN = 50;

/**
 * The table, as lines.
 *
 * Dimension values first, then metrics, in the order Google returned them —
 * reordering would break the correspondence with the headers a caller asked for.
 */
export function renderReport(table: ReportTable): string[] {
  const lines: string[] = [];

  for (const caveat of table.caveats) {
    lines.push(`Note: ${caveat}`);
    lines.push("");
  }

  if (table.rows.length === 0) {
    // An empty report is an answer about the window and the filters, not about
    // the property. Said that way so nobody concludes their tracking is broken.
    lines.push("No rows. That is a fact about this query — its dates, its filters and its");
    lines.push("dimensions — rather than about the property. Widen the window or drop a filter");
    lines.push("before concluding anything, and use ga4_check_compatibility if you combined");
    lines.push("dimensions and metrics that GA4 cannot report together.");
    return lines;
  }

  const header = [...table.dimensions, ...table.metrics].join(" | ");
  lines.push(header);
  lines.push("-".repeat(Math.min(header.length, 80)));

  for (const row of table.rawRows.slice(0, MAX_ROWS_SHOWN)) {
    lines.push([...row.dimensions, ...row.metrics].join(" | "));
  }

  if (table.rawRows.length > MAX_ROWS_SHOWN) {
    lines.push(...withheld(table.rawRows.length, MAX_ROWS_SHOWN, {
      noun: "of the rows returned",
      indent: "",
    }));
  }

  if (table.totals.length > 0) {
    lines.push("");
    lines.push(
      `Totals across the whole query: ${table.metrics
        .map((metric, index) => `${metric} ${table.totals[index] ?? 0}`)
        .join(", ")}`,
    );
  }

  return lines;
}
