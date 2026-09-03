import { describe, it, expect } from "vitest";
import {
  validateSchema,
  extractSchemaType,
} from "@/lib/schema-validator";

// ── validateSchema — guard rails ──────────────────────────────────────────

describe("validateSchema — guard rails", () => {
  it("returns invalid when schema is not an object", () => {
    const result = validateSchema("string input");
    expect(result.valid).toBe(false);
    expect(result.errors).toContain("Schema must be an object");
  });

  it("returns invalid when @type is missing", () => {
    const result = validateSchema({ name: "Acme Corp" });
    expect(result.valid).toBe(false);
    expect(result.errors).toContain("Missing @type field");
  });

  it("warns when @context is missing", () => {
    const result = validateSchema({ "@type": "Person", name: "Alice" });
    expect(result.warnings).toContain("Missing @context field");
  });

  it("warns when @context is not schema.org", () => {
    const result = validateSchema({
      "@type": "Person",
      name: "Alice",
      "@context": "https://example.com/vocab",
    });
    expect(result.warnings.some((w) => w.includes("schema.org"))).toBe(true);
  });

  it("accepts http://schema.org as valid @context", () => {
    const result = validateSchema({
      "@type": "Person",
      name: "Alice",
      "@context": "http://schema.org",
    });
    expect(result.warnings.some((w) => w.includes("Unexpected @context"))).toBe(false);
  });
});

// ── validateSchema — required fields ──────────────────────────────────────

describe("validateSchema — required fields", () => {
  it("returns valid for a complete Organization schema", () => {
    const schema = {
      "@context": "https://schema.org",
      "@type": "Organization",
      name: "Acme Corp",
      url: "https://acme.com",
    };
    const result = validateSchema(schema);
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it("flags missing required fields for Organization", () => {
    const schema = {
      "@context": "https://schema.org",
      "@type": "Organization",
      name: "Acme Corp",
      // url is missing
    };
    const result = validateSchema(schema);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("url"))).toBe(true);
  });

  it("flags missing required fields for Article", () => {
    const schema = {
      "@context": "https://schema.org",
      "@type": "Article",
      headline: "My Article",
      // author, datePublished, publisher missing
    };
    const result = validateSchema(schema);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("author"))).toBe(true);
    expect(result.errors.some((e) => e.includes("datePublished"))).toBe(true);
  });

  it("warns about missing recommended fields for Organization", () => {
    const schema = {
      "@context": "https://schema.org",
      "@type": "Organization",
      name: "Acme Corp",
      url: "https://acme.com",
      // no logo, contactPoint, sameAs
    };
    const result = validateSchema(schema);
    expect(result.warnings.some((w) => w.includes("logo"))).toBe(true);
  });

  it("handles array @type — uses first type", () => {
    const schema = {
      "@context": "https://schema.org",
      "@type": ["Organization", "LocalBusiness"],
      name: "Acme Corp",
      url: "https://acme.com",
    };
    // Uses Organization required fields (not LocalBusiness which needs address+telephone)
    const result = validateSchema(schema);
    expect(result.errors.some((e) => e.includes("address"))).toBe(false);
  });

  it("returns valid=true and no errors for unknown schema type with @type set", () => {
    // No required fields defined for "CustomType"
    const schema = {
      "@context": "https://schema.org",
      "@type": "CustomType",
      name: "something",
    };
    const result = validateSchema(schema);
    expect(result.errors).toHaveLength(0);
    expect(result.valid).toBe(true);
  });
});

// ── validateSchema — BreadcrumbList ───────────────────────────────────────

describe("validateSchema — BreadcrumbList", () => {
  it("returns valid for a correct BreadcrumbList", () => {
    const schema = {
      "@context": "https://schema.org",
      "@type": "BreadcrumbList",
      itemListElement: [
        { "@type": "ListItem", position: 1, name: "Home", item: "https://ex.com" },
        { "@type": "ListItem", position: 2, name: "Blog", item: "https://ex.com/blog" },
      ],
    };
    const result = validateSchema(schema);
    expect(result.valid).toBe(true);
  });

  it("errors when itemListElement is missing @type ListItem", () => {
    const schema = {
      "@context": "https://schema.org",
      "@type": "BreadcrumbList",
      itemListElement: [
        { position: 1, name: "Home" }, // missing @type
      ],
    };
    const result = validateSchema(schema);
    expect(result.errors.some((e) => e.includes("ListItem"))).toBe(true);
  });

  it("errors when itemListElement item has no name or item", () => {
    const schema = {
      "@context": "https://schema.org",
      "@type": "BreadcrumbList",
      itemListElement: [
        { "@type": "ListItem", position: 1 }, // missing name and item
      ],
    };
    const result = validateSchema(schema);
    expect(result.errors.some((e) => e.includes("name or item"))).toBe(true);
  });
});

