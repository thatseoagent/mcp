import { describe, it, expect, afterEach, vi } from "vitest";
import crawlSiteTool, { clampPages, DEFAULT_PAGES, PAGE_CEILING } from "@/tools/crawl-site";
import { CRAWLER_USER_AGENT } from "@/lib/bot-identity";
import { expectPacedStarts } from "../helpers/pacing";
import { serve } from "../helpers/serve";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
});

const textOf = (result: Awaited<ReturnType<typeof crawlSiteTool>>): string =>
  result.content.map((part) => part.text).join("\n");

/** A page whose title, description and links the tests can vary. */
function page(opts: { title?: string; description?: string; links?: string[] } = {}) {
  const links = (opts.links ?? []).map((href) => `<a href="${href}">link</a>`).join("");
  return {
    headers: { "content-type": "text/html" },
    body:
      `<html><head><title>${opts.title ?? "Home"}</title>` +
      (opts.description ? `<meta name="description" content="${opts.description}">` : "") +
      `</head><body><h1>Heading</h1>${links}</body></html>`,
  };
}

describe("clampPages", () => {
  it("clamps rather than rejects, in both directions", () => {
    expect(clampPages(500)).toBe(PAGE_CEILING);
    expect(clampPages(0)).toBe(1);
    expect(clampPages(-3)).toBe(1);
    expect(clampPages(DEFAULT_PAGES)).toBe(DEFAULT_PAGES);
  });
});

