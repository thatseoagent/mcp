/**
 * Schema-content mismatch detector.
 *
 * Flags pages where structured data claims a content type that the rendered DOM
 * doesn't back up. The most common abuse pattern is FAQPage JSON-LD injected on
 * product pages and essays — exactly the pattern Google cited when deprecating
 * FAQ rich results on May 7, 2026 (see /faq-schema-deprecated).
 *
 * Honest schema describes the page accurately. Mismatched schema wastes crawl
 * budget, was the trigger for the FAQ rich-result deprecation cycle, and per
 * the Ahrefs 2026 causal study contributes nothing to AI citation lift.
 */

export type MismatchSeverity = "warning" | "info";

export interface SchemaMismatch {
  type: string;
  severity: MismatchSeverity;
  message: string;
  recommendation: string;
}

interface SchemaShape {
  "@type"?: string | string[];
  [key: string]: unknown;
}

function hasType(s: unknown, target: string): boolean {
  const t = (s as SchemaShape)?.["@type"];
  if (Array.isArray(t)) return t.includes(target);
  return t === target;
}

function findSchema(schemas: readonly unknown[], target: string): SchemaShape | undefined {
  return schemas.find((s) => hasType(s, target)) as SchemaShape | undefined;
}

function detectFaqPageMismatch(html: string, schemas: readonly unknown[]): SchemaMismatch | null {
  if (!schemas.some((s) => hasType(s, "FAQPage"))) return null;

  const hasDisclosure = /<details[^>]*>[\s\S]*?<summary[^>]*>/i.test(html);
  const hasDefList = /<dl[^>]*>[\s\S]*?<dt[^>]*>[\s\S]*?<dd[^>]*>/i.test(html);
  const hasFaqContainer = /(?:class|id)=["'][^"']*faq[^"']*["']/i.test(html);
  const hasQuestionHeading = /<h[1-6][^>]*>\s*(?:[¿?]|what |how |why |when |where |who |which |is |are |does |do |can |should |will )[^<]*\?\s*<\/h[1-6]>/i.test(html);

  const visibleQa = hasDisclosure || hasDefList || hasFaqContainer || hasQuestionHeading;
  if (visibleQa) return null;

  return {
    type: "FAQPage",
    severity: "warning",
    message:
      "FAQPage schema present but no visible Q&A pattern detected in the DOM (no <details>/<summary>, no <dl>/<dt>/<dd>, no FAQ container, no question-style headings).",
    recommendation:
      "Either remove the FAQPage JSON-LD (it produces no Google rich result post-May 2026 and the Ahrefs 2026 study found no AI citation lift), or add a visible Q&A section that honestly matches the schema.",
  };
}

function detectHowToMismatch(html: string, schemas: readonly unknown[]): SchemaMismatch | null {
  if (!schemas.some((s) => hasType(s, "HowTo"))) return null;

  const hasOrderedList = /<ol[^>]*>[\s\S]*?<li[^>]*>/i.test(html);
  const hasStepHeadings = /<h[1-6][^>]*>\s*(?:step\s*\d|paso\s*\d|\d[.)])/i.test(html);
  const hasStepContainer = /(?:class|id)=["'][^"']*step[^"']*["']/i.test(html);

  const visibleSteps = hasOrderedList || hasStepHeadings || hasStepContainer;
  if (visibleSteps) return null;

  return {
    type: "HowTo",
    severity: "warning",
    message:
      "HowTo schema present but no visible step pattern detected in the DOM (no <ol><li>, no 'Step N' headings, no step container).",
    recommendation:
      "Either remove the HowTo JSON-LD or add a visible ordered list of steps. Google removed HowTo rich results from desktop in September 2023; the schema only helps when the content honestly matches.",
  };
}

function detectProductMismatch(html: string, schemas: readonly unknown[]): SchemaMismatch | null {
  const product = findSchema(schemas, "Product");
  if (!product) return null;

  const hasOffers = !!product.offers;
  const hasPriceField = !!(
    (product.offers as SchemaShape)?.price ||
    (product.offers as SchemaShape)?.priceSpecification ||
    product.price
  );
  const hasSku = !!(product.sku || product.gtin || product.gtin13 || product.mpn);

  // Visible buy/add-to-cart signal — proxy for "actually a product page"
  const hasPriceText = /\$[\d,]+(\.\d{2})?|[€£¥]\s?[\d,]+|\d+[.,]\d{2}\s?(?:USD|EUR|GBP|MXN)/i.test(html);
  const hasBuyButton = /<(?:button|a)[^>]*(?:add[\s-]to[\s-]cart|buy[\s-]now|comprar|añadir|checkout)/i.test(html);

  const schemaComplete = hasOffers && hasPriceField && hasSku;
  const domLooksLikeProduct = hasPriceText || hasBuyButton;

  if (schemaComplete && domLooksLikeProduct) return null;

  const missing: string[] = [];
  if (!hasOffers) missing.push("offers");
  if (!hasPriceField) missing.push("price/priceSpecification");
  if (!hasSku) missing.push("sku/gtin/mpn");

  if (missing.length > 0) {
    return {
      type: "Product",
      severity: "warning",
      message: `Product schema present but missing required commerce fields: ${missing.join(", ")}.`,
      recommendation:
        "Either remove the Product schema or complete it with offers, price, and a product identifier (sku/gtin/mpn). Incomplete Product schema does not trigger Google product rich results.",
    };
  }

  // Schema is complete but the DOM has no commerce signals — possible schema-content mismatch
  if (!domLooksLikeProduct) {
    return {
      type: "Product",
      severity: "info",
      message:
        "Product schema is complete but no visible price or buy/add-to-cart element detected in the DOM.",
      recommendation:
        "Confirm this page is actually a product page. Schema should honestly describe the page — if there is no purchasable product on the page, remove the schema.",
    };
  }

  return null;
}

export function detectSchemaMismatches(html: string, schemas: readonly unknown[]): SchemaMismatch[] {
  const mismatches: SchemaMismatch[] = [];
  const faq = detectFaqPageMismatch(html, schemas);
  if (faq) mismatches.push(faq);
  const howTo = detectHowToMismatch(html, schemas);
  if (howTo) mismatches.push(howTo);
  const product = detectProductMismatch(html, schemas);
  if (product) mismatches.push(product);
  return mismatches;
}
