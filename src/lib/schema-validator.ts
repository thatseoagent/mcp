/**
 * Schema.org validation utilities.
 * Validates structured data against required fields for common schema types.
 */

import { isRecord, type SchemaObject } from "./type-guards";

export interface ValidationResult {
  valid: boolean;
  errors: string[];
  warnings: string[];
}

/**
 * BreadcrumbList item (ListItem type).
 */
export interface BreadcrumbItem {
  "@type"?: string;
  position?: number;
  name?: string;
  item?: string;
  [key: string]: unknown;
}

/**
 * Product offer object.
 */
export interface ProductOffer {
  "@type"?: string;
  price?: string | number;
  priceCurrency?: string;
  availability?: string;
  url?: string;
  priceValidUntil?: string;
  [key: string]: unknown;
}

/**
 * Required fields for common Schema.org types.
 * Based on Google's structured data guidelines.
 */
export const REQUIRED_FIELDS_BY_TYPE: Record<string, string[]> = {
  Organization: ["@type", "name", "url"],
  LocalBusiness: ["@type", "name", "address", "telephone"],
  Article: ["@type", "headline", "author", "datePublished", "publisher"],
  NewsArticle: ["@type", "headline", "author", "datePublished", "publisher"],
  BlogPosting: ["@type", "headline", "author", "datePublished", "publisher"],
  Product: ["@type", "name", "image", "description", "offers"],
  BreadcrumbList: ["@type", "itemListElement"],
  WebSite: ["@type", "name", "url"],
  WebPage: ["@type", "name", "url"],
  Person: ["@type", "name"],
  /**
   * No `reviewRating`. It is a rich-result eligibility requirement, not a
   * validity one, and putting it here reported correct markup as broken.
   *
   * Schema.org does not require it: `Review` is well-formed with a `reviewBody`
   * and an `author` and nothing else. Google requires it for the *review
   * snippet*, which is a different claim — and one that cannot apply to the most
   * common shape of `Review` on the web. A testimonial a business publishes
   * about itself is a self-serving review, ineligible for review snippets under
   * Google's own policy no matter what fields it carries, so a rating on it buys
   * nothing.
   *
   * Our own homepage is that case, deliberately (see the comment on `reviews` in
   * `app/[locale]/(landing)/page.tsx`): three ratingless testimonial nodes, and
   * this table called all three invalid. Any customer marking up testimonials
   * the same correct way got the same three errors, and the only way to clear
   * them was to invent numbers no reviewer gave. A validator that can be
   * satisfied only by making the data up is worse than one that stays quiet.
   *
   * It is a recommendation instead, below — where a missing eligibility field
   * belongs.
   */
  Review: ["@type", "itemReviewed", "author"],
  Rating: ["@type", "ratingValue"],
  Event: ["@type", "name", "startDate", "location"],
  FAQPage: ["@type", "mainEntity"],
  HowTo: ["@type", "name", "step"],
  Recipe: ["@type", "name", "image", "author", "datePublished"],
  VideoObject: ["@type", "name", "description", "thumbnailUrl", "uploadDate"],
};

/**
 * Recommended fields that improve schema quality.
 */
const RECOMMENDED_FIELDS_BY_TYPE: Record<string, string[]> = {
  Organization: ["logo", "contactPoint", "sameAs"],
  LocalBusiness: ["image", "priceRange", "openingHours"],
  Article: ["image", "dateModified"],
  Product: ["brand", "sku", "aggregateRating"],
  Person: ["url", "image", "jobTitle"],
  // `reviewRating` moved down from required — see the note there. A third-party
  // review that omits it forfeits the review snippet, which is worth saying; a
  // self-serving one was never eligible, which is why this is not an error.
  Review: ["reviewRating", "datePublished"],
  Event: ["endDate", "organizer", "performer"],
};

/**
 * Check if a value exists and is not empty.
 */
function hasValue(obj: unknown, path: string): boolean {
  const keys = path.split(".");
  let current: unknown = obj;

  for (const key of keys) {
    if (!isRecord(current)) return false;
    current = current[key];
  }

  if (current === null || current === undefined) return false;
  if (typeof current === "string" && current.trim() === "") return false;
  if (Array.isArray(current) && current.length === 0) return false;

  return true;
}

/**
 * Validate a schema object against its type's required fields.
 */
export function validateSchema(
  schema: unknown,
  type?: string
): ValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];

  // Validate that schema is an object
  if (!isRecord(schema)) {
    errors.push("Schema must be an object");
    return { valid: false, errors, warnings };
  }

  // Determine schema type
  const schemaType = type || schema["@type"];
  if (!schemaType) {
    errors.push("Missing @type field");
    return { valid: false, errors, warnings };
  }

  // Handle array of types (e.g., ["Person", "Organization"])
  const types = Array.isArray(schemaType) ? schemaType : [schemaType];
  const primaryType = types[0];

  // Check required fields
  const requiredFields = REQUIRED_FIELDS_BY_TYPE[primaryType];
  if (requiredFields) {
    for (const field of requiredFields) {
      if (!hasValue(schema, field)) {
        errors.push(`Missing required field: ${field}`);
      }
    }
  }

  // Check recommended fields
  const recommendedFields = RECOMMENDED_FIELDS_BY_TYPE[primaryType];
  if (recommendedFields) {
    for (const field of recommendedFields) {
      if (!hasValue(schema, field)) {
        warnings.push(`Missing recommended field: ${field}`);
      }
    }
  }

  // Validate @context
  const context = schema["@context"];
  if (!context) {
    warnings.push("Missing @context field");
  } else if (typeof context === "string") {
    if (
      !context.includes("schema.org") &&
      context !== "https://schema.org" &&
      context !== "http://schema.org"
    ) {
      warnings.push(
        "Unexpected @context value (should be https://schema.org)"
      );
    }
  }

  // Type-specific validations
  if (primaryType === "BreadcrumbList") {
    validateBreadcrumbList(schema, errors, warnings);
  } else if (primaryType === "Product") {
    validateProduct(schema, errors, warnings);
  } else if (["Article", "NewsArticle", "BlogPosting"].includes(primaryType)) {
    validateArticle(schema, errors, warnings);
  }

  return {
    valid: errors.length === 0,
    errors,
    warnings,
  };
}

