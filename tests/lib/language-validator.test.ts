import { describe, expect, it } from "vitest";
import {
  validateLanguageCode,
  parseLanguageCode,
  normalizeLanguageCode,
  regionCodeMistakenForLanguage,
} from "@/lib/language-validator";

/**
 * Google names the accepted shape of an hreflang value, and it is wider than the
 * two-letter pairs the old hand-written allow-list covered: script subtags are
 * supported, and Google's own examples use them.
 *
 * The allow-list held ~70 languages and ~60 countries, so every code outside it
 * came back `critical: Invalid language code` — including `zh-Hant`, which is a
 * Google example, and `es-419`, which is how Latin America is addressed.
 */
describe("hreflang codes Google documents as valid", () => {
  it("accepts a bare ISO 639-1 language", () => {
    expect(validateLanguageCode("en")).toBe(true);
    expect(validateLanguageCode("es")).toBe(true);
  });

  it("accepts language-region", () => {
    expect(validateLanguageCode("en-GB")).toBe(true);
    expect(validateLanguageCode("pt-BR")).toBe(true);
  });

  it("accepts the script subtags Google gives as examples", () => {
    expect(validateLanguageCode("zh-Hans")).toBe(true);
    expect(validateLanguageCode("zh-Hant")).toBe(true);
  });

  it("accepts language-script-region", () => {
    expect(validateLanguageCode("zh-Hant-TW")).toBe(true);
  });

  it("accepts UN M49 numeric regions, which is how es-419 addresses Latin America", () => {
    expect(validateLanguageCode("es-419")).toBe(true);
  });

  it("accepts x-default", () => {
    expect(validateLanguageCode("x-default")).toBe(true);
  });

  it("accepts languages outside the old hand-written set", () => {
    // Zulu, Yoruba, Maltese, Faroese: all ISO 639-1, none in the old Set.
    for (const code of ["zu", "yo", "mt", "fo"]) {
      expect(validateLanguageCode(code), code).toBe(true);
    }
  });

  it("accepts a region that is not one of the 60 the old list knew", () => {
    expect(validateLanguageCode("es-BO")).toBe(true);
    expect(validateLanguageCode("fr-SN")).toBe(true);
  });

  it("is case-insensitive, since Google says the value is not case-sensitive", () => {
    expect(validateLanguageCode("EN-gb")).toBe(true);
    expect(validateLanguageCode("zh-hant")).toBe(true);
  });
});

describe("hreflang codes that are genuinely wrong", () => {
  it("rejects a language subtag that is not ISO 639-1", () => {
    expect(validateLanguageCode("zz")).toBe(false);
    expect(validateLanguageCode("eng")).toBe(false);
  });

  it("rejects the wrong separator", () => {
    expect(validateLanguageCode("fr_CA")).toBe(false);
  });

  it("rejects an empty value", () => {
    expect(validateLanguageCode("")).toBe(false);
  });

  it("rejects a four-letter language subtag", () => {
    expect(validateLanguageCode("engl")).toBe(false);
  });
});

describe("region code mistaken for a language", () => {
  /**
   * Google: "You can't specify the country code by itself. The first code stands
   * for the language." The trap is that some of those country codes parse as
   * real languages, so form alone cannot catch them — `uk` is Ukrainian, not the
   * United Kingdom. Worth a warning, never a hard failure.
   */
  it("flags uk, which is Ukrainian and almost always meant as the United Kingdom", () => {
    expect(regionCodeMistakenForLanguage("uk")).toContain("en-GB");
  });

  it("does not flag uk-UA, which is unambiguous", () => {
    expect(regionCodeMistakenForLanguage("uk-UA")).toBeNull();
  });

  it("does not flag an ordinary language", () => {
    expect(regionCodeMistakenForLanguage("es")).toBeNull();
  });

  /**
   * Google gives "EU" as an invalid value, but the reason is subtler than the
   * doc's phrasing suggests: `eu` is Basque, a real ISO 639-1 language, so it
   * passes every form check. Only the intent is wrong.
   */
  it("flags eu, which is Basque and usually means the European Union", () => {
    expect(regionCodeMistakenForLanguage("eu")).toContain("Basque");
  });
});

describe("parsing", () => {
  it("splits language, script and region", () => {
    expect(parseLanguageCode("zh-Hant-TW")).toEqual({
      language: "zh",
      script: "Hant",
      region: "TW",
    });
  });

  it("normalizes casing to the conventional form", () => {
    expect(normalizeLanguageCode("ZH-hant-tw")).toBe("zh-Hant-TW");
    expect(normalizeLanguageCode("en_us")).toBe("en-US");
  });
});
