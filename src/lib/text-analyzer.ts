/**
 * Text analysis utilities for readability scoring and content metrics.
 * Implements Flesch Reading Ease and Flesch-Kincaid Grade Level algorithms.
 */

export interface TextAnalysisResult {
  wordCount: number;
  sentenceCount: number;
  syllableCount: number;
  /**
   * Paragraphs as blank-line-separated blocks. Only meaningful for plain text
   * that still has its line breaks — text extracted from HTML has had its
   * whitespace collapsed, so this reads 1 for any page. Count paragraphs in a
   * document with `readableDocument($).paragraphs()` instead.
   */
  paragraphCount: number;
  avgWordsPerSentence: number;
  avgSyllablesPerWord: number;
}

/**
 * Count syllables in a word using the vowel-counting heuristic.
 * Not perfect but good enough for readability scoring.
 */
export function countSyllables(word: string): number {
  word = word.toLowerCase().trim();
  if (word.length === 0) return 0;
  if (word.length <= 3) return 1;

  // Remove trailing 'e' (silent e)
  word = word.replace(/(?:[^laeiouy]es|ed|[^laeiouy]e)$/, "");

  // Remove trailing 'y' (avoids double-counting 'y' already in vowel groups)
  word = word.replace(/y$/, "");

  // Count vowel groups
  const vowelGroups = word.match(/[aeiouy]{1,2}/g);
  const syllables = vowelGroups ? vowelGroups.length : 0;

  // Ensure at least 1 syllable
  return syllables || 1;
}

/**
 * Split text into words: whitespace-separated tokens that carry at least one
 * letter or digit, so a stray bullet or dash is not counted as a word.
 *
 * Any script counts, not just Latin — the filter used to be `[a-zA-Z0-9]`, which
 * scored a Cyrillic or Greek page as having no words at all.
 */
function splitWords(text: string): string[] {
  return text
    .replace(/\s+/g, " ")
    .trim()
    .split(/\s+/)
    .filter((word) => /[\p{L}\p{N}]/u.test(word));
}

/**
 * How many words a piece of text contains.
 *
 * Exported so every caller reporting a word count agrees on what a word is. The
 * two page analyzers used to count differently as well as read differently, and
 * disagreed on the same URL (issue #291).
 */
export function countWords(text: string): number {
  return splitWords(text).length;
}

/**
 * Analyze text and return comprehensive metrics.
 * Splits text into sentences, words, and counts syllables.
 */
export function analyzeText(text: string): TextAnalysisResult {
  // Clean and normalize whitespace
  const cleanText = text.replace(/\s+/g, " ").trim();

  if (!cleanText) {
    return {
      wordCount: 0,
      sentenceCount: 0,
      syllableCount: 0,
      paragraphCount: 0,
      avgWordsPerSentence: 0,
      avgSyllablesPerWord: 0,
    };
  }

  // Count paragraphs (double line breaks or <p> tags assumed separated)
  const paragraphCount = Math.max(
    1,
    text.split(/\n\s*\n/).filter((p) => p.trim()).length
  );

  // Split into sentences (approximation using punctuation)
  const sentences = cleanText
    .split(/[.!?]+/)
    .filter((s) => s.trim().length > 0);
  const sentenceCount = sentences.length || 1;

  // Split into words (alphanumeric sequences)
  const words = splitWords(cleanText);
  const wordCount = words.length;

  // Count total syllables
  const syllableCount = words.reduce(
    (sum, word) => sum + countSyllables(word),
    0
  );

  const avgWordsPerSentence =
    sentenceCount > 0 ? wordCount / sentenceCount : 0;
  const avgSyllablesPerWord = wordCount > 0 ? syllableCount / wordCount : 0;

  return {
    wordCount,
    sentenceCount,
    syllableCount,
    paragraphCount,
    avgWordsPerSentence,
    avgSyllablesPerWord,
  };
}

/**
 * Calculate Flesch Reading Ease score (0-100).
 * Higher score = easier to read.
 *
 * Formula: 206.835 - 1.015(total words / total sentences) - 84.6(total syllables / total words)
 *
 * Score interpretation:
 * 90-100: Very easy (5th grade)
 * 80-89: Easy (6th grade)
 * 70-79: Fairly easy (7th grade)
 * 60-69: Standard (8th-9th grade)
 * 50-59: Fairly difficult (10th-12th grade)
 * 30-49: Difficult (college)
 * 0-29: Very confusing (college graduate)
 */
export function calculateFleschReadingEase(text: string): number {
  const analysis = analyzeText(text);

  if (analysis.wordCount === 0 || analysis.sentenceCount === 0) {
    return 0;
  }

  const score =
    206.835 -
    1.015 * analysis.avgWordsPerSentence -
    84.6 * analysis.avgSyllablesPerWord;

  // Clamp to 0-100 range
  return Math.max(0, Math.min(100, Math.round(score * 10) / 10));
}

/**
 * Calculate Flesch-Kincaid Grade Level.
 * Returns US grade level required to understand the text.
 *
 * Formula: 0.39(total words / total sentences) + 11.8(total syllables / total words) - 15.59
 */
export function calculateFleschKincaidGrade(text: string): number {
  const analysis = analyzeText(text);

  if (analysis.wordCount === 0 || analysis.sentenceCount === 0) {
    return 0;
  }

  const grade =
    0.39 * analysis.avgWordsPerSentence +
    11.8 * analysis.avgSyllablesPerWord -
    15.59;

  // Round to 1 decimal place
  return Math.max(0, Math.round(grade * 10) / 10);
}

/**
 * Interpret Flesch Reading Ease score as a human-readable description.
 */
export function interpretFleschScore(score: number): string {
  if (score >= 90) return "Very Easy (5th grade)";
  if (score >= 80) return "Easy (6th grade)";
  if (score >= 70) return "Fairly Easy (7th grade)";
  if (score >= 60) return "Standard (8th-9th grade)";
  if (score >= 50) return "Fairly Difficult (10th-12th grade)";
  if (score >= 30) return "Difficult (College)";
  return "Very Confusing (College Graduate)";
}

/**
 * Calculate lexical density (unique words / total words).
 * Higher density = more varied vocabulary.
 */
export function calculateLexicalDensity(text: string): number {
  // Same splitter as the word count, so `uniqueWords` and `wordCount` cannot
  // describe different sets of words for the same page.
  const words = splitWords(text.toLowerCase());

  if (words.length === 0) return 0;

  const uniqueWords = new Set(words);
  return Math.round((uniqueWords.size / words.length) * 1000) / 1000; // 3 decimal places
}
