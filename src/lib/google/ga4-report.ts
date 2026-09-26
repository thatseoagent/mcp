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
 * Also **sampled** (estimates, not counts) and **truncated** (a part of the
 * window missing, for a reason Google names). Each has its own sentence.
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
import type { Ga4PropertyQuota, Ga4QuotaStatus, Ga4Report } from "./reader";
import { capped } from "../render-list";
import type { Basis } from "../render-basis";

export interface ReportTable {
  dimensions: string[];
  metrics: string[];
  rows: Array<{ dimensions: string[]; metrics: number[] }>;
  /** Raw metric strings, kept for values that are not numbers (dates, currencies). */
  rawRows: Array<{ dimensions: string[]; metrics: string[] }>;
  totals: number[];
  /** How many rows the property has for this query, which may exceed `rows`. */
  rowCount: number;
  /**
   * Sentences the reader is owed about what this report is not.
   *
   * Worded to stand anywhere in a Tool's output — "the rows in this report",
   * never "the rows below" — because they are printed in its basis section,
   * after the figures, by {@link reportBasis} or by a Tool that joined this
   * report to another read.
   */
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
        `Adding up the rows in this report does not give the property's total — use the totals line, ` +
        `or raise \`limit\` to see the rest.`,
    );
  }

  // Google's own announcement, in its own field. Both spellings appear across
  // API versions, so both are read.
  const metadata = report.metadata ?? {};
  if (metadata.dataLossFromOtherRow === true) {
    caveats.push(
      "GA4 collapsed some rows into an `(other)` bucket because the query exceeded its " +
        "cardinality limit. The rows reported are real; the ones missing are inside `(other)`.",
    );
  }
  // Sampling and thresholding are two different things that used to share one
  // sentence, read off `samplingMetadatas ?? subjectToThresholding`: a sampled
  // report was told it had been thresholded, which gets the direction of the
  // error wrong. Sampled numbers are estimates, high or low; thresholded ones
  // are lower bounds.
  const samples = Array.isArray(metadata.samplingMetadatas) ? metadata.samplingMetadatas : [];
  if (samples.length > 0) {
    caveats.push(
      `GA4 sampled this report${sampledShare(samples)}: the numbers in this report are estimates ` +
        "scaled up from part of the data, not counts. Narrow the window to read it unsampled.",
    );
  }
  if (metadata.subjectToThresholding === true) {
    caveats.push(
      "GA4 marks this report as subject to thresholding: rows that might identify individuals " +
        "can have been withheld, so the numbers in this report may be lower bounds rather than counts.",
    );
  }
  const truncations = Array.isArray(metadata.dataTruncationReasons) ? metadata.dataTruncationReasons : [];
  for (const reason of truncations) {
    caveats.push(describeTruncation(reason));
  }
  if (typeof metadata.emptyReason === "string" && metadata.emptyReason && rows.length === 0) {
    caveats.push(`GA4 says this report is empty because: ${metadata.emptyReason}`);
  }

  return { dimensions, metrics, rows, rawRows, totals, rowCount, caveats };
}

/**
 * "(about 12% of the data)", from Google's own counts, or nothing when it did not say.
 *
 * One figure per date range; the smallest is the one that matters, because it
 * is the range the estimate is weakest on.
 */
function sampledShare(samples: unknown[]): string {
  const shares = samples
    .map((sample) => {
      const record = sample as { samplesReadCount?: unknown; samplingSpaceSize?: unknown };
      const read = Number(record.samplesReadCount);
      const space = Number(record.samplingSpaceSize);
      return Number.isFinite(read) && Number.isFinite(space) && space > 0 ? read / space : null;
    })
    .filter((share): share is number => share !== null);
  if (shares.length === 0) return "";
  const smallest = Math.min(...shares);
  return ` (from about ${smallest < 0.01 ? "<1" : Math.round(smallest * 100)}% of the data)`;
}

/**
 * One of Google's truncation reasons, as a sentence.
 *
 * Google's own message is included because it is written for the property's
 * owner and names what was cut; the date is the fact a reader acts on.
 */
function describeTruncation(reason: unknown): string {
  const record = (reason ?? {}) as {
    dataTruncationType?: unknown;
    dataTruncationMessage?: unknown;
    dataTruncationDate?: unknown;
  };
  const type =
    typeof record.dataTruncationType === "string"
      ? record.dataTruncationType.replace(/^DATA_TRUNCATION_TYPE_/, "").toLowerCase().replace(/_/g, " ")
      : "unspecified";
  const date = typeof record.dataTruncationDate === "string" ? ` before ${record.dataTruncationDate}` : "";
  const message =
    typeof record.dataTruncationMessage === "string" && record.dataTruncationMessage
      ? ` Google says: ${record.dataTruncationMessage}`
      : "";
  return `GA4 truncated data in this report (${type})${date}, so part of the window is missing.${message}`;
}

