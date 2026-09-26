/**
 * Does a page's title say the words its queries are made of?
 *
 * ── Why tokens and not substrings ──
 *
 * "seo audit tool" and a title reading "Free SEO Tool for Site Audits" are the
 * same intent, and `title.includes(query)` calls it a miss. Searchers reorder,
 * drop articles and pluralise; titles are written for people. So a query is
 * reduced to its *significant* words — case folded, diacritics stripped,
 * stopwords removed — and a title covers the query when it carries each of them.
 *
 * Diacritics matter more than they look. Spanish searchers routinely type
 * "diseno web" for "diseño web", and Search Console reports the query as typed,
 * so a strict comparison would tell a correct Spanish title it misses its own
 * query.
 *
 * ── Languages, and saying so when we cannot read one ──
 *
 * Stopwords are per language, and this has two: English and Spanish, the two
 * `answer-patterns.ts` reads, for the same reason it gives — naming the sets
 * makes the gap visible. A page that declares another language gets
 * `unsupported`, and the Tool says the comparison was not made rather than
 * running it with the wrong stopwords, which would count "der" and "und" as
 * words a German title had to carry. A page that declares no language gets
 * every set we have, as `answer-patterns.ts` does and for its reason: a missing
 * `lang` is common, and the English and Spanish stopword lists do not collide on
 * anything a title would need.
 *
 * ── What this is not ──
 *
 * A stemmer, or a measure of relevance. Plurals are matched by a light rule
 * (`tool`/`tools`, `audit`/`audits`, `país`/`países`) because that is the
 * commonest miss, and nothing further: "running" does not match "run". Every
 * reading built on this is ours, a prompt to look at a title, not a statement
 * about how Google matches a query to a page.
 */
import { parseLanguageCode, getLanguageName } from "./language-validator";

const STOPWORDS: Record<string, ReadonlySet<string>> = {
  en: new Set(
    (
      "a an the and or but of for to in on at by with from as is are was were be been it its " +
      "this that these those how what which who whom why when where do does can i you your my " +
      "me we our us vs versus near best top"
    ).split(" "),
  ),
  // Folded, like everything compared against them: "cómo" is stored as "como".
  es: new Set(
    (
      "el la los las un una unos unas y o u e de del al a en por para con sin sobre entre que " +
      "como cual cuales quien donde cuando es son ser esta este estos estas esto lo le les se su " +
      "sus mi mis tu tus mas muy mejor mejores vs cerca"
    ).split(" "),
  ),
};

/** The languages this module can tell significant words from filler in. */
export const SUPPORTED_TOKEN_LANGUAGES = Object.keys(STOPWORDS);

/** Lowercase, with accents and other combining marks removed. */
export function fold(text: string): string {
  return text.normalize("NFKD").replace(/\p{M}+/gu, "").toLowerCase();
}

/** Every word in a text, folded. Letters and digits in any script. */
export function words(text: string): string[] {
  return fold(text).split(/[^\p{L}\p{N}]+/u).filter((word) => word.length > 0);
}

export type Tokeniser =
  | { outcome: "language"; language: string; significant: (text: string) => string[] }
  | { outcome: "everyLanguage"; significant: (text: string) => string[] }
  | { outcome: "unsupported"; language: string; languageName: string };

function significantWith(stopwords: ReadonlySet<string>): (text: string) => string[] {
  return (text) => {
    const all = words(text);
    const kept = all.filter((word) => !stopwords.has(word));
    // A query made only of filler — "how to", "que es" — is still a query, and
    // throwing all of it away would make every title "cover" it by default.
    return kept.length > 0 ? kept : all;
  };
}

/** How to read words for a page in this language. See the module header. */
export function tokeniserFor(language: string | null): Tokeniser {
  if (!language) {
    const union = new Set(Object.values(STOPWORDS).flatMap((set) => [...set]));
    return { outcome: "everyLanguage", significant: significantWith(union) };
  }
  const base = parseLanguageCode(language)?.language ?? language.toLowerCase();
  const stopwords = STOPWORDS[base];
  if (!stopwords) return { outcome: "unsupported", language: base, languageName: getLanguageName(base) };
  return { outcome: "language", language: base, significant: significantWith(stopwords) };
}

/** One word and its plural, by the light rule in the module header. */
function sameWord(a: string, b: string): boolean {
  if (a === b) return true;
  const [short, long] = a.length <= b.length ? [a, b] : [b, a];
  if (short.length < 3) return false;
  return long === `${short}s` || long === `${short}es`;
}

export interface Coverage {
  /** The query's significant words that the text carries. */
  found: string[];
  /** The ones it does not. */
  missing: string[];
}

/** Which of these query words appear among these text words. */
export function coverage(queryWords: readonly string[], textWords: readonly string[]): Coverage {
  const unique = [...new Set(queryWords)];
  const found = unique.filter((word) => textWords.some((candidate) => sameWord(word, candidate)));
  return { found, missing: unique.filter((word) => !found.includes(word)) };
}
