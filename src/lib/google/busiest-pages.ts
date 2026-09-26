/**
 * The site's busiest pages, read: which ones, what Google says about each, and
 * what each one says for itself.
 *
 * Nine Tools want the same thing — a handful of the pages that matter, rather
 * than the pages that exist — and each rebuilt the sequence by hand: resolve the
 * property, pick the top N from Search Console, inspect them, fetch them, and say
 * what was sampled. They did it in two pipelines with opposite failure policies,
 * three ways of choosing the top N and six copies of the robots sentence. This is
 * that sequence once, in four steps a Tool takes as far as it needs:
 *
 *   1. {@link busiest}      — which pages, from a `fetchRows` read.
 *   2. {@link inspectPages} — Google's record for each, through URL Inspection.
 *   3. {@link readPages}    — each page as served, with its three outcomes.
 *   4. {@link sampleNote}   — the basis lines that say the sample is a sample.
 *
 * A Tool whose candidates are not Search Console's busiest — `site_lastmod_accuracy`
 * samples sitemap URLs, `site_ai_landing_signals` takes GA4's landing pages —
 * hands its own URL list to steps 2 and 3.
 *
 * ── Why the busiest, and why so few ──
 *
 * URL Inspection is rationed per property per day, and a spent inspection does
 * not come back, so the sample is small and deliberate. A site's first fifty URLs
 * alphabetically say nothing about the site; the fifty with the most impressions
 * are the ones whose state an Operator would act on. Search Console already knows
 * which those are, and asking it costs one request rather than one per URL.
 * Reading a page is not rationed, but it is a request to somebody's server under
 * our name, and the same argument picks which ones.
 *
 * ── One failure policy for inspections (ADR-0003) ──
 *
 * The two pipelines this replaces disagreed. One recorded every failure as a row
 * and carried on — so a property Google refused printed twenty failed rows and a
 * report built on none of them. The other rejected on any failure — so one URL
 * Google could not answer for threw away the other nineteen. Both were wrong in
 * the direction ADR-0003 names: the first is a partial result shaped like a whole
 * one, the second fails a Tool that could have done its whole job and said which
 * row it could not.
 *
 * What decides it is who the failure speaks for:
 *
 *   - **A refusal for the property or the day** — HTTP 401 or 403 (this account
 *     cannot read the property), 429 (the day's allowance is spent), or a missing
 *     login — is the same answer for every remaining URL. The call rejects, and
 *     the seam in `tool-failure.ts` words it.
 *   - **Anything else** — a 400 or 404 for one URL, a 5xx, a timeout — is about
 *     that URL. It becomes that row's `ok: false` with an authored reason, the
 *     cause goes to stderr through `logError`, and `sampleNote` hands it to the
 *     Tool's `NOT CHECKED` section, so nothing is left out quietly.
 *
 * A rejection waits for its batch to settle. Every inspection that did succeed is
 * then in `inspection-cache.ts` for the hour, so re-running after the cause is
 * fixed spends only the URLs that failed — which is what makes rejecting cheap
 * against a budget of 2,000 inspections per property per day.
 *
 * ── Reading a page has three outcomes, not two ──
 *
 * It was read; it could not be read; or robots.txt told us not to read it. The
 * last two are both "not checked", and neither may be reported as a finding about
 * the page: a title we did not fetch does not "miss" its query.
 *
 * `fetchAuditablePage` already draws the first line — it is the Reachability
 * Gate, and it shares one request per URL with every other Tool in the window.
 * What it deliberately does not do is swallow a robots refusal, because for a
 * one-page Tool that refusal is the whole answer. For a Tool reading ten pages it
 * is one page's answer, so it is caught here, per page, and said.
 *
 * A pacing refusal (`CrawlBudgetError`) is not caught. It is our own ceiling,
 * written to be read out, and it says when to come back; carrying on would only
 * turn the remaining pages into "not checked" for a reason that is not theirs.
 *
 * The read keeps the response headers beside the parsed page, so an analyzer that
 * needs one (hreflang's `Link` header) reads the bytes already fetched instead of
 * fetching the page a second time.
 */
import { inspectUrlOnce } from "./inspection-cache";
import { summarise, type InspectionSummary } from "./inspection-report";
import { totalsOf } from "./gsc-analysis";
import type { FetchedRows } from "./gsc-tool-shape";
import type { SearchAnalyticsRow, SearchConsoleReader, UrlInspection } from "./reader";
import { UpstreamApiError } from "../upstream-api-error";
import { MissingConfigError } from "../required-config";
import { logError } from "../log";
import type { NotChecked } from "../render-basis";
import { fetchAuditablePage } from "../page-reachability";
import { RobotsDisallowedError, ROBOTS_REFUSAL } from "../robots-gate";
import { readPage, type ParsedPage } from "../analyzers/parsed-page";

