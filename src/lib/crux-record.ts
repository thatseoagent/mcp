/**
 * The Chrome UX Report API: field data as one reading, and what both CrUX
 * endpoints share.
 *
 * `records:queryRecord` answers "what did real Chrome users experience here over
 * the last 28 days?" — one p75 per metric, recomputed daily. It is the reading
 * `pagespeed_insights` used to take from PageSpeed Insights' `loadingExperience`,
 * and the one `site_vitals_by_traffic` takes per page. `crux-history.ts` asks
 * the sibling endpoint for the same measurement as a weekly series; the key, the
 * quota, the 404 convention, the number formats and the diagnostic metrics are
 * common to both and live here, so the two readers cannot drift apart on any of
 * them.
 *
 * ── The quota is shared, and it is small ──
 *
 * Both endpoints draw on one allowance: 150 queries a minute per Google Cloud
 * project, with no paid tier. Both are asked through {@link queryCrux} with one
 * service description, so `callApi` counts them in one window against that
 * number and a request over it waits for the minute to make room rather than
 * meeting Google's 429. It is somebody else's ceiling in the sense `CONTEXT.md`
 * gives: asking faster does not get more.
 *
 * ── Diagnostics are read, never rated ──
 *
 * Beside the five metrics `vital-thresholds` rates, CrUX serves several that
 * have no threshold at all: the four parts of an image LCP, whether the LCP
 * element was text or an image, how each visit navigated (including the share
 * served from the back/forward cache), and the round trip time of the network
 * visitors arrived on. Google publishes no "good" for any of them, so rating one
 * would be inventing a bar. They are read here and described in words that say
 * what they explain — "the largest part is resource load delay" — and nowhere
 * are they counted towards a pass.
 */
import { callApi, type ThirdPartyService } from "./third-party-api";
import type { ConfigRequirement } from "./required-config";
import { createSingleFlightCache } from "./single-flight";
import { isRecord } from "./type-guards";
import { formatVital, rateVital, vitalLabel, type VitalKey } from "./analyzers/vital-thresholds";

/**
 * The key is `PAGESPEED_API_KEY`: a Google Cloud key works for every API enabled
 * on its project, and asking the Operator for a second key for the same console
 * would be a second thing to configure for no gain. What differs is the API it
 * needs enabled, which is why the requirement below is its own sentence rather
 * than `PAGESPEED_KEY_REQUIREMENT` reused — that one tells the Operator to enable
 * the PageSpeed API, and following it would leave these reads refused with a 403.
 */
export const CRUX_KEY_REQUIREMENT: ConfigRequirement = {
  variable: "PAGESPEED_API_KEY",
  purpose: "call Google's Chrome UX Report API, which is where real-user field data comes from",
  howToGet:
    "Create an API key at https://console.cloud.google.com/apis/credentials and enable the " +
    "Chrome UX Report API for its project. The key pagespeed_insights uses works, once that " +
    "API is enabled beside the PageSpeed Insights API; it needs no billing account.",
};

/** How the API is named in a refusal. */
export const CRUX_SERVICE = "Google's Chrome UX Report API";

const RECORD_ENDPOINT = "https://chromeuxreport.googleapis.com/v1/records:queryRecord";

/** Both endpoints, as `callApi` takes them. */
const CRUX = {
  name: CRUX_SERVICE,
  key: { requirement: CRUX_KEY_REQUIREMENT, in: "query", param: "key" },
  // CrUX answers from a precomputed dataset in well under a second; the ceiling
  // exists because Node's `fetch` has none.
  timeoutMs: 15_000,
  // 404 is how CrUX says "not enough traffic to report on" — its documented
  // answer for a page or origin below its threshold, not a missing endpoint.
  noDataStatuses: [404],
  // 150 queries a minute per Google Cloud project, for `queryRecord` and
  // `queryHistoryRecord` together, with no paid tier to raise it
  // (https://developer.chrome.com/docs/crux/api; `docs/research/api-surface-2026-09.md`
  // §4). One description serves both endpoints, so both count in one window.
  perMinute: 150,
} satisfies ThirdPartyService;

export type FormFactor = "PHONE" | "DESKTOP" | "TABLET";
export type CruxScope = "page" | "origin";

export interface CruxQuery {
  /** A page URL or an origin, according to `scope`. */
  url: string;
  scope: CruxScope;
  /** Omitted: every device combined, which is what the API reports by default. */
  formFactor?: FormFactor;
}

