import { describe, it, expect, afterEach, vi } from "vitest";
import seoCrawlabilityAudit from "@/tools/seo-crawlability-audit";
import { serve } from "../helpers/serve";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
});

const textOf = (result: Awaited<ReturnType<typeof seoCrawlabilityAudit>>): string =>
  result.content.map((part) => part.text).join("\n");

const html = (head: string) => ({
  headers: { "content-type": "text/html" },
  body: `<html><head>${head}</head><body><h1>Page</h1></body></html>`,
});

describe("seo_crawlability_audit", () => {
  it("does not call a canonical pointing elsewhere on the same site a fault", async () => {
    serve({
      "example.com/robots.txt": { status: 404, body: "" },
      "https://example.com/page?filter=1": html(
        '<link rel="canonical" href="https://example.com/page">',
      ),
    });

    const text = textOf(await seoCrawlabilityAudit({ url: "https://example.com/page?filter=1" }));

    expect(text).toContain("✓ No canonical conflicts");
  });

  it("calls out a relative canonical, which Google discards", async () => {
    serve({
      "example.com/robots.txt": { status: 404, body: "" },
      "https://example.com/page": html('<link rel="canonical" href="/page">'),
    });

    const text = textOf(await seoCrawlabilityAudit({ url: "https://example.com/page" }));

    expect(text).toContain("relative URL");
    expect(text).toContain("CRITICAL:");
  });

  it("reports a missing canonical as information, not as a defect", async () => {
    serve({
      "example.com/robots.txt": { status: 404, body: "" },
      "https://example.com/page": html("<title>Page</title>"),
    });

    const text = textOf(await seoCrawlabilityAudit({ url: "https://example.com/page" }));

    expect(text).toContain("INFO:");
    expect(text).toContain("Google will choose one");
    expect(text).not.toMatch(/CRITICAL:[\s\S]*canonical/);
  });

  it("prints the redirect chain hop by hop", async () => {
    serve({
      "example.com/robots.txt": { status: 404, body: "" },
      "https://example.com/old": { status: 301, headers: { location: "https://example.com/new" } },
      "https://example.com/new": html("<title>New</title>"),
    });

    const text = textOf(await seoCrawlabilityAudit({ url: "https://example.com/old" }));

    expect(text).toContain("[301] https://example.com/old");
    expect(text).toContain("Location: https://example.com/new");
    expect(text).toContain("Final URL: https://example.com/new");
  });

  it("names the trap of a noindex on a page Googlebot may not fetch", async () => {
    serve({
      "example.com/robots.txt": { body: "User-agent: Googlebot\nDisallow: /hidden\n" },
      "https://example.com/hidden": html('<meta name="robots" content="noindex">'),
    });

    const text = textOf(await seoCrawlabilityAudit({ url: "https://example.com/hidden" }));

    expect(text).toContain("noindex will never be seen");
  });

  it("reads X-Robots-Tag as well as the meta tag", async () => {
    serve({
      "example.com/robots.txt": { status: 404, body: "" },
      "https://example.com/page": {
        headers: { "content-type": "text/html", "x-robots-tag": "noindex" },
        body: "<html><head></head><body></body></html>",
      },
    });

    const text = textOf(await seoCrawlabilityAudit({ url: "https://example.com/page" }));

    expect(text).toContain("Blocked from indexing: Yes");
    expect(text).toContain("X-Robots-Tag header: noindex");
  });

  it("returns an error naming the input when the URL is not one", async () => {
    const result = await seoCrawlabilityAudit({ url: "not-a-url" });

    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("Invalid URL format");
  });
});