describe("crawl_site", () => {
  it("reports the page the caller named in full, including its internal links", async () => {
    serve({
      "example.com/robots.txt": { status: 404, body: "" },
      "https://example.com/": page({ title: "Home", description: "A home page", links: ["/about"] }),
      "https://example.com/about": page({ title: "About" }),
    });

    const text = textOf(await crawlSiteTool({ url: "https://example.com/", maxPages: 1 }));

    expect(text).toContain("=== PAGE DETAIL ===");
    expect(text).toContain("Title: Home");
    expect(text).toContain("Meta description: A home page");
    expect(text).toContain("https://example.com/about");
  });

  it("says the cross-page checks did not run rather than passing them", async () => {
    serve({
      "example.com/robots.txt": { status: 404, body: "" },
      "https://example.com/": page(),
    });

    const text = textOf(await crawlSiteTool({ url: "https://example.com/", maxPages: 1 }));

    expect(text).toContain("=== NOT EVALUATED ===");
    expect(text).toContain("Their absence here is not a pass");
    expect(text).not.toContain("=== DUPLICATE TITLES");
  });

  it("finds a duplicate title once it has two pages to compare", async () => {
    serve({
      "example.com/robots.txt": { status: 404, body: "" },
      "https://example.com/": page({ title: "Same", links: ["/twin"] }),
      "https://example.com/twin": page({ title: "Same" }),
    });

    const text = textOf(await crawlSiteTool({ url: "https://example.com/", maxPages: 5 }));

    expect(text).toContain("=== DUPLICATE TITLES (1) ===");
    expect(text).toContain("https://example.com/twin");
  });

  it("reports a broken internal link with the page that pointed at it", async () => {
    serve({
      "example.com/robots.txt": { status: 404, body: "" },
      "https://example.com/": page({ links: ["/gone"] }),
      "https://example.com/gone": { status: 404, body: "Not Found" },
    });

    const text = textOf(await crawlSiteTool({ url: "https://example.com/", maxPages: 5 }));

    expect(text).toContain("=== BROKEN LINKS (1) ===");
    expect(text).toContain("https://example.com/gone — 404, linked from https://example.com/");
  });

  it("never claims to have found orphan pages it cannot reach", async () => {
    serve({
      "example.com/robots.txt": { status: 404, body: "" },
      "https://example.com/": page({ links: ["/two"] }),
      "https://example.com/two": page({ title: "Two" }),
    });

    const text = textOf(await crawlSiteTool({ url: "https://example.com/", maxPages: 5 }));

    expect(text).toContain("n/a — orphan pages");
  });

  it("skips a path robots.txt disallows for the crawler", async () => {
    serve({
      "example.com/robots.txt": { body: "User-agent: ThatSEOAgentBot\nDisallow: /private/\n" },
      "https://example.com/": page({ links: ["/private/secret", "/public"] }),
      "https://example.com/private/secret": page({ title: "Secret" }),
      "https://example.com/public": page({ title: "Public" }),
    });

    const text = textOf(await crawlSiteTool({ url: "https://example.com/", maxPages: 10 }));

    expect(text).toContain("https://example.com/public");
    expect(text).not.toContain("https://example.com/private/secret —");
    // Not fetched at all, rather than fetched and dropped from the report.
    const asked = (globalThis.fetch as unknown as { mock: { calls: unknown[][] } }).mock.calls.map(
      (call) => String(call[0]),
    );
    expect(asked).not.toContain("https://example.com/private/secret");
    // And accounted for: a disallowed URL still spends a page of the budget, so
    // a report that stayed silent would be shorter than asked for with nothing
    // saying why.
    expect(text).toContain("Skipped: 1 URL(s) this site disallows for our crawler");
  });

  it("identifies itself as the crawler, not as a browser", async () => {
    serve({
      "example.com/robots.txt": { status: 404, body: "" },
      "https://example.com/": page(),
    });

    await crawlSiteTool({ url: "https://example.com/", maxPages: 1 });

    const calls = (globalThis.fetch as unknown as { mock: { calls: unknown[][] } }).mock.calls;
    const pageCall = calls.find((call) => String(call[0]) === "https://example.com/");
    const headers = (pageCall?.[1] as RequestInit).headers as Record<string, string>;
    expect(headers["User-Agent"]).toBe(CRAWLER_USER_AGENT);
    expect(headers["User-Agent"]).toContain("github.com/thatseoagent/mcp");
  });

  it("stops at the budget it was given rather than one page past it", async () => {
    serve({
      "example.com/robots.txt": { status: 404, body: "" },
      "https://example.com/": page({ links: ["/a", "/b", "/c", "/d"] }),
      "https://example.com/a": page({ title: "A" }),
      "https://example.com/b": page({ title: "B" }),
      "https://example.com/c": page({ title: "C" }),
      "https://example.com/d": page({ title: "D" }),
    });

    const text = textOf(await crawlSiteTool({ url: "https://example.com/", maxPages: 3 }));

    expect(text).toContain("Crawled: 3 pages (limit: 3)");
  });

  it("paces the crawl instead of bursting at the origin", async () => {
    // The pacing module has its own unit tests, and on their own they prove
    // nothing about this Tool: deleting the `paceRequestTo` call from the
    // crawler would leave every one of them green. This is the test that fails
    // if the crawler stops asking permission before it fetches.
    serve({
      "example.com/robots.txt": { status: 404, body: "" },
      "https://example.com/": page({ links: ["/a", "/b"] }),
      "https://example.com/a": page({ title: "A" }),
      "https://example.com/b": page({ title: "B" }),
    });

    const startedAt: number[] = [];
    const routed = globalThis.fetch;
    globalThis.fetch = ((...args: Parameters<typeof fetch>) => {
      startedAt.push(Date.now());
      return routed(...args);
    }) as typeof fetch;

    await crawlSiteTool({ url: "https://example.com/", maxPages: 3 });

    expectPacedStarts(startedAt);
  });

  it("returns an error naming what went wrong when the root URL cannot be reached", async () => {
    serve({ "example.com/robots.txt": { status: 404, body: "" } });

    const result = await crawlSiteTool({ url: "https://example.com/", maxPages: 1 });

    // The crawler records an unreachable page rather than throwing, so this is a
    // report that says so — not a Tool error.
    expect(textOf(result)).toContain("404");
  });
});