/** The origin, when asked for one: CrUX refuses an origin with a path on it. */
export function cruxSubjectOf(query: CruxQuery): string {
  return query.scope === "origin" ? new URL(query.url).origin : query.url;
}

/**
 * Ask a CrUX endpoint one question: the parsed body, or `null` for CrUX's
 * definite "no data".
 *
 * @throws {MissingConfigError} when no key is configured, before any request.
 * @throws {UpstreamApiError} when the API answers with anything but data or a
 *         definite "no data", or does not answer in time.
 */
export async function queryCrux(endpoint: string, body: Record<string, unknown>): Promise<unknown | null> {
  const answer = await callApi(CRUX, { url: endpoint, json: body });
  return answer.kind === "data" ? answer.body : null;
}

// ── Reading numbers ─────────────────────────────────────────────────────────

/**
 * A reading, or `null` for one CrUX did not have.
 *
 * CrUX writes a missing p75 as `null` and a missing density or fraction as the
 * string `"NaN"`, and writes CLS's p75 as a string ("0.05") because it is not an
 * integer. One reader for all three, so none of them becomes a zero — which would
 * be a perfect CLS or an instant LCP in a period where nothing was measured.
 */
export function cruxNumber(value: unknown): number | null {
  const parsed = typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
  return Number.isFinite(parsed) ? parsed : null;
}