/**
 * Validate BreadcrumbList specific requirements.
 */
function validateBreadcrumbList(
  schema: SchemaObject,
  errors: string[],
  _warnings: string[]
): void {
  if (!Array.isArray(schema.itemListElement)) {
    errors.push("itemListElement must be an array");
    return;
  }

  if (schema.itemListElement.length === 0) {
    errors.push("itemListElement array is empty");
  }

  // Check each breadcrumb item
  schema.itemListElement.forEach((item: unknown, index: number) => {
    if (!isRecord(item)) {
      errors.push(`itemListElement[${index}] is not an object`);
      return;
    }

    const breadcrumb = item as BreadcrumbItem;
    if (!breadcrumb["@type"] || breadcrumb["@type"] !== "ListItem") {
      errors.push(`itemListElement[${index}] missing @type: ListItem`);
    }
    if (!hasValue(breadcrumb, "position")) {
      errors.push(`itemListElement[${index}] missing position`);
    }
    if (!hasValue(breadcrumb, "name") && !hasValue(breadcrumb, "item")) {
      errors.push(`itemListElement[${index}] missing name or item`);
    }
  });
}

/**
 * Validate Product specific requirements.
 */
function validateProduct(
  schema: SchemaObject,
  errors: string[],
  warnings: string[]
): void {
  if (hasValue(schema, "offers")) {
    const offers = Array.isArray(schema.offers)
      ? schema.offers
      : [schema.offers];

    offers.forEach((offer: unknown, index: number) => {
      if (!isRecord(offer)) {
        errors.push(`offers[${index}] is not an object`);
        return;
      }

      const productOffer = offer as ProductOffer;
      if (!hasValue(productOffer, "price")) {
        errors.push(`offers[${index}] missing price`);
      }
      if (!hasValue(productOffer, "priceCurrency")) {
        errors.push(`offers[${index}] missing priceCurrency`);
      }
      if (!hasValue(productOffer, "availability")) {
        warnings.push(`offers[${index}] missing availability`);
      }
    });
  }

  // Validate aggregateRating if present
  if (hasValue(schema, "aggregateRating")) {
    const rating = schema.aggregateRating;
    if (!hasValue(rating, "ratingValue")) {
      errors.push("aggregateRating missing ratingValue");
    }
    if (!hasValue(rating, "reviewCount") && !hasValue(rating, "ratingCount")) {
      warnings.push("aggregateRating missing reviewCount or ratingCount");
    }
  }
}

/**
 * Validate Article specific requirements.
 */
function validateArticle(
  schema: SchemaObject,
  errors: string[],
  warnings: string[]
): void {
  // Publisher must be Organization
  if (hasValue(schema, "publisher")) {
    const publisher = schema.publisher;
    if (isRecord(publisher)) {
      if (publisher["@type"] !== "Organization") {
        errors.push("publisher must be of type Organization");
      } else {
        if (!hasValue(publisher, "name")) {
          errors.push("publisher missing name");
        }
        if (!hasValue(publisher, "logo")) {
          warnings.push("publisher missing logo");
        }
      }
    }
  }

  // Author validation
  if (hasValue(schema, "author")) {
    const authors = Array.isArray(schema.author)
      ? schema.author
      : [schema.author];

    authors.forEach((author: unknown, index: number) => {
      if (!isRecord(author)) return;

      if (!author["@type"]) {
        warnings.push(`author[${index}] missing @type`);
      } else if (author["@type"] !== "Person" && author["@type"] !== "Organization") {
        warnings.push(
          `author[${index}] @type should be Person or Organization`
        );
      }
      if (!hasValue(author, "name")) {
        errors.push(`author[${index}] missing name`);
      }
    });
  }

  // Image validation
  if (hasValue(schema, "image")) {
    const images = Array.isArray(schema.image)
      ? schema.image
      : [schema.image];

    if (images.length === 0) {
      warnings.push("Article should have at least one image");
    }
  }
}

/**
 * Extract schema type from a schema object.
 * Handles both single type and array of types.
 */
export function extractSchemaType(schema: unknown): string | null {
  if (!isRecord(schema)) return null;

  const type = schema["@type"];
  if (!type) return null;

  if (Array.isArray(type)) {
    const firstType = type[0];
    return typeof firstType === "string" ? firstType : null;
  }

  return typeof type === "string" ? type : null;
}
