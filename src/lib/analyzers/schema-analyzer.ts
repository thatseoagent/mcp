/**
 * Schema markup detection and validation analyzer.
 * Detects JSON-LD, Microdata, and RDFa structured data formats.
 */

import { load, type CheerioAPI } from "cheerio";
import { readableDocument } from "../visible-text";
import { fetchHtml, validateUrl } from "../http-client";
import {
  validateSchema,
  extractSchemaType,
  type ValidationResult,
} from "../schema-validator";
import { type JsonValue, type Result, success, failure } from "../type-guards";

export interface JsonLdSchema {
  format: "json-ld";
  type: string;
  raw: JsonValue;
  validation: ValidationResult;
}

export interface MicrodataSchema {
  format: "microdata";
  type: string;
  properties: Record<string, string | string[]>;
  validation: ValidationResult;
}

export interface RdfaSchema {
  format: "rdfa";
  type: string;
  properties: Record<string, string | string[]>;
  validation: ValidationResult;
}

export interface SchemaDetectionResult {
  url: string;
  /** What kind of page this is, and therefore which schema types it owes. */
  identity: PageIdentity;
  jsonLd: JsonLdSchema[];
  microdata: MicrodataSchema[];
  rdfa: RdfaSchema[];
  summary: {
    totalSchemas: number;
    schemaTypes: string[];
    formats: ("json-ld" | "microdata" | "rdfa")[];
    validSchemas: number;
    invalidSchemas: number;
  };
  issues: string[];
  mismatches: import("./schema-mismatch-analyzer").SchemaMismatch[];
}

/**
 * Detect all structured data on a page.
 * Returns Result type for explicit error handling.
 */
import { identifyPage, ARTICLE_TYPES, PRODUCT_TYPES, type PageIdentity, type PageKind } from "./page-identity";
import { declaredNodes } from "./json-ld-graph";

export async function detectSchemas(
  url: string
): Promise<Result<SchemaDetectionResult>> {
  try {
    validateUrl(url);

    const html = await fetchHtml(url);
    const $ = load(html);
    // One reading of the document, used by the mismatch detector and by
    // `identifyPage` below. It was built twice for two readers of the same page.
    const readable = readableDocument($);

    // Detect each format
    const jsonLd = detectJsonLd($);
    const microdata = detectMicrodata($);
    const rdfa = detectRdfa($);

    // Calculate summary
    const allSchemas = [...jsonLd, ...microdata, ...rdfa];
    const schemaTypes = [
      ...new Set(allSchemas.map((s) => s.type).filter(Boolean)),
    ];
    const formats: ("json-ld" | "microdata" | "rdfa")[] = [];
    if (jsonLd.length > 0) formats.push("json-ld");
    if (microdata.length > 0) formats.push("microdata");
    if (rdfa.length > 0) formats.push("rdfa");

    const validSchemas = allSchemas.filter((s) => s.validation.valid).length;
    const invalidSchemas = allSchemas.length - validSchemas;

    // Detect issues
    const issues = detectSchemaIssues({
      jsonLd,
      microdata,
      rdfa,
      totalSchemas: allSchemas.length,
    });

    // Detect schema-content mismatches (FAQPage without visible Q&A, etc.)
    const { detectSchemaMismatches } = await import("./schema-mismatch-analyzer");
    const mismatches = detectSchemaMismatches(html, jsonLd.map((s) => s.raw), readable);

    // What kind of page this is decides which schema types it actually owes.
    // A fixed list demanded Article and BreadcrumbList of every URL, which on a
    // homepage asks for a byline it has no author for and a trail of ancestors
    // it has none of.
    // `$` is already in scope; this used to hand `identifyPage` the raw string and
  // pay for a second parse of the document it had just parsed.
  const identity = identifyPage(url, $, readable, schemaTypes);

    return success({
      url,
      identity,
      jsonLd,
      microdata,
      rdfa,
      summary: {
        totalSchemas: allSchemas.length,
        schemaTypes,
        formats,
        validSchemas,
        invalidSchemas,
      },
      issues,
      mismatches,
    });
  } catch (error) {
    const err = error instanceof Error ? error : new Error(String(error));
    return failure(err);
  }
}

/**
 * Detect JSON-LD schemas from <script type="application/ld+json"> tags.
 */