/** How many rows to print before saying how many were withheld. */
const MAX_ROWS_SHOWN = 50;

/**
 * What a report's answer rests on, as a part of the basis section.
 *
 * The caveats used to be printed by {@link renderReport}, above the table, and
 * by each Tool's own loop as well, so `ga4_key_events` printed every one of them
 * twice on a property with no key events. They travel here instead, to the one
 * section a reader looks in for them.
 */
export function reportBasis(table: ReportTable): Basis {
  return {
    read: [`${table.rows.length} row(s) from GA4 for this query.`],
    caveats: table.caveats,
  };
}

/**
 * The table, as lines.
 *
 * Dimension values first, then metrics, in the order Google returned them —
 * reordering would break the correspondence with the headers a caller asked for.
 *
 * The table alone: what it rests on is {@link reportBasis}, which the Tool prints
 * with whatever else its answer was read from.
 */
export function renderReport(table: ReportTable): string[] {
  const lines: string[] = [];

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

  lines.push(
    ...capped(
      table.rawRows.map((row) => [...row.dimensions, ...row.metrics].join(" | ")),
      MAX_ROWS_SHOWN,
      { noun: "of the rows returned", indent: "" },
    ),
  );

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

/**
 * The sentence a report owes when the property is close to running out of quota.
 *
 * ── Why the threshold is an absolute number ──
 *
 * Google's `QuotaStatus` reads, verbatim, `consumed`: "Quota consumed by this
 * request" and `remaining`: "Quota remaining after this request".
 * (https://developers.google.com/analytics/devguides/reporting/data/v1/rest/v1beta/PropertyQuota)
 * So `consumed + remaining` is what was left *before* this request, not the
 * property's limit, and "remaining below 10% of consumed + remaining" would fire
 * only when one report ate nine tenths of what was left — which no report does.
 * The limit itself is not in the response. It is fixed per tier, though: a
 * standard property gets 200,000 tokens a day and 40,000 an hour, an Analytics
 * 360 one ten times that. The warning fires below a tenth of the *standard*
 * limit, which is the early warning on a standard property and a late one on
 * 360 — and the sentence gives the number rather than a percentage, so it is
 * not wrong on either.
 *
 * ── Why say anything ──
 *
 * Exhausting either quota refuses every request to the property until it
 * refills, for this server and for every other tool reading the same property
 * through the same bucket. An Operator partway through a batch of reports is
 * better told that before the refusal than by it.
 *
 * Nothing at all when there is plenty left, or when Google did not report it.
 *
 * @param bucket which quota the request charged. Google keeps Core, Realtime
 *        and Funnel requests in separate buckets ("API requests to Funnel
 *        methods charge Funnel quotas"), so a low Funnel quota says nothing
 *        about ordinary reports.
 *        https://developers.google.com/analytics/devguides/reporting/data/v1/quotas
 */
export function quotaNotes(
  quota: Ga4PropertyQuota | undefined,
  bucket: "Core" | "Funnel" = "Core",
): string[] {
  const notes: string[] = [];

  const daily = remainingOf(quota?.tokensPerDay);
  if (daily !== null && daily < DAILY_WARNING) {
    notes.push(
      `Note: this property has ${daily.toLocaleString("en-US")} tokens left of its daily ` +
        `Analytics Data API quota for ${bucket} requests (a standard property gets 200,000 a day, ` +
        `Analytics 360 2,000,000). Daily quotas refill at midnight Pacific Time; until then, once ` +
        `it runs out, every ${bucket} request to this property is refused.`,
    );
  }

  const hourly = remainingOf(quota?.tokensPerHour);
  if (hourly !== null && hourly < HOURLY_WARNING) {
    notes.push(
      `Note: this property has ${hourly.toLocaleString("en-US")} tokens left of its hourly ` +
        `Analytics Data API quota for ${bucket} requests (a standard property gets 40,000 an hour, ` +
        `Analytics 360 400,000). Google refills hourly quotas within an hour, though not ` +
        `necessarily on the hour; once it runs out, ${bucket} requests are refused until then.`,
    );
  }

  return notes;
}

/** A tenth of a standard property's limits. See {@link quotaNotes}. */
const DAILY_WARNING = 20_000;
const HOURLY_WARNING = 4_000;

/**
 * What is left, or `null` when Google did not report this quota at all.
 *
 * A status that is present with no `remaining` means zero: the API speaks proto3
 * JSON, which leaves a zero-valued number out of the object. Reading the absence
 * as "unknown" would stay silent at exactly the moment the note matters most.
 */
function remainingOf(status: Ga4QuotaStatus | undefined): number | null {
  if (!status) return null;
  const remaining = Number(status.remaining ?? 0);
  return Number.isFinite(remaining) ? remaining : null;
}
