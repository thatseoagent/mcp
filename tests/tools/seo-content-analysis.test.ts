import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import seoContentAnalysis from "@/tools/seo-content-analysis";
import { resetHttpCaches } from "@/lib/http-client";
import { serve } from "../helpers/serve";

const originalFetch = globalThis.fetch;

beforeEach(resetHttpCaches);

afterEach(() => {
  globalThis.fetch = originalFetch;
  resetHttpCaches();
  vi.restoreAllMocks();
});

const textOf = (result: Awaited<ReturnType<typeof seoContentAnalysis>>): string =>
  result.content.map((part) => part.text).join("\n");

/** A body paragraph of `n` words, so a case can state the length it needs. */
const wordsOf = (n: number): string => Array.from({ length: n }, () => "content").join(" ");

const analyze = async (html: string) => {
  serve({ "example.com": { body: html, headers: { "content-type": "text/html" } } });
  return seoContentAnalysis({ url: "https://example.com/" });
};

describe("seo_content_analysis", () => {
  it("measures a substantial page and interprets its readability", async () => {
    const text = textOf(
      await analyze(
        `<html lang="en"><head><title>Rich Content</title></head><body><article>` +
          `<h1>Main Article Heading</h1><p>${wordsOf(350)}</p></article></body></html>`,
      ),
    );

    expect(text).toContain("Word count: 35");
    expect(text).toMatch(/Flesch Reading Ease: [\d.]+ \(/);
    expect(text).toMatch(/Flesch-Kincaid Grade: [\d.]+/);
  });

  it("gives a thin page no advice about its length", async () => {
    // Google states "the length of the content alone doesn't matter for ranking
    // purposes", so the retired "expand to 600+ words" tip is gone. This case used
    // to assert it was present.
    const text = textOf(
      await analyze(
        `<html lang="en"><head><title>T</title></head><body><main><h1>H</h1>` +
          `<p>${wordsOf(15)}</p></main></body></html>`,
      ),
    );

    const tips = text.slice(text.indexOf("=== OPTIMIZATION TIPS ==="));
    expect(tips).toContain("=== OPTIMIZATION TIPS ===");
    expect(tips).not.toMatch(/\b\d{3,}\+? words\b/i);
  });

  it("tells internal links from external ones", async () => {
    const text = textOf(
      await analyze(
        `<html lang="en"><head><title>Links Page</title></head><body><h1>Links</h1>` +
          `<p>${wordsOf(100)}</p>` +
          `<a href="/internal-page-one">Internal 1</a>` +
          `<a href="/internal-page-two">Internal 2</a>` +
          `<a href="https://external-site.org/page">External 1</a>` +
          `</body></html>`,
      ),
    );

    expect(text).toContain("Internal links: 2");
    expect(text).toContain("External links: 1");
    expect(text).toContain("Total links: 3");
  });

  it("reports the GEO signals an answer engine reads", async () => {
    const text = textOf(
      await analyze(
        `<html lang="en"><head><title>Guide</title></head><body>` +
          `<h1>Guide</h1><div class="tldr">In short.</div>` +
          `<h2>What is a widget?</h2><p>Widgets grew 45% and cost $30 each. ${wordsOf(60)}</p>` +
          `<ol><li>One</li><li>Two</li><li>Three</li></ol></body></html>`,
      ),
    );

    expect(text).toContain("Q&A headings: 1 question-phrased heading(s)");
    expect(text).toContain("Summary section: present");
    expect(text).toContain("Listicle formatting: present");
    expect(text).toMatch(/Citation density: [1-9]\d* statistical pattern\(s\) found/);
  });

  it("explains an unrendered shell instead of reporting zeros for it", async () => {
    // Zeros here are not a low score, they are a measurement we did not take: a
    // page reading 536 words and then 0 looks like content that was deleted.
    const result = await analyze(
      `<html><head><title>A real title that parsed fine</title>` +
        `<meta name="description" content="And a real description too"></head>` +
        `<body><div id="root"></div></body></html>`,
    );

    expect(result.isError).toBe(true);
    expect(textOf(result)).toMatch(/rendered by JavaScript/);
    // The invented findings must not appear: they describe text nobody read.
    expect(textOf(result)).not.toMatch(/Missing H1|Flesch|No links found/i);
  });

  it("still analyses a page that has headings but little prose", async () => {
    // The guard is "nothing to measure", not "not much to measure". A short page
    // with structure is a real reading, and a low word count a real finding.
    const result = await analyze(
      `<html><head><title>Thin</title></head><body><h1>A heading</h1>` +
        `<p>Four short words here.</p></body></html>`,
    );

    expect(result.isError).toBeUndefined();
    expect(textOf(result)).toContain("CONTENT METRICS");
  });

  it("names the status when the page cannot be read", async () => {
    serve({ "example.com": { status: 500, body: "" } });

    const result = await seoContentAnalysis({ url: "https://example.com/" });

    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("HTTP 500");
  });
});