function detectJsonLd($: CheerioAPI): JsonLdSchema[] {
  const schemas: JsonLdSchema[] = [];
  const payloads: unknown[] = [];

  // Parse every block before reading any of them. The nodes a page declares are a
  // property of the page, not of one `<script>` tag: a block can point at a node a
  // later block declares, and resolving that needs all of them in hand.
  $('script[type="application/ld+json"]').each((_, el) => {
    const content = $(el).html();
    if (!content) return;

    try {
      payloads.push(JSON.parse(content));
    } catch {
      // Invalid JSON - record as error
      schemas.push({
        format: "json-ld",
        type: "Invalid",
        raw: content,
        validation: {
          valid: false,
          errors: ["Invalid JSON syntax"],
          warnings: [],
        },
      });
    }
  });

  // A block is usually one object whose `@graph` holds the nodes — the shape Yoast
  // and Rank Math emit — and reading the wrapper instead recorded the whole page as
  // a single schema of type "Unknown" that failed validation.
  for (const schema of declaredNodes(payloads)) {
    schemas.push({
      format: "json-ld",
      type: extractSchemaType(schema) || "Unknown",
      raw: schema as JsonValue,
      validation: validateSchema(schema),
    });
  }

  return schemas;
}

/**
 * Detect Microdata schemas from itemscope/itemprop attributes.
 */
