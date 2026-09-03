import { describe, expect, it } from "vitest";
import { pageLanguage } from "@/lib/analyzers/page-language";
import { patternsFor, SUPPORTED_LANGUAGES } from "@/lib/analyzers/answer-patterns";

/**
 * #342: three checks worth 19 points were one English regex, so a correct Spanish
 * page could not pass them. This product sells in Spanish.
 */

describe("pageLanguage", () => {
  it("reads the declaration and reduces it to a base language", () => {
    expect(pageLanguage(`<!DOCTYPE html><html lang="es-419"><body></body></html>`)).toBe("es");
    expect(pageLanguage(`<html lang="EN-gb">`)).toBe("en");
  });

  it("repairs the locale separator real pages copy in from a config", () => {
    expect(pageLanguage(`<html lang="pt_BR">`)).toBe("pt");
  });

  it("returns nothing when the page declares nothing, or nonsense", () => {
    expect(pageLanguage(`<html><body><p>hola</p></body></html>`)).toBeNull();
    expect(pageLanguage(`<html lang="  ">`)).toBeNull();
    expect(pageLanguage(`<html lang="klingon">`)).toBeNull();
  });
});

describe("patternsFor", () => {
  const SPANISH_DEFINITION = "El SEO técnico es una disciplina que se ocupa del rastreo.";
  const ENGLISH_DEFINITION = "Technical SEO is a discipline concerned with crawling.";

  it("reads a definition written in Spanish", () => {
    const choice = patternsFor("es");
    expect(choice.outcome).toBe("language");
    if (choice.outcome !== "unsupported") {
      expect(choice.patterns.definition.test(SPANISH_DEFINITION)).toBe(true);
    }
  });

  it("counts a figure written in Spanish as a statistic", () => {
    // The English set matched `million`, `billion`, `thousand`. A page saying
    // "2 millones de usuarios" matched none of them, so only the `%` branch ever
    // crossed the language line.
    const choice = patternsFor("es");
    if (choice.outcome !== "unsupported") {
      expect(choice.patterns.statistic.test("Atendemos a 2 millones de usuarios")).toBe(true);
      expect(choice.patterns.statistic.test("Más de 40 mil descargas")).toBe(true);
    }
  });

  it("says so instead of guessing when the language has no pattern set", () => {
    const choice = patternsFor("de");
    expect(choice.outcome).toBe("unsupported");
    if (choice.outcome === "unsupported") expect(choice.languageName).toMatch(/German/i);
  });

  it("tests every set it has when the page declares no language", () => {
    // `html[lang]` is missing on a great many real pages, and the repo already reports
    // that separately. Emptying the score over it would cost far more than the rare
    // false positive this risks.
    const choice = patternsFor(null);
    expect(choice.outcome).toBe("everyLanguage");
    if (choice.outcome !== "unsupported") {
      expect(choice.patterns.definition.test(SPANISH_DEFINITION)).toBe(true);
      expect(choice.patterns.definition.test(ENGLISH_DEFINITION)).toBe(true);
    }
  });

  it("does not let the English set match Spanish prose", () => {
    // What makes the every-language fallback safe rather than merely generous.
    const en = patternsFor("en");
    if (en.outcome !== "unsupported") {
      expect(en.patterns.definition.test(SPANISH_DEFINITION)).toBe(false);
    }
  });

  it("treats a region as the language it belongs to", () => {
    expect(patternsFor("es-MX").outcome).toBe("language");
  });

  it("names the languages it can read, for the detail a reader sees", () => {
    expect(SUPPORTED_LANGUAGES).toEqual(expect.arrayContaining(["en", "es"]));
  });
});
