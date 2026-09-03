/**
 * The PageSpeed Insights API, which is two measurements in one response.
 *
 * **Field data** is CrUX: what real Chrome users experienced on this URL over the
 * last 28 days. It is the one Google actually ranks on, and it is absent for any
 * URL without enough traffic — which is most URLs. **Lab data** is Lighthouse run
 * once, in a datacentre, on a throttled connection. It is always available and it
 * is a diagnostic, not a measurement of anyone's experience.
 *
 * They are kept apart all the way through this module and into the Tool's output,
 * because collapsing them is the mistake this API invites: a page with a 98 lab
 * score and SLOW field data is a page that is slow for its users, and a report
 * that averaged the two would say the opposite.
 *
 * This is the only Tool on this server that needs configuration. See
 * `required-config.ts` and ADR-0003 for what it does when it has none.
 */
import { createSingleFlightCache } from "./single-flight";
import { fetchThirdPartyApi } from "./http-client";
import { requireConfig, type ConfigRequirement } from "./required-config";
import { UpstreamApiError } from "./upstream-api-error";
import { isRecord } from "./type-guards";

/**
 * What this Tool needs configured, and the sentence an Operator without it reads.
 *
 * Named for the requirement rather than the key, because it is not the key: it is
 * the description of one. Exported so the Tool can name the same variable in its
 * own description without a second copy of the string going stale against this
 * one.
 */
export const PAGESPEED_KEY_REQUIREMENT: ConfigRequirement = {
  variable: "PAGESPEED_API_KEY",
  purpose: "call Google's PageSpeed Insights API, which this Tool has no other source for",
  howToGet:
    "Create an API key at https://console.cloud.google.com/apis/credentials and enable " +
    "the PageSpeed Insights API for its project; the free quota is 25,000 requests a day " +
    "and needs no billing account.",
};

/** How the API is named in a refusal, in the Operator's words rather than the endpoint's. */
const SERVICE = "Google's PageSpeed Insights API";

/**
 * Per-request ceiling for one PageSpeed call.
 *
 * PSI runs Lighthouse server-side, so it is legitimately slower than every other
 * external fetch in this codebase — those use 5–12s. 45s is generous against real
 * PSI latency and still bounded.
 *
 * It has to be bounded because nothing above it is: Node's `fetch` has no default
 * request timeout, so an unbounded request is an agent turn that never comes back
 * and a Tool call the client eventually gives up on with nothing to show.
 */
export const PAGESPEED_REQUEST_TIMEOUT_MS = 45_000;

/** What the API reports on when the caller does not narrow it. */
const DEFAULT_CATEGORIES = ["performance", "accessibility", "best-practices", "seo"] as const;

export type Strategy = "mobile" | "desktop";
export type CrUXCategory = "FAST" | "AVERAGE" | "SLOW";

export interface LighthouseAuditResult {
  id: string;
  title: string;
  score: number | null;
  displayValue?: string;
  description?: string;
}

export interface CrUXMetric {
  percentile: number;
  distributions: Array<{ min?: number; max?: number; proportion: number }>;
  category: CrUXCategory;
}

export interface PageSpeedInsightsParams {
  url: string;
  strategy?: Strategy;
  categories?: string[];
}

/**
 * The CrUX metrics, keyed as the API keys them.
 *
 * Every one optional: CrUX reports what it has enough samples for, and INP
 * replaced FID as a ranking signal without the older key disappearing — so a
 * response may carry either, both, or neither.
 */
export interface FieldMetrics {
  LARGEST_CONTENTFUL_PAINT_MS?: CrUXMetric;
  FIRST_INPUT_DELAY_MS?: CrUXMetric;
  CUMULATIVE_LAYOUT_SHIFT_SCORE?: CrUXMetric;
  FIRST_CONTENTFUL_PAINT_MS?: CrUXMetric;
  INTERACTION_TO_NEXT_PAINT?: CrUXMetric;
  EXPERIMENTAL_TIME_TO_FIRST_BYTE?: CrUXMetric;
}

export interface FieldData {
  overallCategory: CrUXCategory | null;
  metrics: FieldMetrics;
}

export interface PageSpeedInsightsResult {
  url: string;
  strategy: Strategy;
  /** `null` when this URL has too little Chrome traffic for CrUX to report on. */
  fieldData: FieldData | null;
  labData: LabData;
}

