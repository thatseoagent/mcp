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
 */

export type Route = { status?: number; body?: string; headers?: Record<string, string> };

type FetchInput = Parameters<typeof fetch>[0];

/** The mock, so a test can assert what was asked and in what order. */
export type FetchMock = ReturnType<typeof vi.fn>;

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
function match(url: string, routes: Record<string, Route>): Route | undefined {
  if (routes[url]) return routes[url];

  const byLength = Object.keys(routes).sort((a, b) => b.length - a.length);
  const suffix = byLength.find((key) => url.endsWith(key));
  if (suffix) return routes[suffix];

  const substring = byLength.find((key) => url.includes(key));
  return substring ? routes[substring] : undefined;
}

/**
 * Answer `fetch` from a route table.
 *
 * @returns the mock, for a test that needs to assert which URLs were asked for.
 *          Most do not and can ignore it.
 */
export function serve(routes: Record<string, Route>): FetchMock {
  const mock = vi.fn(async (input: FetchInput) => {
    const hit = match(urlOf(input), routes);
    if (!hit) return new Response("Not Found", { status: 404 });
    return new Response(hit.body ?? "", {
      status: hit.status ?? 200,
      headers: new Headers({ "content-type": "text/plain; charset=utf-8", ...hit.headers }),
    });
  });

  vi.stubGlobal("fetch", mock);
  return mock;
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
