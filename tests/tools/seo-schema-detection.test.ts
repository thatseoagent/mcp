import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import seoSchemaDetection from "@/tools/seo-schema-detection";
import { serve } from "../helpers/serve";
import { resetAllSingleFlightCaches } from "@/lib/single-flight";

const originalFetch = globalThis.fetch;

beforeEach(resetAllSingleFlightCaches);

afterEach(() => {
  globalThis.fetch = originalFetch;
  resetAllSingleFlightCaches();
  vi.restoreAllMocks();
});

const textOf = (result: Awaited<ReturnType<typeof seoSchemaDetection>>): string =>
  result.content.map((part) => part.text).join("\n");

const detect = async (html: string, url = "https://example.com/"): Promise<string> => {
  serve({ "example.com": { body: html, headers: { "content-type": "text/html" } } });
  return textOf(await seoSchemaDetection({ url }));
};

const jsonLd = (payload: string): string =>
  `<html lang="en"><head><title>Page</title>` +
  `<script type="application/ld+json">${payload}</script></head>` +
  `<body><h1>Page</h1></body></html>`;

describe("seo_schema_detection", () => {
  it("reports a valid Article payload as found and valid", async () => {
    const text = await detect(
      jsonLd(`{
        "@context": "https://schema.org",
        "@type": "Article",
        "headline": "Test Article Headline",
        "author": { "@type": "Person", "name": "Jane Doe" },
        "datePublished": "2024-01-01",
        "publisher": { "@type": "Organization", "name": "Test Publisher" }
      }`),
    );

    // The nested publisher is flattened out as its own Organization payload, so
    // the type list carries both and the count is of payloads, not scripts.
    expect(text).toMatch(/Schema types: .*\bArticle\b/);
    expect(text).toMatch(/Valid schemas: [1-9]/);
    expect(text).toContain("[1] Type: Article");
  });

  it("counts malformed JSON-LD as invalid rather than ignoring it", async () => {
    const text = await detect(jsonLd(`{ "@type": "Article", "headline": "Test", INVALID_JSON`));

    expect(text).toMatch(/Invalid schemas: [1-9]/);
    expect(text).toContain("Valid: ✗");
  });

  it("tells a page with no structured data what to add", async () => {
    const text = await detect(
      `<html lang="en"><head><title>No Schema Page</title></head>` +
        `<body><h1>No structured data here</h1><p>Plain HTML.</p></body></html>`,
    );

    expect(text).toContain("Total schemas found: 0");
    expect(text).toContain("Add Organization schema with name, logo, and contact info");
  });

  it("notes that FAQ rich results are deprecated and does not count FAQPage toward the stack", async () => {
    const text = await detect(
      jsonLd(`{
        "@context": "https://schema.org",
        "@type": "FAQPage",
        "mainEntity": [{
          "@type": "Question",
          "name": "What is SEO?",
          "acceptedAnswer": { "@type": "Answer", "text": "Search Engine Optimization." }
        }]
      }`),
    );

    expect(text).toContain("Schema types: FAQPage");
    expect(text).toContain("Google deprecated FAQ rich results");
    // The fixture URL is a site root, so the stack owed is the homepage's.
    expect(text).toContain("Page identified as: Homepage");
    expect(text).toContain("✗ Missing WebSite");
    expect(text).toContain("Not applicable to this page type:");
  });

  it("asks an article for Article and a breadcrumb trail, and says why", async () => {
    // A homepage owes neither. Demanding them everywhere is asking for schema
    // that misdescribes the page.
    const text = await detect(
      `<html><head><meta property="og:type" content="article"><title>A post</title></head>` +
        `<body><article><time datetime="2026-07-30">July</time><p>Words.</p></article></body></html>`,
      "https://example.com/blog/2026/a-post",
    );

    expect(text).toContain("Page identified as: Article");
    expect(text).toMatch(/✗ Missing Article — .*dated, authored/i);
    expect(text).toMatch(/✗ Missing BreadcrumbList — .*levels down/i);
  });

  it("names the status when the page cannot be read", async () => {
    serve({ "example.com": { status: 404, body: "Not Found" } });

    const result = await seoSchemaDetection({ url: "https://example.com/gone" });

    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("HTTP 404");
  });
});
