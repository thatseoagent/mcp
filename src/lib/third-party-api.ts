/**
 * Calling a fixed third-party API: Google's Cloud APIs, the Chrome UX Report,
 * PageSpeed Insights, the Wayback CDX server, Wikipedia, Wikimedia, Wikidata,
 * Reddit, Open PageRank.
 *
 * ── Why one module ──
 *
 * Eleven modules made the same call by hand around a fetcher that did nothing
 * but pace and send: require the key, put it where the API wants it, pick a
 * timeout, decide which status means "nothing to report", turn any other
 * refusal into an {@link UpstreamApiError}, parse the body. Each was a few lines
 * and each could be got wrong on its own, and several were. Web Risk, Natural
 * Language, CrUX and PageSpeed let a timeout escape as the `DOMException` the
 * abort raises, and let a 200 carrying an HTML maintenance page escape as the
 * `SyntaxError` `response.json()` raises. Neither is a type `tool-failure.ts`
 * forwards, so the Operator of a slow Google API read "the failure was
 * unexpected and has been logged" about the most expected failure there is.
 * Only the three modules that had been bitten by it — Wayback, Wikimedia and
 * Open PageRank — said anything better.
 *
 * So a caller describes the service once, as a {@link ThirdPartyService}, and
 * {@link callApi} owns everything between that description and a parsed body.
 * What is left to the caller is what only it knows: what the body means.
 *
 * ── Why this is not `fetchAnyStatus` ──
 *
 * `robots-gate.ts` names these as one of its two deliberate exemptions: "APIs
 * with their own terms, reached at a known endpoint, and they are not what a site
 * owner is addressing when they write a rule about our crawler." Asking
 * `wikipedia.org/robots.txt` whether we may call Wikipedia's REST API is asking
 * the wrong party the wrong question.
 *
 * The exemption lives here, in the one function that makes these requests,
 * rather than in call sites that reach for the global `fetch` and are exempt by
 * omission. Which is what they once were: `wikipedia`, `reddit`, `wikidata` and
 * `knowledge-graph` all called `fetch` directly, so nothing distinguished
 * "exempt on purpose" from "forgot". The fetcher is private to this module for
 * the same reason: a second caller of it would be a second place to forget the
 * rest of this contract.
 *
 * ── What it does apply ──
 *
 * **The provider's ceiling, not the site pace.** These are real connections to
 * somebody else's server, and the argument `robots-gate.ts` makes for pacing
 * robots.txt — the recursion argument "says nothing about the request being
 * free, and it is not" — applies here too. What it does not carry over is the
 * number. `crawl-pacing.ts` is sized for a stranger's site that published no
 * limit: a gap we chose, and a total whose refusal says we would not press
 * "somebody else's site" harder. A fixed API has published its limit, so each
 * {@link ThirdPartyService} states its own `perMinute` and a request over it
 * waits for the minute to make room (`ceiling-limiter.ts`). The site pace used
 * to apply as well, and it was the wrong rule twice over: its 100 ms gap made
 * twenty-five CrUX reads queue behind each other for no provider's sake, and its
 * 300 a minute sat *above* CrUX's own 150, so it let through the requests Google
 * then refused.
 *
 * **The fetch scope.** `with-cache.ts` promises that `force_refresh` reaches "all
 * the way down" past the in-process caches. The caches of the callers are what
 * that promise is kept against.
 *
 * **Our identity.** Wikipedia, Wikidata and Wikimedia all ask for a descriptive
 * agent with a way to reach the operator, and rate-limit anonymous ones harder;
 * every request carries `ThatSEOAgentBot`.
 *
 * The SSRF guard is beside the point and applied anyway, for free: the host is a
 * constant in our own source, and what varies is a brand name inside a query
 * string.
 *
 * ── Why there is no cache option ──
 *
 * Every caller caches, and none of them caches the body. CrUX caches a record
 * already interpreted as "record" or "no data", keyed on subject and device;
 * PageSpeed keys on a normalised category list so two spellings of one request
 * share an entry; Wayback keys on the question, not on either of the two
 * requests that answer it. A cache here could only key on the URL and hold the
 * raw body, which is the wrong key for all three and would put a second copy of
 * each answer beside the one the caller keeps.
 */
import { PAGE_AUDIT_USER_AGENT } from "./bot-identity";
import { createCeilingLimiter } from "./ceiling-limiter";
import { requireConfig, type ConfigRequirement } from "./required-config";
import { safeFetch } from "./ssrf-guard";
import { UpstreamApiError } from "./upstream-api-error";

