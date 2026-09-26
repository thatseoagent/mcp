import { vi } from "vitest";

/**
 * One fetch stub for the whole suite.
 *
 * ── Why there was more than one ──
 *
 * `serve` and `serveHtml` were the same idea written twice, and a test picked one
 * by accident of which file it had been copied from. They differed in three ways,
 * none of them a decision anybody made: the matching rule (`includes` against
 * suffix), the default content type (`text/plain` against `text/html`), and
 * whether there was a restore at all. Two adapters of a seam nobody had declared
 * — and by the time I finished the deepening work I had written a third, twice,
 * inside `every-fetch-is-guarded.test.ts` and `third-party-api.test.ts`.
 *
 * ── Two defects that came with the duplication ──
 *
 * `serve` assigned `globalThis.fetch` directly rather than through
 * `vi.stubGlobal`, so `vi.unstubAllGlobals()` did not restore it: the stub
 * outlived the file that installed it and stayed for the rest of the worker's
 * life, masked only because the next file happened to install its own.
 *
 * `serveHtml` captured `const originalFetch = globalThis.fetch` at module load
 * and restored *that*, which is whatever was current the first time any file
 * imported the helper rather than the real `fetch`.
 *
 * `vi.stubGlobal` owns both problems now, so `vi.unstubAllGlobals()` — which
 * these tests already call — is the restore.
 *
 * ── Matching by specificity, not by key order ──
 *
 * The rule is exact, then longest suffix, then longest substring. Longest rather
 * than first because insertion order is not something a test should have to think
 * about: `seo-geo-score.test.ts` carried a comment reading "Children first:
 * `sitemap.xml` would otherwise match `sitemap-1.xml`", which is a test arranging
 * its literals around a helper's implementation detail.
 *
 * Anything unmatched is a 404, because a test that forgot to declare a route
 * should see what the Operator would see rather than a hang.
 *
 * ── Routing by the request, not only the URL ──
 *
 * A URL is not always the question. CrUX, Open PageRank and Natural Language
 * take theirs as a POST body; the two Wayback CDX reads share a path and differ
 * only in their parameters; Web Risk asks about a `uri` that the endpoint's own
 * host would out-match. Matching on the URL alone could not tell those apart, so
 * each of those tests wrote its own stub — `route(answer)` copies and
 * `globalThis.fetch =` assignments in a dozen files, each parsing `init` its own
 * way, and the assignments restored by hand rather than through `vi.stubGlobal`. The duplication this file was written to end
 * had grown back beside it.
 *
 * So a route may be a function of the {@link ServedRequest} — method, lower-cased
 * headers, body text, parsed JSON, parameters — chosen by the same URL rule as a
 * fixed one, and {@link requestsOf} hands back what every call asked, already
 * parsed, so an assertion about a body or a header does not re-read `init`.
 *
 * ── A route that does not answer ──
 *
 * `hang: true` answers nothing until the request's `AbortSignal` fires and then
 * rejects with the signal's reason, as `fetch` does — a `TimeoutError` for
 * `AbortSignal.timeout`, an `AbortError` for a plain abort. `hang: "body"` sends
 * the status and headers and stalls the body instead, which is the PageSpeed run
 * that answers and then goes quiet. Timeout tests used to throw a hand-made
 * `DOMException` from a local stub, which tested that a thrown error was
 * translated rather than that the code under test set a timeout at all.
 */

export type Route = {
  status?: number;
  body?: string;
  headers?: Record<string, string>;
  /**
   * Never answer until the request's signal aborts, then reject as `fetch` does.
   * `"body"` sends the head and stalls the body instead. A request with no
   * signal is refused at once, because it would otherwise hang the test.
   */
  hang?: true | "body";
};

/** What a stubbed `fetch` was asked, read once so a test need not parse `init`. */
export interface ServedRequest {
  url: string;
  method: string;
  /** Lower-cased names, as `Headers` normalises them. */
  headers: Record<string, string>;
  /** The body as text; `""` for a request without one. */
  body: string;
  /**
   * The body parsed as JSON, or `undefined` when there is none or it is not JSON.
   * Typed as `JSON.parse` returns, so an assertion reads a field without a cast.
   */
  json: any;
  searchParams: URLSearchParams;
}

/** A fixed answer, or one chosen from what was asked. */
export type Answer = Route | ((request: ServedRequest) => Route | Promise<Route>);

type FetchInput = Parameters<typeof fetch>[0];

/** The mock, so a test can assert what was asked and in what order. */
export type FetchMock = ReturnType<typeof vi.fn>;

/** Each mock's requests, in call order. Keyed on the mock so no state is global. */
const served = new WeakMap<FetchMock, ServedRequest[]>();

function urlOf(input: FetchInput): string {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.toString();
  return input.url;
}

/**
 * The route for a URL, or `undefined`.
 *
 * Exact wins; then the longest key the URL ends with; then the longest key the
 * URL contains. A suffix is tried before a substring because `"/robots.txt"` is
 * meant to serve any origin's robots file, while `"example.com"` is meant to
 * serve everything on a host.
 */
