import { beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { readPage } from "@/lib/analyzers/parsed-page";

/**
 * Counting real parses needs the module mocked at load time — `vi.spyOn` cannot
 * redefine an ESM export.
 */
const parses = { count: 0 };
vi.mock("cheerio", async (importOriginal) => {
  const actual = await importOriginal<typeof import("cheerio")>();
  return {
    ...actual,
    load: (...args: Parameters<typeof actual.load>) => {
      parses.count++;
      return actual.load(...args);
    },
  };
});

/**
 * C5. `html: string` was the currency of the analyzer tree, so the same document
 * was parsed repeatedly inside one tool run. Measured before this module:
 * `ai_visibility_score` 5 parses, `seo_eeat_score` 4, `seo_geo_score` 2.
 *
 * The laziness is not an optimisation, it is the argument. `page-identity` took
 * raw HTML on purpose — "so no caller has to know cheerio is involved:
 * `geo-tools` works entirely in strings and would otherwise acquire a dependency
 * it has no other use for" — and that goal is real. Lazy fields meet it without
 * paying for a second parse: a caller that never reads `$` never parses and
 * never links a parser. See ADR-0022.
 */

const HTML = `<!DOCTYPE html>
<html lang="es-419">
  <head>
    <title>Título</title>
    <script type="application/ld+json">{"@graph":[{"@type":"Organization","name":"Acme"}]}</script>
  </head>
  <body><article><h1>Hola</h1><p>Contenido visible.</p></article>
    <footer>Pie de página</footer>
  </body>
</html>`;

/** Counts real `cheerio.load` calls for the duration of one assertion. */
function countingLoads<T>(body: () => T): { result: T; loads: number } {
  const before = parses.count;
  const result = body();
  return { result, loads: parses.count - before };
}

beforeEach(() => { parses.count = 0; });

describe("a page nobody reads is never parsed", () => {
  it("parses nothing when only url and html are touched", () => {
    // `geo-tools` imports no cheerio, and this is what keeps that true while it
    // still holds a ParsedPage. The string argument was protecting exactly this.
    const { loads } = countingLoads(() => {
      const page = readPage("https://example.com/a", HTML);
      return [page.url, page.html];
    });
    expect(loads).toBe(0);
  });

  it("parses nothing to answer the language, which is read off the raw markup", () => {
    const { result, loads } = countingLoads(() => readPage("https://example.com/a", HTML).language);
    expect(result).toBe("es");
    expect(loads).toBe(0);
  });

  it("parses nothing to answer the schemas, for the same reason", () => {
    const { result, loads } = countingLoads(() => readPage("https://example.com/a", HTML).schemas);
    // `@graph` flattened, as `extractJsonLd` and `flattenJsonLd` already did.
    expect(result.length).toBeGreaterThan(0);
    expect(loads).toBe(0);
  });
});

describe("a page read many times is parsed once", () => {
  it("shares one parse across every field that needs the tree", () => {
    const { loads } = countingLoads(() => {
      const page = readPage("https://example.com/a", HTML);
      return [page.$, page.readable.allText(), page.identity.kind, page.$("h1").text()];
    });
    // The whole point. Before this module, those four readers were four parses:
    // one in the handler, one in `identifyPage`, and one per analyzer entry point.
    expect(loads).toBe(1);
  });

  it("returns the same instances, not equal copies", () => {
    const page = readPage("https://example.com/a", HTML);
    expect(page.$).toBe(page.$);
    expect(page.readable).toBe(page.readable);
    expect(page.identity).toBe(page.identity);
    expect(page.schemas).toBe(page.schemas);
  });
});

describe("the fields answer what their own modules answer", () => {
  it("identity comes from page-identity, schemas included", () => {
    const page = readPage("https://example.com/", HTML);
    expect(page.identity.isRoot).toBe(true);
  });

  it("readable tells copy from chrome", () => {
    const page = readPage("https://example.com/a", HTML);
    expect(page.readable.mainContent()).toContain("Contenido visible");
    expect(page.readable.allText()).toContain("Pie de página");
    expect(page.readable.mainContent()).not.toContain("Pie de página");
  });

  it("language reduces a region subtag to its base", () => {
    expect(readPage("https://example.com/a", HTML).language).toBe("es");
  });

  it("survives markup with nothing in it", () => {
    const page = readPage("https://example.com/a", "");
    expect(page.schemas).toEqual([]);
    expect(page.language).toBeNull();
    expect(page.readable.allText()).toBe("");
  });
});

describe("a page React streamed still has its headings (#397)", () => {
  // The unit-level guards live in tests/lib/visible-text.test.ts. These are
  // here because the damage was never visible at that level: the parse looked
  // fine, `headings` was simply empty, and `seo-rules` turned that into a
  // confident "Missing H1 heading" about a page whose H1 we had been sent.
  const fixture = readFileSync(
    join(import.meta.dirname, "../fixtures/react-streamed-commet.html"),
    "utf8"
  );

  it("reads the headings the server sent, so no rule can call the H1 missing", () => {
    const page = readPage("https://commet.co/", fixture);

    expect(page.readable.texts("h1")).toEqual([
      "The billing infrastructure for AI-native companies",
    ]);
  });

  it("reads every heading level, not just the one a rule happens to ask about", () => {
    // The counts are the real page's, taken from markup we did not write. Before
    // the fix all four were zero.
    const page = readPage("https://commet.co/", fixture);

    expect(page.readable.texts("h2")).toHaveLength(4);
    expect(page.readable.texts("h3")).toHaveLength(13);
    expect(page.readable.texts("h4")).toHaveLength(9);
  });
});
