import { describe, it, expect } from "vitest";
import { generateSchema, type SchemaType } from "@/lib/schema-generator";
import { InvalidInputError } from "@/lib/invalid-input-error";

/**
 * The generator, on its own.
 *
 * `seo_schema_generator` is the one Tool that fetches nothing, and it had five
 * cases against 458 lines — 42% of them — all through the rendered text. Every
 * type below emits its own placeholder set, and which placeholders get *reported*
 * decides whether the Tool says "replace these" or "ready to use".
 */

const ALL_TYPES: SchemaType[] = [
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
];

/** The smallest input each type accepts: the two list types need their list. */
const MINIMAL: { [K in SchemaType]: unknown } = {
  Organization: {},
  LocalBusiness: {},
  Article: {},
  Product: {},
  BreadcrumbList: { items: [{}] },
  WebSite: {},
  Person: {},
  Event: {},
  FAQPage: { questions: [{}] },
  Recipe: {},
};

const generate = (type: SchemaType, data: unknown) =>
  // The Tool's own schema types each `data` per `type`; this walks all ten
  // through one call site, which is the only place the cast is needed.
  generateSchema(type, data as never);

describe("every type it claims to support", () => {
  for (const type of ALL_TYPES) {
    it(`emits valid JSON-LD for ${type}`, () => {
      const result = generate(type, MINIMAL[type]);
      const parsed = JSON.parse(result.jsonLd) as Record<string, unknown>;

      expect(parsed["@context"]).toBe("https://schema.org");
      expect(parsed["@type"]).toBe(type);
      expect(result.htmlSnippet).toContain('<script type="application/ld+json">');
      expect(result.htmlSnippet).toContain(result.jsonLd);
    });
  }

  it("refuses a type it does not generate, naming it", () => {
    expect(() => generate("Cheese" as SchemaType, {})).toThrow(InvalidInputError);
  });
});

describe("a placeholder is reported, whatever it looks like", () => {
  /**
   * Every placeholder in the document, read off the JSON rather than the list
   * under test — so the assertion is "the list is complete", not "the list
   * matches itself".
   */
  const placeholdersInJson = (jsonLd: string): string[] => [
    ...new Set([...jsonLd.matchAll(/"\[([^"[\]]+)\]"/g)].map(([, name]) => name)),
  ];

  for (const type of ALL_TYPES) {
    it(`leaves nothing unreported for ${type}`, () => {
      const result = generate(type, MINIMAL[type]);

      expect([...result.missingFields].sort()).toEqual(placeholdersInJson(result.jsonLd).sort());
    });
  }

  it("reports a date placeholder, which used to be invisible", () => {
    const event = generate("Event", {});

    // `/\[([A-Z_]+)\]/` did not match `[YYYY-MM-DDTHH:MM]` — digits, a dash and
    // a colon — so an Event with no `startDate` was handed over under the
    // instruction "Schema is complete and ready to use", with
    // `"startDate": "[YYYY-MM-DDTHH:MM]"` in the document.
    expect(event.jsonLd).toContain("[YYYY-MM-DDTHH:MM]");
    expect(event.missingFields).toContain("YYYY-MM-DDTHH:MM");
  });

  it("reports a numbered placeholder, which used to be invisible too", () => {
    const crumbs = generate("BreadcrumbList", { items: [{}, {}] });

    // `[ITEM_1_NAME]` carries a digit.
    expect(crumbs.missingFields).toContain("ITEM_1_NAME");
    expect(crumbs.missingFields).toContain("ITEM_2_URL");
  });

  it("reports each placeholder once, in the order it appears", () => {
    const recipe = generate("Recipe", {});

    expect(new Set(recipe.missingFields).size).toBe(recipe.missingFields.length);
    expect(recipe.missingFields[0]).toBe("RECIPE_NAME");
  });

  it("reports nothing when the caller supplied everything", () => {
    const crumbs = generate("BreadcrumbList", {
      items: [
        { name: "Home", url: "https://acme.example/" },
        { name: "Docs", url: "https://acme.example/docs" },
      ],
    });

    expect(crumbs.missingFields).toEqual([]);
    // No bracketed *value* left; the array brackets of `itemListElement` stay.
    expect(crumbs.jsonLd).not.toMatch(/"\[[^"]*\]"/);
  });
});

describe("the data the caller gave travels", () => {
  it("numbers breadcrumb positions from one, in order", () => {
    const crumbs = generate("BreadcrumbList", {
      items: [{ name: "Home", url: "https://a/" }, { name: "Docs", url: "https://a/docs" }],
    });
    const parsed = JSON.parse(crumbs.jsonLd) as { itemListElement: Array<{ position: number; name: string }> };

    expect(parsed.itemListElement.map((item) => item.position)).toEqual([1, 2]);
    expect(parsed.itemListElement[1].name).toBe("Docs");
  });

  it("keeps a question and its answer together", () => {
    const faq = generate("FAQPage", {
      questions: [{ question: "Is it free?", answer: "The server is MIT-licensed." }],
    });
    const parsed = JSON.parse(faq.jsonLd) as {
      mainEntity: Array<{ name: string; acceptedAnswer: { text: string } }>;
    };

    expect(parsed.mainEntity[0].name).toBe("Is it free?");
    expect(parsed.mainEntity[0].acceptedAnswer.text).toBe("The server is MIT-licensed.");
  });

  it("takes one image or several", () => {
    const one = JSON.parse(generate("Recipe", { image: "https://a/1.png" }).jsonLd) as { image: string[] };
    const many = JSON.parse(
      generate("Recipe", { image: ["https://a/1.png", "https://a/2.png"] }).jsonLd,
    ) as { image: string[] };

    expect(one.image).toEqual(["https://a/1.png"]);
    expect(many.image).toHaveLength(2);
  });

  it("refuses the two types whose list it cannot invent", () => {
    // Named fields rather than a generic failure: the caller supplied the
    // argument, so the caller is the party who can fix it.
    expect(() => generate("BreadcrumbList", {})).toThrow(/items/);
    expect(() => generate("FAQPage", {})).toThrow(/questions/);
  });
});
