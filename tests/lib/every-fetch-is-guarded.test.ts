import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  fetchAnyStatus,
  fetchHeaders,
  fetchWithTimeout,
  fetchWithoutRedirect,
} from "@/lib/http-client";
import { RobotsDisallowedError } from "@/lib/robots-gate";
import { fetchAuditablePage } from "@/lib/page-reachability";
import { readWellKnown } from "@/lib/well-known";
import { resetCrawlPacing } from "@/lib/crawl-pacing";
import { resetAllSingleFlightCaches } from "@/lib/single-flight";

/**
 * The invariant this file exists to keep: **the two obligations ride on every
 * outbound request, redirect hops included.**
 *
 * `http-client.ts` has always stated it. It was a convention, and it broke in
 * three ways at once:
 *
 *   1. No fetcher here returned a response with its status without throwing, so
 *      nine modules dropped to `safeFetch` and re-assembled `clearToFetch` +
 *      `safeFetch` by hand. The ordering between them was load-bearing and
 *      expressed in no type.
 *   2. Two of those nine skipped the guards entirely — `page-reachability`, which
 *      is the FIRST fetch of every `seo_geo_score` and `ai_visibility_score` run,
 *      and `well-known`, whose comment said the gate "arrives with the crawl
 *      Tools" long after it had arrived.
 *   3. The guards sat *above* `safeFetch`, which follows up to five redirects
 *      re-running only the SSRF check. So one robots check and one pacing slot
 *      covered a chain of up to six requests, while `crawl-pacing.ts` sizes its
 *      per-origin ceiling on redirects being counted.
 *
 * The old interface could not express this property, which is the point.
 * `http-client.test.ts` asserted one fetch using a helper that counts only the
 * page URL, so it passed identically whether or not robots.txt was consulted.
 * With one fetcher and a per-hop hook, "was this request guarded?" is a question
 * about the route table.
 */

/** Every URL `fetch` was called with, in order. */
function urlsFetched(mock: { mock: { calls: unknown[][] } }): string[] {
  return mock.mock.calls.map((call) => String(call[0]));
}

/** A `fetch` answering from a route table, defaulting to 200 with a body. */
function routes(table: Record<string, () => Response>) {
  const mock = vi.fn(async (input: unknown) => {
    const url = String(input);
    const route = table[url];
    if (route) return route();
    return new Response("<html>ok</html>", { status: 200 });
  });
  vi.stubGlobal("fetch", mock);
  return mock;
}

const ALLOW_ALL = () => new Response("User-agent: *\nAllow: /", { status: 200 });
const DISALLOW_ALL = () => new Response("User-agent: *\nDisallow: /", { status: 200 });

beforeEach(() => {
  resetAllSingleFlightCaches();
  resetCrawlPacing();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  resetAllSingleFlightCaches();
  resetCrawlPacing();
});

describe("every fetcher consults robots.txt", () => {
  /**
   * Every entry point into the module, so a fetcher added later has to appear
   * here to be covered. The two at the end are the ones that skipped the guards.
   */
  const fetchers: Array<[string, (url: string) => Promise<unknown>]> = [
    ["fetchAnyStatus", (url) => fetchAnyStatus(url)],
    ["fetchWithTimeout", (url) => fetchWithTimeout(url)],
    ["fetchHeaders", (url) => fetchHeaders(url)],
    ["fetchWithoutRedirect", (url) => fetchWithoutRedirect(url)],
    ["fetchAuditablePage (the Reachability Gate)", (url) => fetchAuditablePage(url)],
    ["readWellKnown", () => readWellKnown("https://example.com", "/llms.txt")],
  ];

  for (const [name, fetcher] of fetchers) {
    it(`${name} reads robots.txt before the page`, async () => {
      const mock = routes({ "https://example.com/robots.txt": ALLOW_ALL });

      await fetcher("https://example.com/page");

      const asked = urlsFetched(mock);
      expect(asked[0]).toBe("https://example.com/robots.txt");
      expect(asked.length).toBeGreaterThan(1);
    });

    it(`${name} refuses when robots.txt disallows us`, async () => {
      routes({ "https://example.com/robots.txt": DISALLOW_ALL });

      // `readWellKnown` answers with an outcome rather than throwing, and its
      // `unavailable` is the honest shape for "we did not find out".
      if (name === "readWellKnown") {
        expect(await fetcher("https://example.com/page")).toMatchObject({
          outcome: "unavailable",
        });
        return;
      }
      await expect(fetcher("https://example.com/page")).rejects.toThrow(RobotsDisallowedError);
    });
  }

  it("never asks robots.txt for permission to read robots.txt", async () => {
    // The one exemption, and `robots-gate.ts` owns it by path so no caller can
    // forget it or apply it twice. Gating it on its own contents does not
    // terminate.
    const mock = routes({ "https://example.com/robots.txt": DISALLOW_ALL });

    const read = await readWellKnown("https://example.com", "/robots.txt");

    expect(read).toMatchObject({ outcome: "found" });
    // Exactly one request: the gate's own read is shared with this one.
    expect(urlsFetched(mock).filter((url) => url.endsWith("/robots.txt"))).toHaveLength(1);
  });
});

describe("a redirect chain is guarded hop by hop", () => {
  const redirect = (to: string) => () =>
    new Response(null, { status: 301, headers: { location: to } });

  it("clears each hop with the robots.txt of the origin it lands on", async () => {
    const mock = routes({
      "https://example.com/robots.txt": ALLOW_ALL,
      "https://elsewhere.test/robots.txt": ALLOW_ALL,
      "https://example.com/start": redirect("https://elsewhere.test/end"),
    });

    await fetchAnyStatus("https://example.com/start");

    // The second origin's robots.txt is the assertion. Above the hop loop it was
    // never read at all: a chain that leaves the origin used to carry us to a
    // server we had made no promises to.
    expect(urlsFetched(mock)).toContain("https://elsewhere.test/robots.txt");
    expect(urlsFetched(mock)).toContain("https://elsewhere.test/end");
  });

  it("refuses mid-chain when the origin it lands on disallows us", async () => {
    routes({
      "https://example.com/robots.txt": ALLOW_ALL,
      "https://elsewhere.test/robots.txt": DISALLOW_ALL,
      "https://example.com/start": redirect("https://elsewhere.test/end"),
    });

    await expect(fetchAnyStatus("https://example.com/start")).rejects.toThrow(
      RobotsDisallowedError,
    );
  });

  it("spends a pacing slot per hop, not one for the whole chain", async () => {
    const mock = routes({
      "https://example.com/robots.txt": ALLOW_ALL,
      "https://example.com/a": redirect("https://example.com/b"),
      "https://example.com/b": redirect("https://example.com/c"),
    });

    await fetchAnyStatus("https://example.com/a");

    // Three page requests plus robots.txt. `crawl-pacing.ts` sizes its ceiling
    // on "about sixty fetches counting robots.txt and redirects", and redirects
    // were not being counted — the budget was loose by the redirect factor.
    expect(urlsFetched(mock)).toEqual([
      "https://example.com/robots.txt",
      "https://example.com/a",
      "https://example.com/b",
      "https://example.com/c",
    ]);
  });
});
