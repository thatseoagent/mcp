import { describe, it, expect } from "vitest";
import { load } from "cheerio";
import { detectSchemaMismatches } from "@/lib/analyzers/schema-mismatch-analyzer";
import { readableDocument } from "@/lib/visible-text";

/**
 * The detector takes the reading of the page as well as its markup, because
 * "a question-phrased heading" is a Content Signal and those are detected in
 * one place. One helper here so a case still names one document.
 */
const detect = (html: string, schemas: readonly unknown[]) =>
  detectSchemaMismatches(html, schemas, readableDocument(load(html)));

const faqSchema = { "@type": "FAQPage", mainEntity: [{ "@type": "Question", name: "Q?", acceptedAnswer: { "@type": "Answer", text: "A" } }] };
const howToSchema = { "@type": "HowTo", name: "Steps" };
const productSchemaComplete = { "@type": "Product", name: "P", sku: "X-1", offers: { "@type": "Offer", price: "9.99", priceCurrency: "USD" } };
const productSchemaIncomplete = { "@type": "Product", name: "P" };

describe("detectSchemaMismatches", () => {
  // ── FAQPage ──
  it("flags FAQPage schema with no visible Q&A pattern", () => {
    const html = "<body><h1>Random article</h1><p>Some prose with no questions.</p></body>";
    const result = detect(html, [faqSchema]);
    expect(result).toHaveLength(1);
    expect(result[0].type).toBe("FAQPage");
    expect(result[0].severity).toBe("warning");
  });

  it("does NOT flag FAQPage when details/summary is present", () => {
    const html = `<body><details><summary>What is X?</summary><p>It is Y.</p></details></body>`;
    const result = detect(html, [faqSchema]);
    expect(result).toHaveLength(0);
  });

  it("does NOT flag FAQPage when dl/dt/dd definition list is present", () => {
    const html = `<body><dl><dt>Q?</dt><dd>A</dd></dl></body>`;
    const result = detect(html, [faqSchema]);
    expect(result).toHaveLength(0);
  });

  it("does NOT flag FAQPage when a FAQ container class is present", () => {
    const html = `<body><div class="faq-section"><p>Q&A</p></div></body>`;
    const result = detect(html, [faqSchema]);
    expect(result).toHaveLength(0);
  });

  it("does NOT flag FAQPage when a question-style heading is present", () => {
    const html = `<body><h2>What is search engine optimization?</h2><p>SEO is…</p></body>`;
    const result = detect(html, [faqSchema]);
    expect(result).toHaveLength(0);
  });

  // ── HowTo ──
  it("flags HowTo schema with no visible step pattern", () => {
    const html = "<body><h1>Topic</h1><p>Some prose, no steps.</p></body>";
    const result = detect(html, [howToSchema]);
    expect(result).toHaveLength(1);
    expect(result[0].type).toBe("HowTo");
  });

  it("does NOT flag HowTo with ordered list of steps", () => {
    const html = `<body><ol><li>Step 1</li><li>Step 2</li></ol></body>`;
    const result = detect(html, [howToSchema]);
    expect(result).toHaveLength(0);
  });

  it("does NOT flag HowTo with 'Step N' headings", () => {
    const html = `<body><h3>Step 1: Install</h3><p>Do this.</p></body>`;
    const result = detect(html, [howToSchema]);
    expect(result).toHaveLength(0);
  });

  // ── Product ──
  it("flags incomplete Product schema (missing offers, price, sku)", () => {
    const html = `<body><h1>Page</h1><p>No price.</p></body>`;
    const result = detect(html, [productSchemaIncomplete]);
    expect(result).toHaveLength(1);
    expect(result[0].type).toBe("Product");
    expect(result[0].message).toMatch(/offers/);
    expect(result[0].message).toMatch(/sku/);
  });

  it("does NOT flag complete Product schema on a commerce-looking page", () => {
    const html = `<body><h1>Widget</h1><p>$9.99</p><button>Add to cart</button></body>`;
    const result = detect(html, [productSchemaComplete]);
    expect(result).toHaveLength(0);
  });

  it("flags complete Product schema on a page with NO commerce signals (info severity)", () => {
    const html = `<body><h1>Article</h1><p>Just prose.</p></body>`;
    const result = detect(html, [productSchemaComplete]);
    expect(result).toHaveLength(1);
    expect(result[0].severity).toBe("info");
  });

  // ── No schemas → no mismatches ──
  it("returns empty when no schemas present", () => {
    const html = `<body><h1>Anything</h1></body>`;
    const result = detect(html, []);
    expect(result).toHaveLength(0);
  });

  // ── Multiple mismatches ──
  it("reports multiple independent mismatches", () => {
    const html = `<body><p>Nothing here.</p></body>`;
    const result = detect(html, [faqSchema, howToSchema, productSchemaIncomplete]);
    expect(result.map((r) => r.type).sort()).toEqual(["FAQPage", "HowTo", "Product"]);
  });

  // ── The Content Signal, shared rather than re-implemented ──

  it("does NOT flag a question heading that contains markup", () => {
    // The old regex read a heading as `[^<]*` up to its `?`, so any inline tag
    // inside it ended the match: this page has a visible, honest FAQ and was
    // told to remove its schema.
    const html = "<body><main><h2>What is <strong>SEO</strong>?</h2><p>An answer.</p></main></body>";

    expect(detect(html, [faqSchema])).toEqual([]);
  });

  it("does NOT flag a Spanish question heading written without the opening mark", () => {
    // `¿` is optional in practice and the old pattern's only Spanish signal.
    const html = "<body><main><h2>Cómo funciona el servicio?</h2><p>Una respuesta.</p></main></body>";

    expect(detect(html, [faqSchema])).toEqual([]);
  });

  it("still flags a page whose headings ask nothing", () => {
    const html = "<body><main><h2>Our history</h2><p>Founded in 2019.</p></main></body>";

    expect(detect(html, [faqSchema])).toHaveLength(1);
  });
});