// ── 1. Which pages ───────────────────────────────────────────────────────────

/**
 * How many pages a Tool that only inspects takes, when it does not say.
 *
 * Small, because of the rationing. Twenty of a property's busiest pages is
 * enough to see a pattern and cheap enough to run daily; the Tools say how many
 * they looked at so nobody reads the sample as the site.
 */
export const SAMPLE_SIZE = 20;

/** What "busiest" is measured by. */
export type Metric = "clicks" | "impressions";

export interface BusyPage {
  url: string;
  clicks: number;
  impressions: number;
  ctr: number;
  position: number;
  /**
   * The rows this page was rolled up from. One for a `["page"]` read; one per
   * query for a `["page", "query"]` read, which is what `site_title_query_fit`
   * compares a title against.
   */
  rows: SearchAnalyticsRow[];
}

export interface Busiest {
  /** The chosen pages, busiest first. */
  pages: BusyPage[];
  /** How many distinct pages the property reported for the window. */
  reported: number;
  /** How many of those had any of the metric, so could be ranked by it at all. */
  eligible: number;
  by: Metric;
}

/**
 * How many pages a Tool takes: what it was asked for, else its default, clamped
 * to `1…max` and to a whole number.
 *
 * Written once because it was written in each Tool, one of which truncated a
 * fractional count and the others did not. {@link busiest} applies it; a Tool
 * with its own candidates calls it directly.
 */
export function sampleSize(options: { count?: number; max: number; default: number }): number {
  return Math.min(options.max, Math.max(1, Math.trunc(options.count ?? options.default)));
}

/**
 * The busiest pages in a Search Console read, by clicks or by impressions.
 *
 * The count goes through {@link sampleSize}. Rows are rolled up by
 * their first key (the page), with CTR and position recomputed rather than
 * averaged, so a read at a finer grain ranks pages rather than page-query pairs.
 * A row without a key is dropped rather than ranked as `(none)`: it is not a URL
 * anyone can inspect or fetch. A page with none of the metric is dropped too — a
 * page with no clicks is not among the busiest by clicks, however the sort left
 * it — and `eligible` says how many were left.
 *
 * Ties go to the other metric, then to the order Search Console gave.
 */
export function busiest(
  fetched: Pick<FetchedRows, "rows">,
  options: { by: Metric; count?: number; max: number; default: number },
): Busiest {
  const count = sampleSize(options);
  const other: Metric = options.by === "clicks" ? "impressions" : "clicks";

  const byPage = new Map<string, SearchAnalyticsRow[]>();
  for (const row of fetched.rows) {
    const url = row.keys?.[0];
    if (!url) continue;
    byPage.set(url, [...(byPage.get(url) ?? []), row]);
  }

  const ranked = [...byPage.entries()]
    .map(([url, rows]): BusyPage => ({ url, ...totalsOf(rows), rows }))
    .filter((page) => page[options.by] > 0)
    .sort((a, b) => b[options.by] - a[options.by] || b[other] - a[other]);

  return { pages: ranked.slice(0, count), reported: byPage.size, eligible: ranked.length, by: options.by };
}

// ── 2. What Google says about each ───────────────────────────────────────────

/** How many inspections run at once. Google allows 600 a minute per property. */
const INSPECTION_CONCURRENCY = 5;

/** Google's daily URL Inspection allowance per property, for the sentence that spends it. */
export const DAILY_INSPECTIONS = 2_000;

export type Inspected =
  | { url: string; ok: true; inspection: UrlInspection; summary: InspectionSummary }
  | { url: string; ok: false; reason: string };

/** A failure that speaks for the property or the day rather than for one URL. See the header. */
function refusesTheCall(error: unknown): boolean {
  if (error instanceof MissingConfigError) return true;
  return error instanceof UpstreamApiError && [401, 403, 429].includes(error.status);
}

/** The row for a URL Google did not answer for. */
function notInspected(url: string, error: unknown): Inspected {
  logError(`inspect ${url}`, error);
  return {
    url,
    ok: false,
    // `UpstreamApiError`'s message is ours — the service, the status and a fixed
    // sentence — so it can be printed. Anything else is a driver's string, and
    // this reason reaches the Tool's output.
    reason:
      error instanceof UpstreamApiError
        ? error.message
        : "URL Inspection did not complete for this URL; the cause is in the server log.",
  };
}

/**
 * Google's inspection of each URL, in the order given.
 *
 * Rejects on a refusal for the property or the day, once the batch it came in
 * has settled; records anything else against its URL. See the header for why the
 * line falls there. A URL listed twice is inspected once.
 */