function match<T>(url: string, routes: Record<string, T>): T | undefined {
  if (routes[url]) return routes[url];

  const byLength = Object.keys(routes).sort((a, b) => b.length - a.length);
  const suffix = byLength.find((key) => url.endsWith(key));
  if (suffix) return routes[suffix];

  const substring = byLength.find((key) => url.includes(key));
  return substring ? routes[substring] : undefined;
}

/** The body as text. Synchronous for a string, which is every body this code sends. */
function bodyText(input: FetchInput, init: RequestInit | undefined): string | Promise<string> {
  const body = init?.body;
  if (body === undefined || body === null) {
    return input instanceof Request && input.body ? input.clone().text() : "";
  }
  return typeof body === "string" ? body : new Response(body).text();
}

function servedRequest(input: FetchInput, init: RequestInit | undefined, body: string): ServedRequest {
  const url = urlOf(input);
  let json: any;
  if (body !== "") {
    try {
      json = JSON.parse(body);
    } catch {
      json = undefined;
    }
  }
  let searchParams: URLSearchParams;
  try {
    searchParams = new URL(url).searchParams;
  } catch {
    searchParams = new URLSearchParams();
  }
  // `forEach` rather than iterating `Headers`: the bundler type-checks this file
  // against a lib set without `Headers`' iterator, and fails the build on it —
  // the same trap `ssrf-guard.ts` records.
  const headers: Record<string, string> = {};
  new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined)).forEach(
    (value, key) => {
      headers[key] = value;
    },
  );
  return {
    url,
    method: (init?.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase(),
    headers,
    body,
    json,
    searchParams,
  };
}

/** The reason `fetch` rejects with when `signal` aborts. */
function reasonOf(signal: AbortSignal): unknown {
  return signal.reason ?? new DOMException("This operation was aborted", "AbortError");
}

/** A promise that rejects when `signal` aborts, and never settles otherwise. */
function untilAborted(signal: AbortSignal): Promise<never> {
  return new Promise((_, reject) => {
    if (signal.aborted) reject(reasonOf(signal));
    else signal.addEventListener("abort", () => reject(reasonOf(signal)), { once: true });
  });
}

function respond(hit: Route, signal: AbortSignal | undefined): Response | Promise<Response> {
  const init = {
    status: hit.status ?? 200,
    headers: new Headers({ "content-type": "text/plain; charset=utf-8", ...hit.headers }),
  };
  if (!hit.hang) return new Response(hit.body ?? "", init);

  if (!signal) {
    throw new Error("serve: a route that hangs needs a request with an AbortSignal, or it hangs the test");
  }
  if (hit.hang === true) return untilAborted(signal);

  const stalled = new ReadableStream<Uint8Array>({
    start(controller) {
      untilAborted(signal).catch((reason: unknown) => controller.error(reason));
    },
  });
  return new Response(stalled, init);
}

/**
 * Answer `fetch` from a route table.
 *
 * A value is a {@link Route}, or a function of the {@link ServedRequest} that
 * returns one; the key is matched against the URL either way. A function that
 * throws makes `fetch` reject with what it threw, which is how a test arranges
 * a connection failure.
 *
 * @returns the mock, for a test that needs to assert which URLs were asked for.
 *          Most do not and can ignore it. {@link requestsOf} reads it parsed.
 */
export function serve(routes: Record<string, Answer>): FetchMock {
  const requests: ServedRequest[] = [];

  const mock = vi.fn(async (input: FetchInput, init?: RequestInit) => {
    const text = bodyText(input, init);
    const request = servedRequest(input, init, typeof text === "string" ? text : await text);
    requests.push(request);

    const answer = match(request.url, routes);
    if (!answer) return new Response("Not Found", { status: 404 });
    const hit = typeof answer === "function" ? await answer(request) : answer;
    return respond(hit, init?.signal ?? (input instanceof Request ? input.signal : undefined) ?? undefined);
  });

  served.set(mock, requests);
  vi.stubGlobal("fetch", mock);
  return mock;
}

/**
 * Every request `mock` was asked, in call order, parsed.
 *
 * For a mock {@link serve} returned; any other has recorded nothing here.
 */
export function requestsOf(mock: FetchMock): ServedRequest[] {
  const requests = served.get(mock);
  if (!requests) throw new Error("requestsOf: this mock was not made by serve()");
  return requests;
}

/**
 * {@link serve}, for the common case of serving HTML bodies by URL.
 *
 * A convenience over the same implementation rather than a second one. The
 * content type is the reason it exists: `page-meta` and the crawler check it
 * before parsing, so a page served as `text/plain` is skipped rather than read.
 */
export function serveHtml(bodies: Record<string, string>): FetchMock {
  return serve(
    Object.fromEntries(
      Object.entries(bodies).map(([url, body]) => [
        url,
        { body, headers: { "content-type": "text/html; charset=utf-8" } },
      ]),
    ),
  );
}

/**
 * Put the real `fetch` back.
 *
 * Kept so the files that call it in an `afterEach` keep working, and because
 * naming the restore is clearer at a call site than `vi.unstubAllGlobals()`,
 * which also undoes stubs a test set for its own reasons.
 */
export function restoreFetch(): void {
  vi.unstubAllGlobals();
}