/** A fixed API, described once by the module that calls it. */
export interface ThirdPartyService {
  /** How the Operator names it in a sentence: "Google's Web Risk API". */
  name: string;
  /**
   * Where the API takes its key. Omitted for keyless APIs. `requireConfig` runs
   * before any request, so an unconfigured server refuses in a sentence rather
   * than timing out against an endpoint it cannot authenticate to.
   */
  key?:
    | { requirement: ConfigRequirement; in: "query"; param: string }
    | { requirement: ConfigRequirement; in: "header"; header: string }
    | { requirement: ConfigRequirement; in: "bearer" };
  /**
   * The ceiling on one request, body included. Every one of these needs one,
   * because Node's `fetch` has none and an unbounded request is an agent turn
   * that never comes back.
   */
  timeoutMs: number;
  /** Statuses this API uses to say "nothing to report" — e.g. CrUX and Wikimedia 404. */
  noDataStatuses?: readonly number[];
  /**
   * Requests a minute the provider will take: its documented ceiling, or one we
   * inferred and say so beside the number. A request over it waits rather than
   * being sent to meet a 429. Omitted, {@link DEFAULT_PER_MINUTE} applies —
   * every API has a ceiling somewhere, and one nobody wrote down is still one.
   */
  perMinute?: number;
  /**
   * The allowance `perMinute` is counted against, when several services draw on
   * one. Defaults to `name`, which is already shared by the callers of one
   * service — CrUX's record and history reads are one description. Wikimedia's
   * limit covers Wikipedia, Wikidata and its Analytics API together, so those
   * three name one key, and must state the same `perMinute`.
   */
  ceilingKey?: string;
}

/**
 * The ceiling for a service that states none: one request a second, on average,
 * over a minute. Well under every figure a provider here does publish, so a
 * service that forgot to declare one errs towards waiting.
 */
export const DEFAULT_PER_MINUTE = 60;

/** One window per ceiling key, for every fixed API this process calls. */
const ceilings = createCeilingLimiter();

/**
 * What the API said, when it said something readable.
 *
 * `no-data` is an answer, not a failure: CrUX's 404 for a page below its traffic
 * threshold and Wikipedia's 404 for a title with no article are both the API
 * telling us something true.
 */
export type ApiAnswer =
  | { kind: "data"; body: unknown; status: number }
  | { kind: "no-data"; status: number };

export interface ApiRequest {
  /** The endpoint. Parameters already on it are kept. */
  url: string;
  /** Appended to the URL; an array repeats the parameter, as `threatTypes` does. */
  query?: Record<string, string | string[]>;
  /** A JSON body, which makes this a POST. */
  json?: unknown;
  headers?: Record<string, string>;
}

/**
 * A fixed third-party API that did not answer with anything we could read.
 *
 * {@link UpstreamApiError} covers an API that answered with a status. Two other
 * outcomes are ordinary for every API {@link callApi} reaches, and neither had a
 * sentence of its own:
 *
 * - **No answer within the budget.** The fetch aborts on its timeout, and the
 *   abort arrives as a `DOMException` nobody here authored, so `tool-failure.ts`
 *   replaced it with "the failure was unexpected and has been logged". The
 *   Internet Archive's CDX server routinely takes tens of seconds over a busy
 *   URL, and PageSpeed Insights runs Lighthouse before it answers; a slow API is
 *   the expected failure, not an unexpected one, and the Operator can act on it —
 *   retry, or narrow the question.
 * - **A 200 that is not the API's format.** The Archive answers its "Temporarily
 *   Offline" HTML page when it sheds load, and a proxy or a captive portal can do
 *   the same to any of these. Parsing that as data would be reporting on a page
 *   of HTML.
 *
 * A subclass rather than a new type in `tool-failure.ts`'s list, because what
 * makes {@link UpstreamApiError} safe to forward holds here unchanged: a service
 * name we wrote down, a number, and a fixed sentence. Nothing from the remote
 * body reaches the message. It also means a caller that branches on
 * `UpstreamApiError`'s status never mistakes one of these for a refusal: the
 * status is 0 for a timeout and a 2xx for an unreadable answer.
 */
export class UpstreamUnansweredError extends UpstreamApiError {
  private constructor(service: string, status: number, message: string) {
    super(service, status);
    this.name = "UpstreamUnansweredError";
    this.message = message;
  }

  /** Nothing arrived within `timeoutMs`. Status 0, as `PageFetchError` uses it. */
  static timeout(service: string, timeoutMs: number): UpstreamUnansweredError {
    return new UpstreamUnansweredError(
      service,
      0,
      `${service} did not answer within ${Math.round(timeoutMs / 1000)} seconds. ` +
        "A slow answer is almost always the service under load rather than anything " +
        "about this request, and retrying in a minute usually works. Nothing here is " +
        "misconfigured.",
    );
  }

