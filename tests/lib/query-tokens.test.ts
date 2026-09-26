import { describe, it, expect } from "vitest";
import { coverage, fold, tokeniserFor, words } from "@/lib/query-tokens";

function significant(language: string | null, text: string): string[] {
  const tokeniser = tokeniserFor(language);
  if (tokeniser.outcome === "unsupported") throw new Error("unsupported");
  return tokeniser.significant(text);
}

describe("query tokens", () => {
  it("folds case and diacritics, so a query typed without accents matches its title", () => {
    expect(fold("Diseño Web")).toBe("diseno web");
    const result = coverage(significant("es", "diseno web"), words("Diseño web en Barcelona"));
    expect(result.missing).toEqual([]);
  });

  it("drops filler words in English and Spanish", () => {
    expect(significant("en", "how to fix the seo of a site")).toEqual(["fix", "seo", "site"]);
    expect(significant("es-MX", "cómo mejorar el seo de una web")).toEqual(["mejorar", "seo", "web"]);
  });

  it("keeps a query made only of filler rather than emptying it", () => {
    expect(significant("en", "how to")).toEqual(["how", "to"]);
  });

  it("matches a word and its plural, and ignores order", () => {
    const result = coverage(significant("en", "seo audit tool"), words("Tools for SEO audits"));
    expect(result.found).toEqual(["seo", "audit", "tool"]);
    expect(result.missing).toEqual([]);
  });

  it("names the words a title is missing", () => {
    const result = coverage(significant("en", "free seo checker"), words("SEO Checker"));
    expect(result.missing).toEqual(["free"]);
  });

  it("says unsupported for a language it has no stopwords for, rather than guessing", () => {
    const tokeniser = tokeniserFor("de-DE");
    expect(tokeniser.outcome).toBe("unsupported");
    if (tokeniser.outcome === "unsupported") {
      expect(tokeniser.language).toBe("de");
      expect(tokeniser.languageName).toBe("German");
    }
  });

  it("uses every set when the page declares no language", () => {
    expect(tokeniserFor(null).outcome).toBe("everyLanguage");
    expect(significant(null, "the mejor guía de seo")).toEqual(["guia", "seo"]);
  });
});