/**
 * The six Lighthouse timings, already formatted in the units a reader thinks in.
 *
 * Named fields rather than a `Record<string, string>`: `readLabMetrics` always
 * produces exactly these six and the renderer reads them by name, so the record
 * bought nothing and lost the compiler's check that the two agree.
 */
export interface LabMetrics {
  firstContentfulPaint: string;
  largestContentfulPaint: string;
  totalBlockingTime: string;
  cumulativeLayoutShift: string;
  speedIndex: string;
  interactive: string;
}

export interface LabData {
  performance: number | null;
  accessibility: number | null;
  bestPractices: number | null;
  seo: number | null;
  /** `null` when the response carried no metrics audit to read. */
  metrics: LabMetrics | null;
  failedAudits: LighthouseAuditResult[];
}

/**
 * One call per URL and strategy per window, shared by every caller in it.
 *
 * Worth more here than anywhere else in the codebase: a PSI call takes tens of
 * seconds and spends one of a finite daily quota, so an agent asking for mobile
 * twice in a turn should pay for it once.
 */
const insightsCache = createSingleFlightCache<PageSpeedInsightsResult>();

/**
 * Run PageSpeed Insights for one URL.
 *
 * @throws {MissingConfigError} when `PAGESPEED_API_KEY` is not set. Thrown before
 *         anything is fetched, so an unconfigured server never reaches Google.
 * @throws {UpstreamApiError} when the API answers with something other than data.
 */
export function runPageSpeedInsights(
  params: PageSpeedInsightsParams,
): Promise<PageSpeedInsightsResult> {
  const strategy = params.strategy ?? "mobile";
  const key = `${params.url} ${strategy} ${cacheableCategories(params.categories)}`;
  return insightsCache.run(key, () => fetchInsights({ ...params, strategy }));
}

/**
 * The categories, spelled the one way that makes identical requests share a key.
 *
 * They have to be *part* of the key: asking for performance alone and asking for
 * all four are different requests, and sharing an entry would hand one caller a
 * result missing the sections they asked for. But two spellings of one request
 * must not be two keys, and the naive `(categories ?? []).join(",")` gave three
 * of them — omitting the argument keyed as `""` while passing all four keyed as
 * the full list, and `["seo","performance"]` keyed apart from
 * `["performance","seo"]`. Every extra key is a duplicate call taking tens of
 * seconds and one more request out of a finite daily quota.
 */
function cacheableCategories(categories: string[] | undefined): string {
  return [...(categories ?? DEFAULT_CATEGORIES)].sort().join(",");
}

async function fetchInsights(
  params: PageSpeedInsightsParams & { strategy: Strategy },
): Promise<PageSpeedInsightsResult> {
  // First, and before any network call: an unconfigured server should refuse in
  // a sentence rather than time out against an endpoint it cannot authenticate to.
  const apiKey = requireConfig(PAGESPEED_KEY_REQUIREMENT);

  const apiUrl = new URL("https://www.googleapis.com/pagespeedonline/v5/runPagespeed");
  apiUrl.searchParams.set("url", params.url);
  apiUrl.searchParams.set("key", apiKey);
  apiUrl.searchParams.set("strategy", params.strategy === "desktop" ? "DESKTOP" : "MOBILE");

  for (const category of params.categories ?? DEFAULT_CATEGORIES) {
    apiUrl.searchParams.append("category", category.toUpperCase().replace(/-/g, "_"));
  }

  // `fetchThirdPartyApi` rather than `fetchAnyStatus`: this is a fixed Google
  // endpoint rather than an Operator-supplied URL, so there is no SSRF question
  // to answer and it is not a site whose robots.txt is addressed to us. That
  // reasoning was written here and acted on by calling the global `fetch`, which
  // also opted out of the pace and of the fetch scope — neither of which the
  // argument covers. The timeout is load-bearing rather than defensive; see
  // PAGESPEED_REQUEST_TIMEOUT_MS.
  const response = await fetchThirdPartyApi(apiUrl.toString(), {
    timeout: PAGESPEED_REQUEST_TIMEOUT_MS,
  });

  if (!response.ok) {
    throw await UpstreamApiError.fromResponse(SERVICE, response);
  }

  return readInsights(await response.json(), params.url, params.strategy);
}

