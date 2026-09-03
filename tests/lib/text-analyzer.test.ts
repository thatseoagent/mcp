import { describe, it, expect } from "vitest";
import {
  countSyllables,
  countWords,
  analyzeText,
  calculateFleschReadingEase,
  calculateFleschKincaidGrade,
  interpretFleschScore,
  calculateLexicalDensity,
} from "@/lib/text-analyzer";

// ── countSyllables ────────────────────────────────────────────────────────

describe("countSyllables", () => {
  it("returns 1 for words of 3 chars or fewer", () => {
    expect(countSyllables("the")).toBe(1);
    expect(countSyllables("it")).toBe(1);
    expect(countSyllables("a")).toBe(1);
  });

  it("returns at least 1 for any non-empty word", () => {
    expect(countSyllables("rhythm")).toBeGreaterThanOrEqual(1);
  });

  it("counts multi-syllable words reasonably", () => {
    // "beautiful" → beau-ti-ful = 3
    expect(countSyllables("beautiful")).toBeGreaterThanOrEqual(2);
    // "education" → ed-u-ca-tion = 4
    expect(countSyllables("education")).toBeGreaterThanOrEqual(3);
  });

  it("returns 0 for an empty string", () => {
    expect(countSyllables("")).toBe(0);
  });
});

// ── countWords ────────────────────────────────────────────────────────────

describe("countWords", () => {
  it("counts whitespace-separated tokens", () => {
    expect(countWords("one two three")).toBe(3);
  });

  it("collapses runs of whitespace and ignores leading/trailing space", () => {
    expect(countWords("  one \n\n  two   three  ")).toBe(3);
  });

  it("returns 0 for an empty or whitespace-only string", () => {
    expect(countWords("")).toBe(0);
    expect(countWords("   \n  ")).toBe(0);
  });

  it("does not count punctuation-only tokens as words", () => {
    expect(countWords("one · two — three")).toBe(3);
  });

  it("counts words in non-Latin scripts", () => {
    // A Cyrillic page used to score zero words, which read as thin content.
    expect(countWords("привет мир")).toBe(2);
    expect(countWords("γεια σου κόσμε")).toBe(3);
  });

  it("agrees with analyzeText, which shares the same splitter", () => {
    const text = "The quick brown fox jumps over the lazy dog.";
    expect(countWords(text)).toBe(analyzeText(text).wordCount);
  });
});

// ── analyzeText ───────────────────────────────────────────────────────────

describe("analyzeText", () => {
  it("returns zeroed result for empty string", () => {
    const r = analyzeText("");
    expect(r.wordCount).toBe(0);
    expect(r.sentenceCount).toBe(0);
    expect(r.syllableCount).toBe(0);
    expect(r.avgWordsPerSentence).toBe(0);
    expect(r.avgSyllablesPerWord).toBe(0);
  });

  it("counts words correctly", () => {
    const r = analyzeText("Hello world. How are you?");
    expect(r.wordCount).toBe(5);
  });

  it("counts sentences using . ! ? delimiters", () => {
    const r = analyzeText("Hello world. How are you? Great!");
    expect(r.sentenceCount).toBe(3);
  });

  it("counts paragraphs by double newlines", () => {
    const r = analyzeText("Para one.\n\nPara two.");
    expect(r.paragraphCount).toBe(2);
  });

  it("calculates avgWordsPerSentence", () => {
    const r = analyzeText("One two three. Four five.");
    expect(r.avgWordsPerSentence).toBeCloseTo(2.5, 1);
  });

  it("calculates syllableCount > 0 for normal text", () => {
    const r = analyzeText("The quick brown fox jumps over the lazy dog.");
    expect(r.syllableCount).toBeGreaterThan(0);
  });
});

// ── calculateFleschReadingEase ────────────────────────────────────────────

describe("calculateFleschReadingEase", () => {
  it("returns 0 for empty text", () => {
    expect(calculateFleschReadingEase("")).toBe(0);
  });

  it("returns a score between 0 and 100 for normal text", () => {
    const score = calculateFleschReadingEase(
      "The cat sat on the mat. It was a fat cat."
    );
    expect(score).toBeGreaterThanOrEqual(0);
    expect(score).toBeLessThanOrEqual(100);
  });

  it("simple text scores higher than complex text", () => {
    const simple = "The dog ran fast. The cat sat down.";
    const complex =
      "The philosophical implications of existentialist phenomenological consciousness transcend conventional understanding.";
    expect(calculateFleschReadingEase(simple)).toBeGreaterThan(
      calculateFleschReadingEase(complex)
    );
  });
});

// ── calculateFleschKincaidGrade ───────────────────────────────────────────

describe("calculateFleschKincaidGrade", () => {
  it("returns 0 for empty text", () => {
    expect(calculateFleschKincaidGrade("")).toBe(0);
  });

  it("returns a non-negative grade for normal text", () => {
    const grade = calculateFleschKincaidGrade(
      "The cat sat on the mat. It was a fat cat."
    );
    expect(grade).toBeGreaterThanOrEqual(0);
  });

  it("complex text has higher grade than simple text", () => {
    const simple = "The dog ran fast. Go now.";
    const complex =
      "The philosophical implications of existentialist phenomenological consciousness transcend conventional understanding.";
    expect(calculateFleschKincaidGrade(complex)).toBeGreaterThan(
      calculateFleschKincaidGrade(simple)
    );
  });
});

// ── interpretFleschScore ──────────────────────────────────────────────────

describe("interpretFleschScore", () => {
  it("labels scores correctly by range", () => {
    expect(interpretFleschScore(95)).toContain("Very Easy");
    expect(interpretFleschScore(85)).toContain("Easy");
    expect(interpretFleschScore(75)).toContain("Fairly Easy");
    expect(interpretFleschScore(65)).toContain("Standard");
    expect(interpretFleschScore(55)).toContain("Fairly Difficult");
    expect(interpretFleschScore(40)).toContain("Difficult");
    expect(interpretFleschScore(20)).toContain("Very Confusing");
  });
});

// ── calculateLexicalDensity ───────────────────────────────────────────────

describe("calculateLexicalDensity", () => {
  it("returns 0 for empty text", () => {
    expect(calculateLexicalDensity("")).toBe(0);
  });

  it("returns 1.0 for text where every word is unique", () => {
    expect(calculateLexicalDensity("alpha beta gamma delta")).toBe(1);
  });

  it("returns a value less than 1.0 when words repeat", () => {
    const density = calculateLexicalDensity("the cat the cat the cat");
    expect(density).toBeLessThan(1);
    expect(density).toBeGreaterThan(0);
  });

  it("is case-insensitive (The = the)", () => {
    const mixed = calculateLexicalDensity("The the THE");
    expect(mixed).toBeCloseTo(1 / 3, 2);
  });
});