/** `{year, month, day}` as `YYYY-MM-DD`, or "unknown". */
export function cruxDate(date: unknown): string {
  if (!isRecord(date)) return "unknown";
  const { year, month, day } = date;
  if (typeof year !== "number" || typeof month !== "number" || typeof day !== "number") {
    return "unknown";
  }
  return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

/** What CrUX actually looked up, after its own normalisation of the URL. */
export function cruxRecordSubject(record: Record<string, unknown>, asked: string): string {
  const key = isRecord(record.key) ? record.key : {};
  if (typeof key.url === "string") return key.url;
  if (typeof key.origin === "string") return key.origin;
  return asked;
}

// ── The metrics ─────────────────────────────────────────────────────────────

/**
 * The API's names for the metrics `vital-thresholds` rates.
 *
 * Only these are rated. Listing the five is what keeps an unrecognised metric
 * from being printed as if it had a threshold.
 */
export const RATED_METRICS: ReadonlyArray<readonly [string, VitalKey]> = [
  ["largest_contentful_paint", "lcp"],
  ["interaction_to_next_paint", "inp"],
  ["cumulative_layout_shift", "cls"],
  ["first_contentful_paint", "fcp"],
  ["experimental_time_to_first_byte", "ttfb"],
];

export type LcpSubpart = "ttfb" | "loadDelay" | "loadDuration" | "renderDelay";

/**
 * The four parts of an image LCP, in the order they happen, with what a large
 * one usually means.
 *
 * CrUX reports each only for visits whose LCP element was an image, and each as
 * its own 75th percentile. So the four do not add up to the LCP p75, and Google
 * says to read them against each other rather than as a breakdown of it — which
 * is exactly how they are used below: to say which part is largest.
 *
 * The `usually` sentences are web.dev's guidance on optimising LCP, restated;
 * they are the common cause of a large part, not a finding about this page.
 */
export const LCP_SUBPARTS: ReadonlyArray<{
  metric: string;
  part: LcpSubpart;
  label: string;
  usually: string;
}> = [
  {
    metric: "largest_contentful_paint_image_time_to_first_byte",
    part: "ttfb",
    label: "Time to first byte",
    usually: "the HTML itself arrives late — server time, redirects or no edge caching",
  },
  {
    metric: "largest_contentful_paint_image_resource_load_delay",
    part: "loadDelay",
    label: "Resource load delay",
    usually:
      "the browser started fetching the image late — it was not in the HTML, was " +
      "lazy-loaded, or was queued behind other requests",
  },
  {
    metric: "largest_contentful_paint_image_resource_load_duration",
    part: "loadDuration",
    label: "Resource load duration",
    usually: "the image itself is slow to download — its weight, its format, or where it is served from",
  },
  {
    metric: "largest_contentful_paint_image_element_render_delay",
    part: "renderDelay",
    label: "Element render delay",
    usually:
      "the image had arrived and waited to be painted — render-blocking CSS or " +
      "JavaScript, or the element being added by script",
  },
];

/** How each navigation label reads in a sentence. */
const NAVIGATION_LABELS: Record<string, string> = {
  navigate: "navigate",
  navigate_cache: "navigate (HTTP cache)",
  reload: "reload",
  restore: "restore (discarded tab)",
  back_forward: "back/forward (full load)",
  back_forward_cache: "back/forward (bfcache)",
  prerender: "prerender",
};

/** One of the rated metrics, as CrUX reported it. */
export interface FieldVital {
  key: VitalKey;
  /** The 75th percentile, or `null` when CrUX had too few samples. */
  p75: number | null;
  /** The share of visits in each of CrUX's three buckets, or `null` if not reported. */
  shares: { good: number | null; needsImprovement: number | null; poor: number | null } | null;
}

/**
 * The metrics nobody publishes a threshold for, at one point in time.
 *
 * Fractions are 0–1, keyed by CrUX's own labels; an empty record means the
 * metric was not in the response.
 */
export interface CruxDiagnostics {
  lcpSubparts: Array<{ part: LcpSubpart; p75: number | null }>;
  lcpResourceType: Record<string, number | null>;
  navigationTypes: Record<string, number | null>;
  /** The p75 round trip time, in milliseconds. */
  roundTripTime: number | null;
}

/** p75 of a `queryRecord` metric. */
function p75Of(metric: unknown): number | null {
  if (!isRecord(metric)) return null;
  const percentiles = isRecord(metric.percentiles) ? metric.percentiles : {};
  return cruxNumber(percentiles.p75);
}

function fractionsOf(metric: unknown): Record<string, number | null> {
  if (!isRecord(metric) || !isRecord(metric.fractions)) return {};
  const out: Record<string, number | null> = {};
  for (const [label, value] of Object.entries(metric.fractions)) out[label] = cruxNumber(value);
  return out;
}

/** The diagnostics out of a `queryRecord` response's `metrics`. Exported for `readRecord`'s test. */
export function readRecordDiagnostics(metrics: Record<string, unknown>): CruxDiagnostics {
  return {
    lcpSubparts: LCP_SUBPARTS.map(({ metric, part }) => ({ part, p75: p75Of(metrics[metric]) })),
    lcpResourceType: fractionsOf(metrics.largest_contentful_paint_resource_type),
    navigationTypes: fractionsOf(metrics.navigation_types),
    roundTripTime: p75Of(metrics.round_trip_time),
  };
}

// ── Saying what the diagnostics mean ────────────────────────────────────────

function pct(share: number): string {
  return `${Math.round(share * 100)}%`;
}

/** A duration in the unit a reader thinks in. */
export function formatMs(value: number): string {
  return value >= 1000 ? `${(value / 1000).toFixed(1)}s` : `${Math.round(value)}ms`;
}

/**
 * The largest of the four LCP parts, or `null` unless all four have a reading.
 *
 * All four, because the missing one could be the largest: naming a winner from
 * three readings would be a claim about a part nobody measured.
 */
export function largestLcpSubpart(
  subparts: CruxDiagnostics["lcpSubparts"],
): (typeof LCP_SUBPARTS)[number] | null {
  const read = subparts.filter((s): s is { part: LcpSubpart; p75: number } => s.p75 !== null);
  if (read.length < LCP_SUBPARTS.length) return null;
  const largest = read.reduce((a, b) => (b.p75 > a.p75 ? b : a));
  return LCP_SUBPARTS.find((s) => s.part === largest.part) ?? null;
}

/**
 * Of the back/forward navigations, the share the bfcache served.
 *
 * The figure an Operator can move: a back/forward navigation that missed the
 * cache is a full page load that did not need to be one. `null` when CrUX
 * reported neither label, since a missing share is not a zero.
 */
export function bfcacheHitRate(navigationTypes: Record<string, number | null>): number | null {
  const hit = navigationTypes.back_forward_cache;
  const miss = navigationTypes.back_forward;
  if (hit === null || hit === undefined || miss === null || miss === undefined) return null;
  return hit + miss > 0 ? hit / (hit + miss) : null;
}

/**
 * The diagnostics in sentences. Nothing here is rated; every line says what it
 * explains, and what is missing is said to be missing.
 *
 * @param indent prefix for every line, so a caller can nest the block.
 */
export function describeDiagnostics(diagnostics: CruxDiagnostics, indent = "  "): string[] {
  const lines: string[] = [];

  const image = diagnostics.lcpResourceType.image;
  const text = diagnostics.lcpResourceType.text;
  if ((image ?? null) !== null || (text ?? null) !== null) {
    const parts = [
      image !== null && image !== undefined ? `an image on ${pct(image)} of visits` : null,
      text !== null && text !== undefined ? `text on ${pct(text)}` : null,
    ].filter(Boolean);
    lines.push(`${indent}LCP element: ${parts.join(", ")}.`);
  }

  const subparts = diagnostics.lcpSubparts.filter((s) => s.p75 !== null);
  if (subparts.length > 0) {
    lines.push(`${indent}Image LCP, by part (each its own 75th percentile; they do not sum to the LCP):`);
    const largest = largestLcpSubpart(diagnostics.lcpSubparts);
    for (const { part, p75 } of diagnostics.lcpSubparts) {
      const meta = LCP_SUBPARTS.find((s) => s.part === part);
      if (!meta) continue;
      const mark = largest?.part === part ? " — the largest" : "";
      lines.push(`${indent}  ${meta.label}: ${p75 === null ? "no reading" : formatMs(p75)}${mark}`);
    }
    if (largest) {
      lines.push(
        `${indent}  The largest part is ${largest.label.toLowerCase()}. A large one usually means ` +
          `${largest.usually} (the common cause, not a finding about this page).`,
      );
    }
  }

  const navigation = Object.entries(diagnostics.navigationTypes)
    .filter((entry): entry is [string, number] => entry[1] !== null && entry[1] > 0)
    .sort((a, b) => b[1] - a[1]);
  if (navigation.length > 0) {
    lines.push(
      `${indent}How visits navigated: ` +
        navigation.map(([label, share]) => `${NAVIGATION_LABELS[label] ?? label} ${pct(share)}`).join(", ") +
        ".",
    );
    const hitRate = bfcacheHitRate(diagnostics.navigationTypes);
    if (hitRate !== null) {
      lines.push(
        `${indent}  bfcache share: ${pct(hitRate)} of back/forward navigations were restored ` +
          "instantly from the back/forward cache; the rest loaded the page again.",
      );
    }
  }

  if (diagnostics.roundTripTime !== null) {
    lines.push(
      `${indent}Round trip time (p75): ${formatMs(diagnostics.roundTripTime)} — the network ` +
        "visitors arrive on, not the site's speed. A high figure puts a floor under every other one.",
    );
  }

  if (lines.length === 0) {
    lines.push(`${indent}CrUX reported no diagnostic metrics for this subject.`);
  }
  return lines;
}

// ── One record ──────────────────────────────────────────────────────────────

export interface CruxRecord {
  /** What CrUX actually looked up, after its own normalisation of the URL. */
  subject: string;
  scope: CruxScope;
  formFactor: FormFactor | "ALL";
  /** The 28-day window this reading covers, `YYYY-MM-DD`. */
  periodStart: string;
  periodEnd: string;
  /** Every rated metric CrUX reported, in `RATED_METRICS` order. */
  vitals: FieldVital[];
  diagnostics: CruxDiagnostics;
}

/**
 * Either the record, or CrUX's definite answer that it has none.
 *
 * `no-data` is a result, not a failure: CrUX reports on a page or origin only
 * once it has enough Chrome traffic, and saying so is the correct and complete
 * answer for most pages.
 */
export type CruxRecordResult =
  | { kind: "record"; record: CruxRecord }
  | { kind: "no-data"; subject: string; scope: CruxScope; formFactor: FormFactor | "ALL" };

const recordCache = createSingleFlightCache<CruxRecordResult>();

/**
 * Read the current 28-day field data for a page or an origin.
 *
 * Cached per subject and device, so the twenty pages of one origin that all fall
 * back to the origin record cost one request, not twenty.
 *
 * @throws {MissingConfigError} when no key is configured, before any request.
 * @throws {UpstreamApiError} when the API answers with anything but data or a
 *         definite "no data".
 */
export function readCruxRecord(query: CruxQuery): Promise<CruxRecordResult> {
  const subject = cruxSubjectOf(query);
  const formFactor = query.formFactor ?? "ALL";
  const key = `${query.scope} ${subject} ${formFactor}`;
  return recordCache.run(key, async () => {
    const payload = await queryCrux(RECORD_ENDPOINT, {
      [query.scope === "origin" ? "origin" : "url"]: subject,
      ...(query.formFactor ? { formFactor: query.formFactor } : {}),
    });
    if (payload === null) return { kind: "no-data", subject, scope: query.scope, formFactor };
    return readRecord(payload, query.scope, subject, formFactor);
  });
}

/**
 * The response, read defensively and separated from the fetch so it can be
 * tested against a captured payload.
 *
 * Exported for that test alone.
 */
export function readRecord(
  payload: unknown,
  scope: CruxScope,
  asked: string,
  formFactor: FormFactor | "ALL",
): CruxRecordResult {
  const data = isRecord(payload) ? payload : {};
  const record = isRecord(data.record) ? data.record : null;
  if (!record) return { kind: "no-data", subject: asked, scope, formFactor };

  const period = isRecord(record.collectionPeriod) ? record.collectionPeriod : {};
  const metrics = isRecord(record.metrics) ? record.metrics : {};

  const vitals: FieldVital[] = [];
  for (const [apiName, key] of RATED_METRICS) {
    const metric = metrics[apiName];
    if (!isRecord(metric)) continue;
    const histogram = Array.isArray(metric.histogram) ? metric.histogram : [];
    // CrUX's bins for a rated metric are its three rating buckets, in order.
    const density = (i: number) => (isRecord(histogram[i]) ? cruxNumber(histogram[i].density) : null);
    vitals.push({
      key,
      p75: p75Of(metric),
      shares: histogram.length > 0
        ? { good: density(0), needsImprovement: density(1), poor: density(2) }
        : null,
    });
  }

  return {
    kind: "record",
    record: {
      subject: cruxRecordSubject(record, asked),
      scope,
      formFactor,
      periodStart: cruxDate(period.firstDate),
      periodEnd: cruxDate(period.lastDate),
      vitals,
      diagnostics: readRecordDiagnostics(metrics),
    },
  };
}

// ── Assessing and printing rated vitals ─────────────────────────────────────

/** Google's three, in the order Google lists them. */
export const RANKING_VITALS: readonly VitalKey[] = ["lcp", "inp", "cls"];

export type Assessment =
  | { verdict: "passes" }
  | { verdict: "fails"; failing: VitalKey[]; missing: VitalKey[] }
  | { verdict: "unassessable"; missing: VitalKey[] };

/**
 * Google's rule: a reading passes when LCP, INP and CLS are all "good" at the
 * 75th percentile.
 *
 * A vital with no reading makes a reading unassessable rather than a pass,
 * because a missing INP is not a fast one — unless another vital already fails,
 * in which case the answer is known whatever the missing one says.
 */
export function assessVitals(vitals: readonly FieldVital[]): Assessment {
  const failing: VitalKey[] = [];
  const missing: VitalKey[] = [];
  for (const key of RANKING_VITALS) {
    const p75 = vitals.find((v) => v.key === key)?.p75 ?? null;
    if (p75 === null) missing.push(key);
    else if (rateVital(key, p75) !== "good") failing.push(key);
  }
  if (failing.length > 0) return { verdict: "fails", failing, missing };
  if (missing.length > 0) return { verdict: "unassessable", missing };
  return { verdict: "passes" };
}

/** The assessment in one sentence. */
export function describeAssessment(assessment: Assessment): string {
  const names = (keys: VitalKey[]) => keys.map((k) => vitalLabel(k).label).join(", ");
  if (assessment.verdict === "passes") {
    return "passes — LCP, INP and CLS are all good at the 75th percentile.";
  }
  if (assessment.verdict === "unassessable") {
    return (
      `cannot be assessed — no reading for ${names(assessment.missing)}. This is the absence ` +
      "of a measurement, not a failing one."
    );
  }
  const also = assessment.missing.length > 0 ? ` (no reading for ${names(assessment.missing)})` : "";
  return `does not pass — ${names(assessment.failing)} not good at the 75th percentile${also}. Google's bar is all three.`;
}

/** "LCP 3.1s (needs improvement)", or "LCP no reading". */
export function describeVital(key: VitalKey, p75: number | null): string {
  const { label } = vitalLabel(key);
  return p75 === null ? `${label} no reading` : `${label} ${formatVital(key, p75)} (${rateVital(key, p75)})`;
}