/**
 * The response, read defensively.
 *
 * Every field below is optional in practice: `loadingExperience` is absent for a
 * URL without CrUX traffic, and a category the caller did not ask for is simply
 * not in `categories`. Reading them as though they were guaranteed is how a Tool
 * turns "this page has no field data" into a crash.
 *
 * Separated from the fetch so it can be tested against a captured payload
 * without a network call.
 */
export function readInsights(
  payload: unknown,
  url: string,
  strategy: Strategy,
): PageSpeedInsightsResult {
  const data = isRecord(payload) ? payload : {};

  const loadingExperience = isRecord(data.loadingExperience) ? data.loadingExperience : null;
  const fieldData: FieldData | null = loadingExperience
    ? {
        overallCategory: (loadingExperience.overall_category as CrUXCategory) ?? null,
        metrics: (isRecord(loadingExperience.metrics)
          ? loadingExperience.metrics
          : {}) as FieldMetrics,
      }
    : null;

  const lhr = isRecord(data.lighthouseResult) ? data.lighthouseResult : {};
  const audits = isRecord(lhr.audits) ? lhr.audits : {};
  const categories = isRecord(lhr.categories) ? lhr.categories : {};

  const failedAudits = collectFailedAudits(audits, categories.performance);
  const metrics = readLabMetrics(audits.metrics);

  return {
    url,
    strategy,
    fieldData,
    labData: {
      performance: categoryScore(categories.performance),
      accessibility: categoryScore(categories.accessibility),
      bestPractices: categoryScore(categories["best-practices"]),
      seo: categoryScore(categories.seo),
      metrics,
      failedAudits,
    },
  };
}

function categoryScore(category: unknown): number | null {
  if (!isRecord(category)) return null;
  return typeof category.score === "number" ? category.score : null;
}

/**
 * The performance audits that did not pass.
 *
 * `notApplicable` and `manual` are skipped because they are not results: the
 * first is an audit that does not apply to this page, the second one Lighthouse
 * declines to judge. Listing either under "failed" reports a verdict nobody gave.
 */
function collectFailedAudits(
  audits: Record<string, unknown>,
  performance: unknown,
): LighthouseAuditResult[] {
  if (!isRecord(performance) || !Array.isArray(performance.auditRefs)) return [];

  const failed: LighthouseAuditResult[] = [];
  for (const ref of performance.auditRefs) {
    if (!isRecord(ref) || typeof ref.id !== "string") continue;
    const audit = audits[ref.id];
    if (!isRecord(audit)) continue;
    if (audit.score === 1) continue;
    if (audit.scoreDisplayMode === "notApplicable" || audit.scoreDisplayMode === "manual") continue;

    failed.push({
      id: String(audit.id ?? ref.id),
      title: String(audit.title ?? ref.id),
      score: typeof audit.score === "number" ? audit.score : null,
      displayValue: typeof audit.displayValue === "string" ? audit.displayValue : undefined,
      description:
        typeof audit.description === "string"
          ? (audit.description.split("[Learn more]")[0]?.trim() || undefined)
          : undefined,
    });
  }
  return failed;
}

/** The lab timings, formatted in the units a reader thinks in. */
function readLabMetrics(metricsAudit: unknown): LabMetrics | null {
  if (!isRecord(metricsAudit)) return null;
  const details = isRecord(metricsAudit.details) ? metricsAudit.details : null;
  const items = details && Array.isArray(details.items) ? details.items : null;
  const first = items?.[0];
  if (!isRecord(first)) return null;

  const seconds = (value: unknown) => `${(num(value) / 1000).toFixed(1)}s`;

  return {
    firstContentfulPaint: seconds(first.firstContentfulPaint),
    largestContentfulPaint: seconds(first.largestContentfulPaint),
    totalBlockingTime: `${Math.round(num(first.totalBlockingTime))}ms`,
    cumulativeLayoutShift:
      typeof first.cumulativeLayoutShift === "number"
        ? first.cumulativeLayoutShift.toFixed(3)
        : "N/A",
    speedIndex: seconds(first.speedIndex),
    interactive: seconds(first.interactive),
  };
}

function num(value: unknown): number {
  return typeof value === "number" ? value : 0;
}
