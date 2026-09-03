import { describe, it, expect } from "vitest";
import { detectSchemaMismatches } from "@/lib/analyzers/schema-mismatch-analyzer";

const faqSchema = { "@type": "FAQPage", mainEntity: [{ "@type": "Question", name: "Q?", acceptedAnswer: { "@type": "Answer", text: "A" } }] };
const howToSchema = { "@type": "HowTo", name: "Steps" };
const productSchemaComplete = { "@type": "Product", name: "P", sku: "X-1", offers: { "@type": "Offer", price: "9.99", priceCurrency: "USD" } };
const productSchemaIncomplete = { "@type": "Product", name: "P" };

describe("detectSchemaMismatches", () => {
  // ── FAQPage ──
  it("flags FAQPage schema with no visible Q&A pattern", () => {
    const html = "<body><h1>Random article</h1><p>Some prose with no questions.</p></body>";
    const result = detectSchemaMismatches(html, [faqSchema]);
    expect(result).toHaveLength(1);
    expect(result[0].type).toBe("FAQPage");
    expect(result[0].severity).toBe("warning");
  });

  it("does NOT flag FAQPage when details/summary is present", () => {
    const html = `<body><details><summary>What is X?</summary><p>It is Y.</p></details></body>`;
    const result = detectSchemaMismatches(html, [faqSchema]);
    expect(result).toHaveLength(0);
  });

  it("does NOT flag FAQPage when dl/dt/dd definition list is present", () => {
    const html = `<body><dl><dt>Q?</dt><dd>A</dd></dl></body>`;
    const result = detectSchemaMismatches(html, [faqSchema]);
    expect(result).toHaveLength(0);
  });

  it("does NOT flag FAQPage when a FAQ container class is present", () => {
    const html = `<body><div class="faq-section"><p>Q&A</p></div></body>`;
    const result = detectSchemaMismatches(html, [faqSchema]);
    expect(result).toHaveLength(0);
  });

  it("does NOT flag FAQPage when a question-style heading is present", () => {
    const html = `<body><h2>What is search engine optimization?</h2><p>SEO is…</p></body>`;
    const result = detectSchemaMismatches(html, [faqSchema]);
    expect(result).toHaveLength(0);
  });

  // ── HowTo ──
  it("flags HowTo schema with no visible step pattern", () => {
    const html = "<body><h1>Topic</h1><p>Some prose, no steps.</p></body>";
    const result = detectSchemaMismatches(html, [howToSchema]);
    expect(result).toHaveLength(1);
    expect(result[0].type).toBe("HowTo");
  });

  it("does NOT flag HowTo with ordered list of steps", () => {
    const html = `<body><ol><li>Step 1</li><li>Step 2</li></ol></body>`;
    const result = detectSchemaMismatches(html, [howToSchema]);
    expect(result).toHaveLength(0);
  });

  it("does NOT flag HowTo with 'Step N' headings", () => {
    const html = `<body><h3>Step 1: Install</h3><p>Do this.</p></body>`;
    const result = detectSchemaMismatches(html, [howToSchema]);
    expect(result).toHaveLength(0);
  });

  // ── Product ──
  it("flags incomplete Product schema (missing offers, price, sku)", () => {
    const html = `<body><h1>Page</h1><p>No price.</p></body>`;
    const result = detectSchemaMismatches(html, [productSchemaIncomplete]);
    expect(result).toHaveLength(1);
    expect(result[0].type).toBe("Product");
    expect(result[0].message).toMatch(/offers/);
    expect(result[0].message).toMatch(/sku/);
  });

  it("does NOT flag complete Product schema on a commerce-looking page", () => {
    const html = `<body><h1>Widget</h1><p>$9.99</p><button>Add to cart</button></body>`;
    const result = detectSchemaMismatches(html, [productSchemaComplete]);
    expect(result).toHaveLength(0);
  });

  it("flags complete Product schema on a page with NO commerce signals (info severity)", () => {
    const html = `<body><h1>Article</h1><p>Just prose.</p></body>`;
    const result = detectSchemaMismatches(html, [productSchemaComplete]);
    expect(result).toHaveLength(1);
    expect(result[0].severity).toBe("info");
  });

  // ── No schemas → no mismatches ──
  it("returns empty when no schemas present", () => {
    const html = `<body><h1>Anything</h1></body>`;
    const result = detectSchemaMismatches(html, []);
    expect(result).toHaveLength(0);
  });

  // ── Multiple mismatches ──
  it("reports multiple independent mismatches", () => {
    const html = `<body><p>Nothing here.</p></body>`;
    const result = detectSchemaMismatches(html, [faqSchema, howToSchema, productSchemaIncomplete]);
    expect(result.map((r) => r.type).sort()).toEqual(["FAQPage", "HowTo", "Product"]);
  });
});
