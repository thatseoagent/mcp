import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import seoAnalyzePage from "@/tools/seo-analyze-page";
import { serve } from "../helpers/serve";
import { resetAllSingleFlightCaches } from "@/lib/single-flight";

/**
 * What the agent is told, which is the only thing it can act on.
 *
 * The retired suite asserted against a `_structured` field the MCP client never
 * received, so those assertions could all pass while the text an agent reads said
 * something else. These assert the rendered output instead.
 */

const originalFetch = globalThis.fetch;

// The page is fetched through `fetchHtml`, which shares one request per URL per
// window — the point of it, since five Tools read the same page. Every case here
// serves different HTML at the same URL, so without a reset each would be handed
// the previous case's document.
beforeEach(resetAllSingleFlightCaches);

afterEach(() => {
  globalThis.fetch = originalFetch;
  resetAllSingleFlightCaches();
  vi.restoreAllMocks();
});

const textOf = (result: Awaited<ReturnType<typeof seoAnalyzePage>>): string =>
  result.content.map((part) => part.text).join("\n");

const analyze = async (html: string): Promise<string> => {
  serve({ "example.com": { body: html, headers: { "content-type": "text/html" } } });
  return textOf(await seoAnalyzePage({ url: "https://example.com/" }));
};

const DESCRIPTION = "A comprehensive test page with all the right SEO tags set correctly.";

describe("seo_analyze_page", () => {
  it("reports the meta a well-tagged page declares", async () => {
    const text = await analyze(`<!DOCTYPE html>
      <html lang="en"><head>
        <meta charset="utf-8">
        <title>Test Page Title</title>
        <meta name="description" content="${DESCRIPTION}">
        <link rel="canonical" href="https://example.com/">
        <meta name="robots" content="index, follow">
        <meta name="viewport" content="width=device-width, initial-scale=1">
      </head><body><h1>Main Heading</h1><p>Some body content here.</p></body></html>`);

    expect(text).toContain("Title: Test Page Title");
    expect(text).toContain(`Description: ${DESCRIPTION}`);
    expect(text).toContain("Canonical: https://example.com/");
    expect(text).toContain("Lang: en");
    expect(text).toContain("H1: Main Heading");
  });

  it("names a missing meta description as an issue rather than leaving it blank", async () => {
    const text = await analyze(
      `<html lang="en"><head><title>No Description Page</title></head>` +
        `<body><h1>Just a heading</h1><p>Content without meta description.</p></body></html>`,
    );

    expect(text).toContain("Description: (missing)");
    expect(text).toMatch(/=== SEO ISSUES ===[\s\S]*description/i);
  });

  it("lists both H1s when a page has two, so the reader can see which", async () => {
    const text = await analyze(
      `<html lang="en"><head><title>Two H1s Page</title></head>` +
        `<body><h1>First H1</h1><h1>Second H1</h1></body></html>`,
    );

    expect(text).toContain("H1: First H1");
    expect(text).toContain("H1: Second H1");
    expect(text).toMatch(/=== SEO ISSUES ===[\s\S]*H1/);
  });

  it("counts an image with no alt attribute and spares the one marked decorative", async () => {
    // `alt=""` is the documented way to mark an image as decorative. Reporting it
    // would ask an author to describe a wordmark the copy beside it already names.
    const text = await analyze(
      `<html lang="en"><head><title>Image Page</title></head><body><h1>Images</h1>` +
        `<img src="/photo.jpg"><img src="/logo.png" alt=""><img src="/icon.svg" alt="Icon">` +
        `</body></html>`,
    );

    expect(text).toContain("Total images: 3");
    expect(text).toContain("Images without alt (1):");
    expect(text).toContain("- /photo.jpg");
    expect(text).not.toContain("/logo.png");
  });

  it("prints the Open Graph tags a page declares", async () => {
    const text = await analyze(
      `<html lang="en"><head><title>OG Page</title>` +
        `<meta property="og:title" content="Open Graph Title">` +
        `<meta property="og:description" content="Open Graph Description">` +
        `</head><body><h1>Open Graph Test</h1></body></html>`,
    );

    expect(text).toContain("=== OPEN GRAPH ===");
    expect(text).toContain("og:title: Open Graph Title");
    expect(text).toContain("og:description: Open Graph Description");
  });

  it("names the status when the page cannot be read", async () => {
    serve({ "example.com": { status: 404, body: "Not Found" } });

    const result = await seoAnalyzePage({ url: "https://example.com/gone" });

    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("HTTP 404");
    expect(textOf(result)).toContain("There is no page here to audit");
  });
});