// ── validateSchema — Product ───────────────────────────────────────────────

describe("validateSchema — Product", () => {
  it("errors when offer is missing price", () => {
    const schema = {
      "@context": "https://schema.org",
      "@type": "Product",
      name: "Widget",
      image: "https://ex.com/img.jpg",
      description: "A widget",
      offers: { "@type": "Offer", priceCurrency: "USD" }, // no price
    };
    const result = validateSchema(schema);
    expect(result.errors.some((e) => e.includes("price"))).toBe(true);
  });

  it("warns when offer is missing availability", () => {
    const schema = {
      "@context": "https://schema.org",
      "@type": "Product",
      name: "Widget",
      image: "https://ex.com/img.jpg",
      description: "A widget",
      offers: { "@type": "Offer", price: "9.99", priceCurrency: "USD" },
    };
    const result = validateSchema(schema);
    expect(result.warnings.some((w) => w.includes("availability"))).toBe(true);
  });
});

// ── validateSchema — Article publisher/author ──────────────────────────────

describe("validateSchema — Article", () => {
  it("errors when publisher is not of type Organization", () => {
    const schema = {
      "@context": "https://schema.org",
      "@type": "Article",
      headline: "My Article",
      author: { "@type": "Person", name: "Alice" },
      datePublished: "2026-01-01",
      publisher: { "@type": "Person", name: "Not an org" },
    };
    const result = validateSchema(schema);
    expect(result.errors.some((e) => e.includes("Organization"))).toBe(true);
  });

  it("errors when author is missing name", () => {
    const schema = {
      "@context": "https://schema.org",
      "@type": "Article",
      headline: "My Article",
      author: { "@type": "Person" }, // no name
      datePublished: "2026-01-01",
      publisher: { "@type": "Organization", name: "Acme Media" },
    };
    const result = validateSchema(schema);
    expect(result.errors.some((e) => e.includes("author") && e.includes("name"))).toBe(true);
  });
});

// ── extractSchemaType ──────────────────────────────────────────────────────

describe("extractSchemaType", () => {
  it("returns null for non-object", () => {
    expect(extractSchemaType("string")).toBeNull();
    expect(extractSchemaType(null)).toBeNull();
  });

  it("returns null when @type is missing", () => {
    expect(extractSchemaType({ name: "Acme" })).toBeNull();
  });

  it("returns the string type directly", () => {
    expect(extractSchemaType({ "@type": "Organization" })).toBe("Organization");
  });

  it("returns first element when @type is an array", () => {
    expect(extractSchemaType({ "@type": ["Organization", "LocalBusiness"] })).toBe("Organization");
  });

  it("returns null when @type array contains non-string first element", () => {
    expect(extractSchemaType({ "@type": [42, "Organization"] })).toBeNull();
  });
});

// ── Review — eligibility is not validity ───────────────────────────────────

/**
 * A testimonial without a star rating is correct markup, and used to fail here.
 *
 * `REQUIRED_FIELDS_BY_TYPE.Review` listed `reviewRating`, so every ratingless
 * `Review` node came back `valid: false` with "Missing required field:
 * reviewRating". Our own homepage publishes three of them on purpose — a business
 * quoting its clients is a self-serving review, which Google excludes from review
 * snippets whatever fields it carries, so a rating there is worth nothing and we
 * do not have one to state. `seo_schema_detection` reported all three as errors,
 * and the only way a customer could clear the same three was to invent numbers no
 * reviewer gave them.
 *
 * Schema.org requires no rating on a `Review`. Google requires one for the review
 * snippet, which is an eligibility claim — hence a warning.
 */
describe("validateSchema — Review", () => {
  const testimonial = {
    "@context": "https://schema.org",
    "@type": "Review",
    itemReviewed: { "@id": "https://thatseoagent.com/#software" },
    reviewBody: "It walks me through every fix step by step.",
    author: { "@type": "Person", name: "Gaby M." },
  };

  it("accepts a review with no rating", () => {
    const result = validateSchema(testimonial);
    expect(result.errors).toEqual([]);
    expect(result.valid).toBe(true);
  });

  it("still says the missing rating forfeits the review snippet", () => {
    // Dropped from `errors`, not dropped altogether: a third-party review that
    // omits a rating gives up the rich result, and that is worth telling someone.
    const result = validateSchema(testimonial);
    expect(result.warnings).toContain("Missing recommended field: reviewRating");
  });

  it("keeps requiring the fields a review is meaningless without", () => {
    const result = validateSchema({
      "@context": "https://schema.org",
      "@type": "Review",
      reviewBody: "Great.",
    });
    expect(result.valid).toBe(false);
    expect(result.errors).toContain("Missing required field: author");
    expect(result.errors).toContain("Missing required field: itemReviewed");
  });
});