  /** A response arrived and it was not the API's format. */
  static unreadable(service: string, status: number): UpstreamUnansweredError {
    return new UpstreamUnansweredError(
      service,
      status,
      `${service} answered, but not with data in its documented format — usually a ` +
        "maintenance or overload page. Retrying later usually works. Nothing here is " +
        "misconfigured.",
    );
  }
}

/** The answer of a service that declares no "nothing to report" status. */
type DataAnswer = Extract<ApiAnswer, { kind: "data" }>;

/**
 * Ask a fixed API one question.
 *
 * Typed by what the service declares: one with no `noDataStatuses` can only
 * answer with data, so its caller reads `body` without a branch it could never
 * take. Declare the service with `satisfies ThirdPartyService` for the narrower
 * overload to apply.
 *
 * @throws {MissingConfigError} when the service needs a key that is not set,
 *         before any request.
 * @throws {UpstreamUnansweredError} when nothing arrived in time, or a 2xx body
 *         is not JSON.
 * @throws {UpstreamApiError} for any other status that is not a success. Its
 *         status is a field, so a caller that can answer around one refusal —
 *         PageSpeed's 400 for a category, CrUX's 403 — catches it by number.
 */
export function callApi(
  service: ThirdPartyService & { noDataStatuses?: undefined },
  request: ApiRequest,
): Promise<DataAnswer>;
export function callApi(service: ThirdPartyService, request: ApiRequest): Promise<ApiAnswer>;
export async function callApi(service: ThirdPartyService, request: ApiRequest): Promise<ApiAnswer> {
  // First, and synchronous with the call: nothing waits for a slot or is sent
  // for a request that could never authenticate — nor claims a slot another
  // request could have used.
  const key = service.key ? requireConfig(service.key.requirement) : null;

  const url = new URL(request.url);
  for (const [name, value] of Object.entries(request.query ?? {})) {
    for (const one of Array.isArray(value) ? value : [value]) url.searchParams.append(name, one);
  }
  const headers: Record<string, string> = { ...request.headers };
  if (service.key && key !== null) {
    if (service.key.in === "query") url.searchParams.set(service.key.param, key);
    else if (service.key.in === "header") headers[service.key.header] = key;
    else headers.Authorization = `Bearer ${key}`;
  }

  // Before the fetch, so the wait is not spent out of `timeoutMs`: the budget
  // is for the provider's answer, and a slot we are queueing for is not it.
  await ceilings.take(service.ceilingKey ?? service.name, service.perMinute ?? DEFAULT_PER_MINUTE);

  // The body is read inside the same budget as the headers, because the abort
  // signal covers the stream too: a PageSpeed run that sends its headers and then
  // stalls is the same timeout, and it used to escape as the raw abort.
  try {
    const response = await fetchFixedApi(url.toString(), {
      timeout: service.timeoutMs,
      headers,
      json: request.json,
    });
    const status = response.status;

    if (service.noDataStatuses?.includes(status)) {
      await response.body?.cancel();
      return { kind: "no-data", status };
    }
    if (!response.ok) throw await UpstreamApiError.fromResponse(service.name, response);

    const text = await response.text();
    try {
      return { kind: "data", body: JSON.parse(text) as unknown, status };
    } catch {
      throw UpstreamUnansweredError.unreadable(service.name, status);
    }
  } catch (error) {
    // Only the abort is translated. Everything else — an SSRF refusal, the
    // errors built above — is already authored by us and travels on
    // unchanged; a network failure we did not author travels on too, and
    // `tool-failure.ts` logs it.
    if (error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError")) {
      throw UpstreamUnansweredError.timeout(service.name, service.timeoutMs);
    }
    throw error;
  }
}

/**
 * The request itself: SSRF-checked, identified, bounded.
 *
 * Private, so that {@link callApi} is the only way to reach a fixed API and
 * nobody is exempt from the robots gate without also getting the rest — the
 * provider's ceiling included, which `callApi` waits on before calling this.
 */
async function fetchFixedApi(
  url: string,
  options: {
    timeout: number;
    headers: Record<string, string>;
    /**
     * A JSON body, which makes this a POST. For query APIs that take their
     * question as a body — the CrUX API accepts nothing else. It is still a read:
     * rule 7 of ADR-0006 is about the sites we audit, and this is a fixed
     * endpoint answering a question, not a write to anyone's server.
     */
    json: unknown;
  },
): Promise<Response> {
  const body = options.json === undefined ? undefined : JSON.stringify(options.json);
  const { response } = await safeFetch(url, {
    method: body === undefined ? "GET" : "POST",
    body,
    signal: AbortSignal.timeout(options.timeout),
    headers: {
      "User-Agent": PAGE_AUDIT_USER_AGENT,
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      ...options.headers,
    },
  });
  return response;
}
