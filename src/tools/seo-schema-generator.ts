import { z } from "zod";
import { type ToolMetadata, type InferSchema } from "xmcp";
import { generateSchema, type SchemaType } from "../lib/schema-generator";
import { type SchemaDataByType } from "../lib/schema-types";
import { isRecord } from "../lib/type-guards";
import { InvalidInputError } from "../lib/invalid-input-error";
import { defineTool } from "../lib/define-tool";
import { toolText } from "../lib/tool-result";

/**
 * The field names `generateSchema` can actually read, across all ten types.
 *
 * `data` used to be `z.record(z.string(), z.unknown())` — an unbounded bag. That
 * is the widest input surface in the server, and the `type` enum below includes
 * `LocalBusiness` and `Person`, so the Tool was effectively inviting a model to
 * put street addresses, phone numbers and people's names into a field with no
 * declared shape. Schema markup is published by the Operator on their own site,
 * so carrying that data is the Tool's purpose — but accepting *arbitrary* keys is
 * not, and an unknown key was silently discarded rather than generated.
 *
 * Listing the keys makes the schema state what it collects, and `.strict()` turns
 * a field we cannot use into an error the caller can see rather than data we
 * quietly accept and drop.
 *
 * Value shapes stay `unknown` on purpose: `generateSchema` and its validator
 * already own per-type validation, and duplicating it here would give two places
 * to disagree about what a valid `offers` looks like.
 */
const SCHEMA_DATA_FIELDS = z
  .object(
    Object.fromEntries(
      [
        "address", "aggregateRating", "articleType", "author", "brand",
        "businessType", "contactPoint", "cookTime", "dateModified",
        "datePublished", "description", "email", "endDate",
        "eventAttendanceMode", "eventStatus", "geo", "headline", "id", "image",
        "items", "jobTitle", "location", "logo", "mpn", "name", "nutrition",
        "offers", "openingHours", "organizer", "prepTime", "priceRange",
        "publisher", "questions", "recipeCategory", "recipeCuisine",
        "recipeIngredient", "recipeInstructions", "recipeYield", "sameAs",
        "searchUrl", "sku", "startDate", "telephone", "totalTime", "url",
        "worksFor",
      ].map((field) => [field, z.unknown().optional()]),
    ),
  )
  .strict();

export const schema = {
  type: z
    .enum([
      "Organization",
      "LocalBusiness",
      "Article",
      "Product",
      "BreadcrumbList",
      "WebSite",
      "Person",
      "Event",
      "FAQPage",
      "Recipe",
    ])
    .describe("The type of schema to generate"),
  data: SCHEMA_DATA_FIELDS.describe(
    "Type-specific data fields for the chosen type. Only the fields that type " +
      "uses are read; anything else is rejected rather than silently dropped. " +
      "Fields left empty use placeholder values like [ORGANIZATION_NAME].",
  ),
};

export const metadata: ToolMetadata = {
  name: "seo_schema_generator",
  description:
    "Generate valid JSON-LD structured data for one of ten schema.org types, with " +
    "the HTML snippet to paste into the page and a list of the placeholder fields " +
    "left to fill in. Needs no credentials, no database and no network. Returns an " +
    "error naming the field when the data given cannot make a valid payload.",
  annotations: {
    title: "Generate schema markup",
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
};

/** Completes the sentence "Could not …" for every failure this Tool can return. */
const FAILURE_CONTEXT = "generate the schema markup";

export default defineTool(
  FAILURE_CONTEXT,
  async ({ type, data }: InferSchema<typeof schema>) => {
    // Belt and braces, and the braces are worth stating: zod rejects a non-object
    // `data` at the MCP boundary, so this only fires for a caller reaching the
    // handler directly. It costs one line and it names the argument, where the
    // alternative is `generateSchema` reading properties off a string and the
    // reader being told the failure was unexpected.
    if (!isRecord(data)) {
      throw new InvalidInputError("data must be an object of schema fields");
    }

    // The cast is what the schema above buys: zod has already established that
    // `data` holds only fields this generator reads, and the per-type shape of
    // each one is the generator's own to validate.
    const result = generateSchema(type as SchemaType, data as SchemaDataByType[SchemaType]);
    const lines: string[] = [];

    lines.push("=== GENERATED SCHEMA ===");
    lines.push(`Type: ${type}`);
    lines.push(`Valid: ${result.validation.valid ? "✓" : "✗"}`);

    if (result.missingFields.length > 0) {
      lines.push("\nPlaceholder fields (replace before use):");
      for (const field of result.missingFields) lines.push(`  - ${field}`);
    }

    if (result.validation.errors.length > 0) {
      lines.push("\n=== VALIDATION ERRORS ===");
      for (const error of result.validation.errors) lines.push(`- ${error}`);
    }

    if (result.validation.warnings.length > 0) {
      lines.push("\n=== WARNINGS ===");
      for (const warning of result.validation.warnings) lines.push(`- ${warning}`);
    }

    lines.push("\n=== JSON-LD ===");
    lines.push(result.jsonLd);

    lines.push("\n=== HTML SNIPPET ===");
    lines.push("Copy and paste into <head> section:");
    lines.push("```html");
    lines.push(result.htmlSnippet);
    lines.push("```");

    lines.push("\n=== INSTRUCTIONS ===");
    lines.push(
      result.missingFields.length > 0
        ? "1. Replace all placeholder values in [BRACKETS] with actual data"
        : "1. Schema is complete and ready to use",
    );
    lines.push(
      "2. Validate with Google Rich Results Test: https://search.google.com/test/rich-results",
    );
    lines.push("3. Add to <head> section of your HTML");
    lines.push("4. Test live pages with Rich Results Test after deployment");

    return toolText(lines.join("\n"));
  },
);
