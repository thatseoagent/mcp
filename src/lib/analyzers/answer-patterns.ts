import { parseLanguageCode, getLanguageName } from "../language-validator";

/**
 * The phrasings a check looks for, per language.
 *
 * ── Why this exists ──
 *
 * Three checks worth 19 points were a single English regex, so a correct Spanish
 * page could not pass them (#342). A definition reads "X is a…" or "X es un…"
 * depending on nothing but who wrote it, and a customer who writes in their own
 * language was told to add definitional sentences to a page full of them.
 *
 * This product sells in Spanish. There is no way to explain that score to the person
 * paying for it.
 *
 * ── Why a module rather than a longer regex ──
 *
 * Adding Spanish alternatives beside the English ones fixes Spanish and leaves German
 * exactly as broken, silently — which is the shape of the original bug, not a fix for
 * it. Naming the sets makes the gap visible: `patternsFor("de")` returns
 * `unsupported`, the check goes `not-evaluated`, and the reader is told we cannot
 * read definitions in their language yet instead of being told their page has none.
 *
 * ── What is deliberately not here ──
 *
 * Reading the page's language. That is `page-language.ts`, and it is separate because
 * a caller that already knows the language (from a stored audit, from a user setting)
 * should not have to hand this module an HTML document to get an answer.
 */

/**
 * The two phrasings the L4 checks are built on.
 *
 * `statistic` is here and not treated as language-neutral because it is not: the
 * English set matches `million`, `billion` and `thousand`, and a Spanish page writing
 * `2 millones` matched none of them. Only the `%` branch crossed the language line,
 * which is why the issue's own note that "a Spanish page can only pass through the
 * statistic half" was optimistic.
 */
export interface AnswerPatterns {
  /** Definitional phrasing: "X is a…", "X es un…". */
  definition: RegExp;
  /** A figure specific enough to be a claim. */
  statistic: RegExp;
}

/**
 * Sources rather than compiled regexes, so a union can be built from them.
 *
 * Every entry is a fragment meant to sit inside `\b(?:…)`, written without capture
 * groups — an alternation of sources is the only thing that makes the no-language
 * fallback honest instead of a third hand-maintained pattern.
 */
const SETS: Record<string, { definition: string; statistic: string }> = {
  en: {
    definition: "is\\s+(?:a|an|the)\\s+\\w|refers\\s+to\\s+|means\\s+|defined\\s+as\\s+|helps\\s+(?:you|businesses|teams)",
    statistic: "\\d+(?:[.,]\\d+)?(?:\\s*%|\\s*million|\\s*billion|\\s*thousand|\\s*k\\b)",
  },
  es: {
    // `es un`, `es una`, `es el`, `es la`, `son los`… plus the phrasings a Spanish
    // page actually uses to define: "se refiere a", "significa", "se define como",
    // "consiste en", "te ayuda a", "ayuda a las empresas".
    definition:
      "es\\s+(?:un|una|el|la|lo)\\s+\\w|son\\s+(?:los|las|unos|unas)\\s+\\w|" +
      "se\\s+refiere\\s+a\\s+|significa\\s+|se\\s+define\\s+como\\s+|consiste\\s+en\\s+|" +
      "ayuda\\s+a\\s+(?:las?\\s+)?(?:empresas|equipos|personas)|te\\s+ayuda\\s+a\\s+",
    // `millón`/`millones`, `mil`/`miles`, written with or without the accent, which
    // real pages do both of.
    statistic:
      "\\d+(?:[.,]\\d+)?(?:\\s*%|\\s*mill(?:[oó]n|ones)|\\s*mil(?:es)?\\b|\\s*k\\b)",
  },
};

/** The languages this module can read a definition in. */
export const SUPPORTED_LANGUAGES = Object.keys(SETS);

const compile = (definition: string, statistic: string): AnswerPatterns => ({
  definition: new RegExp(`\\b(?:${definition})`, "i"),
  statistic: new RegExp(`\\b(?:${statistic})`, "i"),
});

/**
 * Which patterns to test against a page, and whether we have any.
 *
 * `everyLanguage` rather than `unsupported` when the page declares no language, and
 * that is a deliberate asymmetry. `html[lang]` is missing on a great many real pages
 * — the repo already reports it separately, as the `lang-missing` rule — so treating
 * its absence as "not scorable" would empty the score of half the web over an
 * attribute we are already flagging elsewhere. Testing every set we have is generous
 * in a case that costs a few points to get wrong, against the alternative, which is
 * taking points from everyone who did not set an attribute.
 *
 * It is also safe in practice: the English fragments need `is a|an|the`, `refers to`,
 * `means`, `defined as` or `helps you`, and none of those occurs in Spanish prose.
 */
export type PatternChoice =
  | { outcome: "language"; language: string; patterns: AnswerPatterns }
  | { outcome: "everyLanguage"; patterns: AnswerPatterns }
  | { outcome: "unsupported"; language: string; languageName: string };

export function patternsFor(language: string | null): PatternChoice {
  if (!language) {
    return {
      outcome: "everyLanguage",
      patterns: compile(
        Object.values(SETS).map((s) => s.definition).join("|"),
        Object.values(SETS).map((s) => s.statistic).join("|"),
      ),
    };
  }

  // `es-419`, `en-GB` and `pt_BR` all reduce to a language we either have or do not.
  const base = parseLanguageCode(language)?.language ?? language.toLowerCase();
  const set = SETS[base];
  if (!set) {
    return { outcome: "unsupported", language: base, languageName: getLanguageName(base) };
  }
  return { outcome: "language", language: base, patterns: compile(set.definition, set.statistic) };
}