function detectMicrodata($: CheerioAPI): MicrodataSchema[] {
  const schemas: MicrodataSchema[] = [];

  $("[itemscope]").each((_, el) => {
    const $el = $(el);
    const type = $el.attr("itemtype")?.replace(/^https?:\/\/schema\.org\//, "") || "Unknown";

    const properties: Record<string, string | string[]> = {};

    // Extract all itemprop attributes within this scope
    $el.find("[itemprop]").each((_, propEl) => {
      const $prop = $(propEl);
      const propName = $prop.attr("itemprop");
      if (!propName) return;

      // Get value from content, href, src, or text content
      const value =
        $prop.attr("content") ||
        $prop.attr("href") ||
        $prop.attr("src") ||
        $prop.text().trim();

      if (!value) return;

      // Handle multiple properties with same name
      if (properties[propName]) {
        const existing = properties[propName];
        if (Array.isArray(existing)) {
          existing.push(value);
        } else {
          properties[propName] = [existing, value];
        }
      } else {
        properties[propName] = value;
      }
    });

    // Create pseudo-schema object for validation
    const pseudoSchema = {
      "@type": type,
      ...properties,
    };

    const validation = validateSchema(pseudoSchema);

    schemas.push({
      format: "microdata",
      type,
      properties,
      validation,
    });
  });

  return schemas;
}

/**
 * Detect RDFa schemas from typeof/property attributes.
 */
function detectRdfa($: CheerioAPI): RdfaSchema[] {
  const schemas: RdfaSchema[] = [];

  $("[typeof]").each((_, el) => {
    const $el = $(el);
    const type = $el.attr("typeof")?.replace(/^https?:\/\/schema\.org\//, "") || "Unknown";

    const properties: Record<string, string | string[]> = {};

    // Extract all property attributes within this scope
    $el.find("[property]").each((_, propEl) => {
      const $prop = $(propEl);
      const propName = $prop.attr("property");
      if (!propName) return;

      // Get value from content, href, src, or text content
      const value =
        $prop.attr("content") ||
        $prop.attr("href") ||
        $prop.attr("src") ||
        $prop.text().trim();

      if (!value) return;

      // Handle multiple properties with same name
      if (properties[propName]) {
        const existing = properties[propName];
        if (Array.isArray(existing)) {
          existing.push(value);
        } else {
          properties[propName] = [existing, value];
        }
      } else {
        properties[propName] = value;
      }
    });

    // Create pseudo-schema object for validation
    const pseudoSchema = {
      "@type": type,
      ...properties,
    };

    const validation = validateSchema(pseudoSchema);

    schemas.push({
      format: "rdfa",
      type,
      properties,
      validation,
    });
  });

  return schemas;
}

/**
 * Detect common schema-related issues.
 */
function detectSchemaIssues(data: {
  jsonLd: JsonLdSchema[];
  microdata: MicrodataSchema[];
  rdfa: RdfaSchema[];
  totalSchemas: number;
}): string[] {
  const issues: string[] = [];

  // No schemas found
  if (data.totalSchemas === 0) {
    issues.push("No structured data found on page");
    return issues;
  }

  // Validation errors are the one thing this function can judge on its own:
  // a required property is either there or it is not.
  const allSchemas = [...data.jsonLd, ...data.microdata, ...data.rdfa];
  const invalidSchemas = allSchemas.filter((s) => !s.validation.valid);

  if (invalidSchemas.length > 0) {
    issues.push(
      `${invalidSchemas.length} schema(s) have validation errors`
    );
  }

  // Everything else that used to live here was a fixed list of demands made of
  // every page, and `expectedSchemas()` below already answers the same question
  // properly — from what the page actually is. Running both meant a reader got
  // "Organization is not required here" and "Missing Organization schema" in one
  // report. What was removed, and why:
  //
  //   Missing WebSite       — asked of every URL; only a homepage owes it, which
  //                           is what `expectedSchemas` says.
  //   Missing Organization  — same question, answered there with a reason.
  //   Duplicate types       — several Product or BreadcrumbList nodes on one page
  //                           is normal and permitted; nothing in Google's
  //                           guidelines forbids it.
  //   Multiple formats      — Google supports JSON-LD, Microdata and RDFa. It
  //                           recommends JSON-LD; it does not ban mixing, and a
  //                           CMS emitting Microdata beside a theme's JSON-LD is
  //                           not a defect.

  return issues;
}

// ── Section types (co-located with the module that produces them) ──────────────

export type SchemaSection = {
  summary: {
    total: number;
    valid: number;
    invalid: number;
    formats: string[];
    types: string[];
  };
  schemas: Array<{
    type: string;
    format: "json-ld" | "microdata" | "rdfa";
    valid: boolean;
    errors: string[];
    warnings: string[];
  }>;
  issues: string[];
  recommendations: string[];
  geoSchemaStack: {
    complete: boolean;
    present: string[];
    missing: string[];
    /**
     * Why each missing type is owed, keyed by label, so the report can say
     * "BreadcrumbList — the page renders a trail that is not in schema" rather
     * than naming a bare type.
     */
    reasons?: Record<string, string>;
    /** Types this page is excused from, with the reason. */
    exempt?: Array<{ label: string; because: string }>;
    /** The page kind the requirements were derived from, e.g. "Homepage". */
    pageKind?: string;
    /** The evidence behind that call, so a wrong one can be spotted. */
    pageSignals?: string[];
  };
  mismatches: import("./schema-mismatch-analyzer").SchemaMismatch[];
};

// ── Expected schema for a page, derived from its Page Identity ────────────────

export interface SchemaRequirement {
  label: string;
  /** Any one of these satisfies the requirement. */
  types: string[];
  /** Why this page in particular owes it. Rendered in the report. */
  because: string;
}

export interface SchemaExemption {
  label: string;
  /** Why asking for it here would be wrong. Rendered in the report. */
  because: string;
}

export interface SchemaExpectation {
  required: SchemaRequirement[];
  /** Types the old fixed list demanded that this page does not owe. */
  exempt: SchemaExemption[];
}

const ORGANIZATION: SchemaRequirement = {
  label: "Organization",
  types: ["Organization", "LocalBusiness", "NewsMediaOrganization", "OnlineBusiness"],
  because: "identifies who publishes the page, on every page type",
};

/**
 * What this page actually owes, and what it is excused from.
 *
 * The exemptions are returned rather than silently dropped: "Article does not
 * apply to a homepage" is a useful thing for a reader to see, and it is how they
 * can tell the page was identified wrongly.
 *
 * Known limit: a page is judged on what it publishes. An article that declares
 * nothing — no `og:type`, no `<article>` with a date or byline, and not under an
 * article path — reads as `generic` and is exempted from Article rather than
 * nagged for it. That is deliberate. Guessing the other way is how the fixed list
 * came to demand `Article` of every homepage. Pinned in page-identity.test.ts.
 */
export function expectedSchemas(id: PageIdentity): SchemaExpectation {
  const required: SchemaRequirement[] = [ORGANIZATION];
  const exempt: SchemaExemption[] = [];

  if (id.kind === "homepage") {
    required.push({
      label: "WebSite",
      types: ["WebSite"],
      because: "names the site as a whole, which is what a homepage is for",
    });
  }

  if (id.kind === "article") {
    required.push({
      label: "Article",
      types: ARTICLE_TYPES,
      because: "the page is a dated, authored piece of writing",
    });
  } else {
    exempt.push({
      label: "Article",
      because:
        id.kind === "homepage"
          ? "a homepage is not a dated, authored article"
          : `this page reads as ${describeKind(id.kind)}, not an article`,
    });
  }

  if (id.kind === "product") {
    required.push({
      label: "Product",
      types: PRODUCT_TYPES,
      because: "the page presents a single purchasable item",
    });
  }

  // BreadcrumbList describes a trail of ancestors. The root has none, and a page
  // one level down has a trail so short that Google renders nothing for it.
  if (id.isRoot) {
    exempt.push({
      label: "BreadcrumbList",
      because: "the site root has no pages above it to list",
    });
  } else if (id.hasVisibleBreadcrumb) {
    required.push({
      label: "BreadcrumbList",
      types: ["BreadcrumbList"],
      because: "the page renders a breadcrumb trail that is not described in schema",
    });
  } else if (id.depth >= 2) {
    required.push({
      label: "BreadcrumbList",
      types: ["BreadcrumbList"],
      because: `the page sits ${id.depth} levels down, so it has a trail worth describing`,
    });
  } else {
    exempt.push({
      label: "BreadcrumbList",
      because: "the page sits directly under the root and renders no trail",
    });
  }

  return { required, exempt };
}

function describeKind(kind: PageKind): string {
  if (kind === "product") return "a product page";
  if (kind === "collection") return "a listing page";
  if (kind === "profile") return "a profile or about page";
  if (kind === "homepage") return "a homepage";
  return "a general page";
}