export async function inspectPages(
  reader: SearchConsoleReader,
  property: string,
  urls: readonly string[],
): Promise<Inspected[]> {
  const unique = [...new Set(urls)];
  const byUrl = new Map<string, Inspected>();

  for (let start = 0; start < unique.length; start += INSPECTION_CONCURRENCY) {
    const batch = unique.slice(start, start + INSPECTION_CONCURRENCY);
    const settled = await Promise.allSettled(batch.map((url) => inspectUrlOnce(reader, property, url)));

    const refusal = settled.find(
      (outcome): outcome is PromiseRejectedResult => outcome.status === "rejected" && refusesTheCall(outcome.reason),
    );
    if (refusal) throw refusal.reason;

    settled.forEach((outcome, index) => {
      const url = batch[index];
      byUrl.set(
        url,
        outcome.status === "fulfilled"
          ? { url, ok: true, inspection: outcome.value, summary: summarise(outcome.value) }
          : notInspected(url, outcome.reason),
      );
    });
  }

  return urls.map((url) => byUrl.get(url)!);
}

// ── 3. What each page says for itself ────────────────────────────────────────

export type PageRead =
  | {
      ok: true;
      /** The URL asked for. `page.url` is where it landed, after redirects. */
      url: string;
      page: ParsedPage;
      /** The response headers, lowercased, for an analyzer that reads one. */
      headers: Readonly<Record<string, string>>;
    }
  | { ok: false; url: string; reason: string };

/** How many pages are read at once. The pace is `crawl-pacing`'s either way. */
const READ_CONCURRENCY = 3;

async function readOne(url: string): Promise<PageRead> {
  try {
    const read = await fetchAuditablePage(url);
    if (!read.ok) return { ok: false, url, reason: read.reason };
    return { ok: true, url, page: readPage(read.finalUrl, read.html), headers: read.headers };
  } catch (error) {
    if (error instanceof RobotsDisallowedError) return { ok: false, url, reason: ROBOTS_REFUSAL };
    throw error;
  }
}

/** Each page, in the order given, a few at a time, or one sentence on why it was not checked. */
export async function readPages(urls: readonly string[]): Promise<PageRead[]> {
  const out: PageRead[] = [];
  for (let start = 0; start < urls.length; start += READ_CONCURRENCY) {
    out.push(...(await Promise.all(urls.slice(start, start + READ_CONCURRENCY).map(readOne))));
  }
  return out;
}

// ── 4. What was sampled ──────────────────────────────────────────────────────

/** What a sample owes the basis section, and which of its inspections did not complete. */
export interface SampleNote {
  /** A `Basis` part: how many were chosen, of what, by what, and what the inspections cost. */
  read: string[];
  /** The inspections that did not complete, for `notCheckedSection`. */
  notChecked: NotChecked[];
}

/**
 * What the sentence under `NOT CHECKED` says about a failed inspection.
 *
 * No figure counts those pages, and saying so under the heading is what keeps a
 * reader from taking a figure over the rest for a figure over the sample.
 */
export const UNINSPECTED_NOTE = "An inspection that did not complete leaves its page in no figure above.";

/**
 * What every Tool built on a sample owes its reader.
 *
 * Without it the report reads as a statement about the site, and it is a
 * statement about twenty pages. With inspections it also says what they cost
 * against the day's allowance, and which ones did not complete — no figure
 * counts those, so they are returned for the Tool's `NOT CHECKED` section with
 * their reasons.
 *
 * Returned as parts rather than lines so the sample is one part of the basis
 * section, beside Search Console's rows, rather than a second section competing
 * with it.
 *
 * `of` names what `reported` counts, for a Tool whose candidates are not Search
 * Console's pages.
 */
export function sampleNote(sample: {
  reported: number;
  chosen: number;
  by: Metric;
  inspected?: readonly Inspected[];
  of?: string;
}): SampleNote {
  const of = sample.of ?? "page(s) Search Console reported for this window";
  const read = [`Sample: ${sample.chosen} of the ${sample.reported} ${of}, chosen by ${sample.by}.`];

  if (!sample.inspected) return { read, notChecked: [] };

  if (sample.reported > sample.chosen) {
    read.push(
      "The rest were not inspected. Google rations URL Inspection per property per day, so the " +
        "allowance is spent on the pages most worth knowing about rather than on all of them.",
    );
  }

  const spent = new Set(sample.inspected.map((entry) => entry.url)).size;
  read.push(
    `URL Inspection: ${spent} URL(s) inspected for this report, which spends at most ${spent} of ` +
      `the ${DAILY_INSPECTIONS.toLocaleString("en-US")} Google allows per property per day — fewer ` +
      `where an inspection made in the last hour by any Tool here was reused.`,
  );

  const notChecked = sample.inspected
    .filter((entry): entry is Extract<Inspected, { ok: false }> => !entry.ok)
    .map((entry) => ({ subject: entry.url, reason: entry.reason }));

  return { read, notChecked };
}
