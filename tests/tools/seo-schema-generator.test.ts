import { describe, it, expect } from "vitest";
import seoSchemaGenerator from "@/tools/seo-schema-generator";

const textOf = (result: Awaited<ReturnType<typeof seoSchemaGenerator>>): string =>
  result.content.map((part) => part.text).join("\n");

describe("seo_schema_generator", () => {
  it("generates JSON-LD carrying the data it was given", async () => {
    const text = textOf(
      await seoSchemaGenerator({
        type: "Organization",
        data: {
          name: "Acme Ltd",
          url: "https://acme.example",
          logo: "https://acme.example/logo.png",
        },
      }),
    );

    expect(text).toContain("Type: Organization");
    expect(text).toContain('"@type": "Organization"');
    expect(text).toContain('"name": "Acme Ltd"');
    expect(text).toContain('<script type="application/ld+json">');
  });

  it("names every placeholder left to fill in rather than passing them off as data", async () => {
    const text = textOf(await seoSchemaGenerator({ type: "Organization", data: {} }));

    expect(text).toContain("Placeholder fields (replace before use):");
    expect(text).toContain("[");
    expect(text).toContain("1. Replace all placeholder values in [BRACKETS] with actual data");
  });

  it("says the schema is ready when nothing is left to replace", async () => {
    const text = textOf(
      await seoSchemaGenerator({
        type: "BreadcrumbList",
        data: {
          items: [
            { name: "Home", url: "https://acme.example/" },
            { name: "Blog", url: "https://acme.example/blog" },
          ],
        },
      }),
    );

    expect(text).toContain("Valid: ✓");
    expect(text).toContain("1. Schema is complete and ready to use");
  });

  it("names `data` when it is not an object at all", async () => {
    // zod rejects this at the MCP boundary; the guard is for a caller reaching the
    // handler directly, and it names the argument rather than reporting an
    // unexpected failure.
    const result = await seoSchemaGenerator({
      type: "Organization",
      data: "not an object" as never,
    });

    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("data must be an object");
  });

  it("tells the caller which argument is wrong when the data cannot make a payload", async () => {
    // `InvalidInputError` is forwarded verbatim: the caller supplied the field, so
    // the caller is the party that can fix it on the next call.
    const result = await seoSchemaGenerator({
      type: "BreadcrumbList",
      data: { items: "not an array" },
    });

    expect(result.isError).toBe(true);
    expect(textOf(result)).toMatch(/items/i);
  });
});
