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
 * ── Where the field data comes from now ──
 *
 * Google has announced that PSI will stop including CrUX field data ("We plan to
 * discontinue including real-world data from the Chrome User Experience Report
 * in this API", with no date) and points callers at the CrUX API. So the field
 * half is read from the CrUX API directly, and PSI's copy is kept only as the
 * fallback {@link chooseFieldData} describes. The lab half is PSI's alone and
 * unchanged.
 *
 * See `required-config.ts` and ADR-0003 for what this does with no key.
 */
import { createSingleFlightCache } from "./single-flight";
import { callApi, DEFAULT_PER_MINUTE, type ThirdPartyService } from "./third-party-api";
import type { ConfigRequirement } from "./required-config";
import { UpstreamApiError } from "./upstream-api-error";
import { isRecord } from "./type-guards";
import {
  readCruxRecord,
  type CruxRecord,
  type CruxScope,
  type FieldVital,
  type FormFactor,
} from "./crux-record";
import type { VitalKey } from "./analyzers/vital-thresholds";

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

const ENDPOINT = "https://www.googleapis.com/pagespeedonline/v5/runPagespeed";

const PAGESPEED = {
  /** In the Operator's words rather than the endpoint's. */
  name: "Google's PageSpeed Insights API",
  key: { requirement: PAGESPEED_KEY_REQUIREMENT, in: "query", param: "key" },
  /**
   * Per-request ceiling for one PageSpeed call.
   *
   * PSI runs Lighthouse server-side, so it is legitimately slower than the other
   * Google APIs here, which are given 15–20s. 45s is generous against real PSI
   * latency and still bounded.
   *
   * It has to be bounded because nothing above it is: Node's `fetch` has no
   * default request timeout, so an unbounded request is an agent turn that never
   * comes back and a Tool call the client eventually gives up on with nothing to
   * show. Running out of it is now said in a sentence naming the 45 seconds;
   * before `callApi`, the abort escaped as an error nobody here authored.
   */
  timeoutMs: 45_000,
  /**
   * The free quota is a daily one, the 25,000 the requirement above names, and
   * Google's PSI documentation states no per-minute figure
   * (https://developers.google.com/speed/docs/insights/v5/get-started, read
   * 2026-09-24), so the default ceiling applies. It is not what binds: a run
   * takes Lighthouse's tens of seconds, and a Tool asks for one.
   */
  perMinute: DEFAULT_PER_MINUTE,
} satisfies ThirdPartyService;

/** What the API reports on when the caller does not narrow it. */
const DEFAULT_CATEGORIES = ["performance", "accessibility", "best-practices", "seo"] as const;

/**
 * Lighthouse's category ids, as a caller names them.
 *
 * `agentic-browsing` arrived in Lighthouse 13.3 (how an agent's accessibility
 * tree, WebMCP and llms.txt read the page). PSI's reference lists only the four
 * above in its `category` enum, so whether it accepts this one from a
 * third-party caller is unknown until it is asked; it is opt-in and never in the
 * default, so a refusal can cost only the caller who asked. See
 * {@link fetchInsights} for what happens when PSI refuses it.
 */
export type PsiCategory = (typeof DEFAULT_CATEGORIES)[number] | "agentic-browsing";

/** The categories PSI's reference does not list, which it may refuse. */
const UNLISTED_CATEGORIES: readonly PsiCategory[] = ["agentic-browsing"];

export type Strategy = "mobile" | "desktop";

export interface LighthouseAuditResult {
  id: string;
  title: string;
  score: number | null;
  displayValue?: string;
  description?: string;
}

export interface PageSpeedInsightsParams {
  url: string;
  strategy?: Strategy;
  categories?: PsiCategory[];
}

/**
 * PSI's copy of the CrUX reading, in the shape the CrUX API's reading has.
 *
 * Converted on the way in so the Tool renders one shape whichever source the
 * field data came from; the only difference a reader should see is the line
 * naming the source.
 */
export interface PsiFieldData {
  /** `origin` when PSI substituted the origin's reading for a page with none. */
  scope: CruxScope;
  vitals: FieldVital[];
}

/** A third-party vendor Lighthouse saw the page load from. */
export interface ThirdPartyVendor {
  name: string;
  /** third-party-web's category — "ad", "analytics", "cdn" — when it knows the vendor. */
  category: string | null;
  /** How many distinct origins Lighthouse attributed to this vendor. */
  origins: number;
  /** Bytes transferred, from the `third-parties-insight` audit; `null` when it did not list the vendor. */
  transferSize: number | null;
  /** Main-thread milliseconds, from the same audit. */
  mainThreadTime: number | null;
}

export interface ThirdParties {
  /** The entity Lighthouse took to be the site itself, if it named one. */
  firstParty: string | null;
  vendors: ThirdPartyVendor[];
  /** Whether the `third-parties-insight` audit was in the response, so sizes could be read. */
  insightRead: boolean;
}

/** The opt-in `agentic-browsing` category, when it was asked for. */
export type AgenticBrowsing =
  | { status: "reported"; score: number | null; failedAudits: LighthouseAuditResult[] }
  /** PSI answered the run but the category was not in it. */
  | { status: "absent" }
  /** PSI rejected the request with the category in it and answered without it. */
  | { status: "refused"; httpStatus: number };

export interface PageSpeedInsightsResult {
  url: string;
  strategy: Strategy;
  /**
   * PSI's own copy of the CrUX reading, which Google is withdrawing. `null` when
   * the response carried none — too little traffic, or after the withdrawal.
   * The Tool's field data comes from {@link chooseFieldData}, not from here.
   */
  psiFieldData: PsiFieldData | null;
  labData: LabData;
  /** `null` when the response carried no `entities` to attribute origins with. */
  thirdParties: ThirdParties | null;
  /** `null` unless the caller asked for `agentic-browsing`. */
  agenticBrowsing: AgenticBrowsing | null;
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

/**
 * One PSI run, and the handling of a category PSI may not accept.
 *
 * A category PSI's reference does not list is asked for as the caller asked,
 * and if PSI answers 400 the run is repeated without it and the result records
 * the refusal. The alternative readings are both worse: failing the whole run
 * would lose the four categories PSI does accept to one it might not, and
 * dropping the category quietly would return a report missing the section that
 * was asked for with nothing to say so. A 400 is a validation answer, so the
 * retry costs a request, not a second Lighthouse run. If the retry is refused
 * too, the 400 was about something else — the URL — and it is thrown as usual.
 */
async function fetchInsights(
  params: PageSpeedInsightsParams & { strategy: Strategy },
): Promise<PageSpeedInsightsResult> {
  const asked: PsiCategory[] = [...(params.categories ?? DEFAULT_CATEGORIES)];
  const wantsAgentic = asked.includes("agentic-browsing");
  const unlisted = asked.filter((c) => UNLISTED_CATEGORIES.includes(c));

  let payload: unknown;
  let refusedStatus: number | null = null;
  try {
    payload = await requestInsights(params, asked);
  } catch (error) {
    // Only a 400, and only when an unlisted category could be why. The body has
    // already gone to stderr with the refusal; nothing of it travels.
    if (!(error instanceof UpstreamApiError && error.status === 400 && unlisted.length > 0)) {
      throw error;
    }
    refusedStatus = error.status;
    // Asked for agentic-browsing alone: performance stands in, because a PSI
    // call with no category runs all of them and the lab half needs one.
    const listed = asked.filter((c) => !UNLISTED_CATEGORIES.includes(c));
    payload = await requestInsights(params, listed.length > 0 ? listed : ["performance"]);
  }

  const result = readInsights(payload, params.url, params.strategy, wantsAgentic);
  if (wantsAgentic && refusedStatus !== null) {
    result.agenticBrowsing = { status: "refused", httpStatus: refusedStatus };
  }
  return result;
}

/**
 * One PSI request, answered with its parsed body.
 *
 * `callApi` requires the key before anything is sent, so an unconfigured server
 * refuses in a sentence rather than timing out against an endpoint it cannot
 * authenticate to.
 */
async function requestInsights(
  params: PageSpeedInsightsParams & { strategy: Strategy },
  categories: readonly PsiCategory[],
): Promise<unknown> {
  const { body } = await callApi(PAGESPEED, {
    url: ENDPOINT,
    query: {
      url: params.url,
      strategy: params.strategy === "desktop" ? "DESKTOP" : "MOBILE",
      category: categories.map((category) => category.toUpperCase().replace(/-/g, "_")),
    },
  });
  return body;
}

/**
 * The response, read defensively.
 *
 * Every field below is optional in practice: `loadingExperience` is absent for a
 * URL without CrUX traffic (and will be absent for every URL once Google stops
 * including it), `entities` depends on the Lighthouse version, and a category
 * the caller did not ask for is simply not in `categories`. Reading them as
 * though they were guaranteed is how a Tool turns "this page has no field data"
 * into a crash.
 *
 * Separated from the fetch so it can be tested against a captured payload
 * without a network call.
 */
function readInsights(
  payload: unknown,
  url: string,
  strategy: Strategy,
  wantsAgentic: boolean,
): PageSpeedInsightsResult {
  const data = isRecord(payload) ? payload : {};

  const lhr = isRecord(data.lighthouseResult) ? data.lighthouseResult : {};
  const audits = isRecord(lhr.audits) ? lhr.audits : {};
  const categories = isRecord(lhr.categories) ? lhr.categories : {};

  const failedAudits = collectFailedAudits(audits, categories.performance);
  const metrics = readLabMetrics(audits.metrics);

  const agentic = categories["agentic-browsing"];
  const agenticBrowsing: AgenticBrowsing | null = !wantsAgentic
    ? null
    : isRecord(agentic)
      ? { status: "reported", score: categoryScore(agentic), failedAudits: collectFailedAudits(audits, agentic) }
      : { status: "absent" };

  return {
    url,
    strategy,
    psiFieldData: readPsiFieldData(data),
    labData: {
      performance: categoryScore(categories.performance),
      accessibility: categoryScore(categories.accessibility),
      bestPractices: categoryScore(categories["best-practices"]),
      seo: categoryScore(categories.seo),
      metrics,
      failedAudits,
    },
    thirdParties: readThirdParties(lhr.entities, audits["third-parties-insight"]),
    agenticBrowsing,
  };
}

/** PSI's metric keys, mapped to the keys `vital-thresholds` rates. */
const PSI_METRICS: ReadonlyArray<readonly [string, VitalKey]> = [
  ["LARGEST_CONTENTFUL_PAINT_MS", "lcp"],
  ["INTERACTION_TO_NEXT_PAINT", "inp"],
  ["CUMULATIVE_LAYOUT_SHIFT_SCORE", "cls"],
  ["FIRST_CONTENTFUL_PAINT_MS", "fcp"],
  ["EXPERIMENTAL_TIME_TO_FIRST_BYTE", "ttfb"],
];

/**
 * PSI's `loadingExperience`, or failing that `originLoadingExperience`, as a
 * CrUX-API-shaped reading.
 *
 * `origin_fallback` is PSI's flag for having put the origin's figures in the
 * page's slot; it is read so the Tool can say "origin" rather than present
 * them as the page's. PSI writes CLS multiplied by 100 so it can be an integer;
 * it is divided back here, because every threshold and every CrUX API reading
 * is the raw score. FID is not read: it is retired, and the CrUX API no longer
 * reports it.
 */
function readPsiFieldData(data: Record<string, unknown>): PsiFieldData | null {
  const page = isRecord(data.loadingExperience) ? data.loadingExperience : null;
  const origin = isRecord(data.originLoadingExperience) ? data.originLoadingExperience : null;
  const pageMetrics = page && isRecord(page.metrics) ? page.metrics : null;
  const chosen = pageMetrics && Object.keys(pageMetrics).length > 0
    ? { metrics: pageMetrics, scope: page?.origin_fallback === true ? "origin" : "page" }
    : origin && isRecord(origin.metrics) && Object.keys(origin.metrics).length > 0
      ? { metrics: origin.metrics, scope: "origin" }
      : null;
  if (!chosen) return null;

  const vitals: FieldVital[] = [];
  for (const [psiKey, key] of PSI_METRICS) {
    const metric = chosen.metrics[psiKey];
    if (!isRecord(metric)) continue;
    const raw = typeof metric.percentile === "number" ? metric.percentile : null;
    const distributions = Array.isArray(metric.distributions) ? metric.distributions : [];
    const share = (i: number) => {
      const bucket = distributions[i];
      return isRecord(bucket) && typeof bucket.proportion === "number" ? bucket.proportion : null;
    };
    vitals.push({
      key,
      p75: raw === null ? null : key === "cls" ? raw / 100 : raw,
      shares: distributions.length > 0
        ? { good: share(0), needsImprovement: share(1), poor: share(2) }
        : null,
    });
  }
  return { scope: chosen.scope as CruxScope, vitals };
}

/**
 * Third-party vendors by origin, from `lighthouseResult.entities`, with bytes
 * and main-thread time joined in from the `third-parties-insight` audit.
 *
 * `entities` is Lighthouse's attribution of every origin the run saw to a web
 * property, via the third-party-web dataset; unrecognised origins are named by
 * their root domain. The audit (Lighthouse 13's replacement for
 * `third-party-summary`) is what carries the costs, keyed by the same entity
 * name, and it leaves out the first party. Either may be missing, and each
 * absence is recorded rather than read as zero.
 */
function readThirdParties(entities: unknown, insight: unknown): ThirdParties | null {
  if (!Array.isArray(entities)) return null;

  const costs = new Map<string, { transferSize: number | null; mainThreadTime: number | null }>();
  const details = isRecord(insight) && isRecord(insight.details) ? insight.details : null;
  const items = details && Array.isArray(details.items) ? details.items : null;
  for (const item of items ?? []) {
    if (!isRecord(item)) continue;
    const name = entityName(item.entity);
    if (!name) continue;
    costs.set(name, {
      transferSize: typeof item.transferSize === "number" ? item.transferSize : null,
      mainThreadTime: typeof item.mainThreadTime === "number" ? item.mainThreadTime : null,
    });
  }

  let firstParty: string | null = null;
  const vendors: ThirdPartyVendor[] = [];
  for (const entity of entities) {
    if (!isRecord(entity) || typeof entity.name !== "string") continue;
    if (entity.isFirstParty === true) {
      firstParty = entity.name;
      continue;
    }
    const cost = costs.get(entity.name);
    vendors.push({
      name: entity.name,
      category: typeof entity.category === "string" ? entity.category : null,
      origins: Array.isArray(entity.origins) ? entity.origins.length : 0,
      transferSize: cost?.transferSize ?? null,
      mainThreadTime: cost?.mainThreadTime ?? null,
    });
  }

  vendors.sort(
    (a, b) => (b.transferSize ?? -1) - (a.transferSize ?? -1) || b.origins - a.origins,
  );
  return { firstParty, vendors, insightRead: items !== null };
}

/** The audit's entity cell: a name, or a text/link value holding one. */
function entityName(cell: unknown): string | null {
  if (typeof cell === "string") return cell;
  if (!isRecord(cell)) return null;
  if (typeof cell.text === "string") return cell.text;
  if (typeof cell.value === "string") return cell.value;
  return null;
}

function categoryScore(category: unknown): number | null {
  if (!isRecord(category)) return null;
  return typeof category.score === "number" ? category.score : null;
}

/**
 * The audits in one category that did not pass.
 *
 * `notApplicable` and `manual` are skipped because they are not results: the
 * first is an audit that does not apply to this page, the second one Lighthouse
 * declines to judge. Listing either under "failed" reports a verdict nobody gave.
 */
function collectFailedAudits(
  audits: Record<string, unknown>,
  category: unknown,
): LighthouseAuditResult[] {
  if (!isRecord(category) || !Array.isArray(category.auditRefs)) return [];

  const failed: LighthouseAuditResult[] = [];
  for (const ref of category.auditRefs) {
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

// ── Field data: which source ────────────────────────────────────────────────

/**
 * What the CrUX API said about this URL, or that it refused to say.
 *
 * `refused` is kept apart from a thrown error because it is the one refusal
 * {@link chooseFieldData} can answer around. Every other failure is thrown.
 */
export type CruxFieldAnswer =
  | { kind: "record"; record: CruxRecord }
  /** CrUX has no record for the page or for its origin. */
  | { kind: "no-data" }
  | { kind: "refused"; status: number };

/**
 * The CrUX API's current reading for a URL: the page's, or the origin's when
 * the page has none.
 *
 * The form factor follows PSI's strategy, so the field half describes the same
 * devices as the lab half: `mobile` is CrUX's `PHONE`.
 *
 * @throws {UpstreamApiError} for any refusal but a 403, which is returned as
 *         `refused` — see {@link chooseFieldData} for why that one alone.
 */
export async function readFieldData(url: string, strategy: Strategy): Promise<CruxFieldAnswer> {
  const formFactor: FormFactor = strategy === "desktop" ? "DESKTOP" : "PHONE";
  try {
    const page = await readCruxRecord({ url, scope: "page", formFactor });
    if (page.kind === "record") return page;
    const origin = await readCruxRecord({ url, scope: "origin", formFactor });
    return origin.kind === "record" ? origin : { kind: "no-data" };
  } catch (error) {
    if (error instanceof UpstreamApiError && error.status === 403) {
      return { kind: "refused", status: error.status };
    }
    throw error;
  }
}

/**
 * The field data the Tool reports, and where it came from.
 *
 * - `crux-api` — the CrUX API's record, the page's or its origin's.
 * - `psi` — the CrUX API refused the key, and PSI still carried its copy.
 * - `none` — no source had a reading. `cruxRefused` says whether the CrUX API
 *   was asked and answered "no data" (`null`) or refused (its status).
 */
export type FieldSource =
  | { source: "crux-api"; record: CruxRecord }
  | { source: "psi"; data: PsiFieldData; cruxStatus: number }
  | { source: "none"; cruxRefused: number | null };

/**
 * Pick the field data's source.
 *
 * ── Why a fallback here does not break ADR-0003 ──
 *
 * The ADR forbids a Tool answering with *less* than its whole job when an
 * input is missing. Reading PSI's `loadingExperience` when the CrUX API refuses
 * is not less: both are the Chrome UX Report, the same 28-day p75 over the same
 * Chrome visits, served through two front doors. Choosing between them is a
 * choice of source for one answer, not a degraded answer — the reading is the
 * same whichever door it came through, and a report built on it is whole.
 *
 * What the ADR does still require is that the Operator is not left to find out
 * by accident, and three things make that hold:
 *
 * - The source is always printed. A reader can see which door it was.
 * - The fallback is taken **only on a 403**, which is how CrUX answers a key
 *   whose project has not enabled the Chrome UX Report API — the state of every
 *   key configured before this Tool read the CrUX API, because the old
 *   instructions only asked for PSI. A 429 or a 5xx is a failure of this moment
 *   and is thrown, with its retry advice, rather than papered over.
 * - It is taken **only while PSI still carries the data**. Google has announced
 *   it will stop, so the fallback prints that, names the API to enable, and on
 *   the day PSI's copy disappears this answers `none` with the same instruction
 *   rather than quietly reporting no field data for a page that has it.
 */
export function chooseFieldData(crux: CruxFieldAnswer, psi: PageSpeedInsightsResult): FieldSource {
  if (crux.kind === "record") return { source: "crux-api", record: crux.record };
  if (crux.kind === "no-data") return { source: "none", cruxRefused: null };
  if (psi.psiFieldData) return { source: "psi", data: psi.psiFieldData, cruxStatus: crux.status };
  return { source: "none", cruxRefused: crux.status };
}
