import { describe, it, expect, vi, afterEach } from "vitest";
import { serve, serveHtml, restoreFetch } from "./serve";

/**
 * The helper twenty-four test files rest on, tested.
 *
 * It was two helpers, and both had a restore that did not restore: `serve`
 * assigned `globalThis.fetch` directly so `vi.unstubAllGlobals()` skipped it, and
 * `serveHtml` captured the original at module load and put *that* back. Neither
 * was covered, because a test helper is the one piece of a suite nothing is
 * watching — and the symptom of both is a failure in some other file.
 */

afterEach(() => {
  vi.unstubAllGlobals();
});

const REAL_FETCH = globalThis.fetch;

describe("restoring the real fetch", () => {
  it("puts back the real fetch, not whatever was current at import", async () => {
    serve({ "example.com": { body: "stubbed" } });
    expect(globalThis.fetch).not.toBe(REAL_FETCH);

    restoreFetch();

    expect(globalThis.fetch).toBe(REAL_FETCH);
  });

  it("is undone by `vi.unstubAllGlobals()`, which is what most files call", () => {
    // The defect this replaces: `serve` assigned the global directly, so the stub
    // outlived the file that installed it and stayed for the rest of the worker.
    serve({ "example.com": { body: "stubbed" } });

    vi.unstubAllGlobals();

    expect(globalThis.fetch).toBe(REAL_FETCH);
  });

  it("survives being installed twice", () => {
    serve({ "a": { body: "first" } });
    serve({ "b": { body: "second" } });

    restoreFetch();

    expect(globalThis.fetch).toBe(REAL_FETCH);
  });
});

describe("matching a URL to a route", () => {
  const bodyOf = async (url: string) => (await fetch(url)).text();

  it("prefers an exact match", async () => {
    serve({
      "https://example.com/page": { body: "exact" },
      "example.com": { body: "host" },
    });

    expect(await bodyOf("https://example.com/page")).toBe("exact");
  });

  it("matches a suffix, so one key serves every origin's robots.txt", async () => {
    serve({ "/robots.txt": { body: "User-agent: *" } });

    expect(await bodyOf("https://a.test/robots.txt")).toBe("User-agent: *");
    expect(await bodyOf("https://b.test/robots.txt")).toBe("User-agent: *");
  });

  it("matches a substring, so one key serves a whole host", async () => {
    serve({ "example.com": { body: "host" } });

    expect(await bodyOf("https://example.com/deep/path?q=1")).toBe("host");
  });

  it("takes the longest key, not the first", async () => {
    // The property that matters. `seo-geo-score.test.ts` carried a comment
    // reading "Children first: `sitemap.xml` would otherwise match
    // `sitemap-1.xml`" — a test arranging its literals around insertion order.
    const routes = {
      "sitemap.xml": { body: "index" },
      "sitemap-1.xml": { body: "child" },
    };

    serve(routes);
    expect(await bodyOf("https://example.com/sitemap-1.xml")).toBe("child");
    expect(await bodyOf("https://example.com/sitemap.xml")).toBe("index");

    // And with the keys the other way round, which used to change the answer.
    serve({ "sitemap-1.xml": routes["sitemap-1.xml"], "sitemap.xml": routes["sitemap.xml"] });
    expect(await bodyOf("https://example.com/sitemap-1.xml")).toBe("child");
  });

  it("404s an unmatched URL rather than hanging", async () => {
    serve({ "example.com": { body: "host" } });

    const res = await fetch("https://elsewhere.test/page");

    // A test that forgot a route should see what the Operator would see.
    expect(res.status).toBe(404);
  });
});

describe("what a route says", () => {
  it("defaults to 200 and text/plain", async () => {
    serve({ "example.com": { body: "hello" } });

    const res = await fetch("https://example.com/");

    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/plain");
  });

  it("carries a status, so a 404 or a 503 can be arranged", async () => {
    serve({ "gone": { status: 404 }, "broken": { status: 503 } });

    expect((await fetch("https://example.com/gone")).status).toBe(404);
    expect((await fetch("https://example.com/broken")).status).toBe(503);
  });

  it("lets a route set its own headers", async () => {
    serve({ "example.com": { body: "{}", headers: { "content-type": "application/json" } } });

    expect((await fetch("https://example.com/")).headers.get("content-type"))
      .toBe("application/json");
  });

  it("serves HTML as HTML, which is why `serveHtml` exists", async () => {
    // `page-meta` and the crawler check the content type before parsing, so a
    // page served as `text/plain` is skipped rather than read.
    serveHtml({ "example.com": "<html><body>hi</body></html>" });

    const res = await fetch("https://example.com/");

    expect(res.headers.get("content-type")).toContain("text/html");
    expect(await res.text()).toContain("hi");
  });
});

describe("the mock it returns", () => {
  it("records what was asked, and in what order", async () => {
    const mock = serve({ "example.com": { body: "ok" } });

    await fetch("https://example.com/first");
    await fetch("https://example.com/second");

    expect(mock.mock.calls.map((call) => String(call[0]))).toEqual([
      "https://example.com/first",
      "https://example.com/second",
    ]);
  });
});
