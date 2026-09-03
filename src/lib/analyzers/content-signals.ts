/**
 * The **Content Signals** an answer engine reads, detected in one place.
 *
 * ── Why this exists ──
 *
 * Four detectors — a stated figure, a question-phrased heading, a summary
 * section, listicle formatting — existed in three implementations. `geo-analyzer`
 * had the bilingual originals, `seo-content-analysis` had a line-for-line fork
 * with the Spanish alternatives dropped from all four, and `ai-visibility`'s L4
 * reached for `answer-patterns` for two of them.
 *
 * The fork is the argument. `geo-analyzer` documents this exact regression as
 * something it *fixed*: "dropping it would have quietly stopped counting 'más de
 * 80 millones' as a statistic on every Spanish page." The fork reintroduced it in
 * another file, where nothing pointed at the decision it was undoing, and the
 * Spanish assertions that would have caught it live only in
 * `geo-analyzer.test.ts`.
 *
 * ── What is deliberately not here ──
 *
 * Points, labels, sources and wording. A signal is a predicate: is this phrasing
 * present, and how often. What it is worth and how it is reported stay with the
 * scorer, because `geo-analyzer` and `seo_content_analysis` genuinely make
 * different claims about the same detection — one scores it, the other reports it
 * as a measurement — and folding those together would flatten two claims into
 * one.
 *
 * ── The language gap, kept visible ──
 *
 * The phrasings that vary by language come from `answer-patterns`, which returns
 * `unsupported` for a language it cannot read rather than silently failing a
 * correct page. Structure does not vary that way: an `<ol>` with three items is a
 * list in every language, so those detectors take no language at all.
 */
import type { ReadableDocument } from "../visible-text";
import { patternsFor } from "./answer-patterns";

/** How many list items or table rows make a page a listicle. */
const LISTICLE_MINIMUM = 3;

/**
 * The words a numbered heading uses, English and Spanish.
 *
 * Structural rather than in `answer-patterns` because the pattern is a *number
 * followed by a plural noun* — the shape carries the meaning, and the vocabulary
 * is a small closed set rather than the grammar of a definition. Kept together so
 * the two languages cannot drift apart, which is what happened when a fork copied
 * the English half.
 */
const LISTICLE_WORDS =
  "best|top|ways|tips|tools|reasons|steps|things|examples|ideas|" +
  "mejores|mejor|formas|maneras|consejos|herramientas|razones|pasos|cosas|ejemplos|trucos";

const NUMBERED_HEADING = new RegExp(
  `<h[1-6][^>]*>[^<]*(?:\\b\\d+\\s+(?:${LISTICLE_WORDS})\\b|top\\s+\\d+\\b|los\\s+\\d+\\s+mejores\\b)[^<]*</h[1-6]>`,
  "i",
);

/**
 * A question word, in either language, at the start of a heading.
 *
 * `¿` is allowed to lead: Spanish opens a question with it, and a heading that
 * does was being read as a statement.
 *
 * ── Why the boundary is a lookahead and not `\b` ──
 *
 * The ported regex ended in `\b`, and JavaScript's `\b` is ASCII: `\w` does not
 * include `é`, so there is no word boundary between the `é` of `qué` and the
 * space after it, and the alternative could never match. Every accented Spanish
 * question word in the list — `qué`, `cómo`, `por qué`, `cuándo`, `dónde`,
 * `quién`, `cuál`, `cuánto` — was therefore dead. `¿Cómo funciona?` still counted,
 * but only through the trailing `?`, so a Spanish heading phrased as a question
 * without one scored as a statement.
 *
 * `(?!\p{L})` with the `u` flag asks the question `\b` was meant to ask: is the
 * next character a letter in any script?
 */
const QUESTION_WORD =
  /^\s*¿?\s*(?:what|how|why|when|where|who|which|can|does|is|are|should|will|qué|que|cómo|como|por qué|por que|cuándo|cuando|dónde|donde|quién|quien|cuál|cual|cuánto|cuanto|cuántos|cuantos|puede|debería|deberia|es|son)(?!\p{L})/iu;

const ENDS_WITH_QUESTION = /\?\s*$/;

/**
 * The class or id a summary section is marked up with, in either language.
 *
 * Read from the markup rather than from the copy, because this is a signal about
 * how the page is *built*: `class="resumen"` is the author saying "this block is
 * the summary" in a way an answer engine can find.
 */
const SUMMARY_SECTION =
  /(?:class|id)=["'][^"']*(?:tldr|summary|takeaway|overview|resumen|claves|puntos-clave)[^"']*["']/i;

/**
 * A figure specific enough for an answer engine to quote.
 *
 * The union of what two merged checks detected. The `%`, `$`, `N out of M` and
 * `Nx` shapes cross the language line; the written magnitudes do not, which is
 * why `million|billion|thousand` sits beside `millones|millón|millon|mil` and
 * `N de cada M` beside `N out of M`. Dropping either half is the regression this
 * module exists to make impossible.
 */
const STATISTIC =
  /(\d+\.?\d*\s*%|\$\d[\d,]*|\d+\s+out\s+of\s+\d+|\d+\s+de\s+cada\s+\d+|\d+x\s|\b\d+(?:[.,]\d+)?\s*(?:million|billion|thousand|millones|millón|millon|mil|k\b))/gi;

/** How many quotable figures the copy states. */
export function countStatistics(text: string): number {
  // A fresh matcher per call: `STATISTIC` carries `g`, and a shared `RegExp` with
  // `g` keeps `lastIndex` between calls, so the second caller starts mid-string.
  return (text.match(new RegExp(STATISTIC.source, "gi")) ?? []).length;
}

/** Whether the copy states any quotable figure at all. */
export function statesAStatistic(text: string): boolean {
  return countStatistics(text) > 0;
}

/**
 * How many of the page's H2s and H3s are phrased as questions.
 *
 * Counts headings rather than reporting a boolean, because both callers want the
 * figure: one scores "at least one", the other reports how many.
 */
export function countQuestionHeadings(readable: ReadableDocument): number {
  return readable
    .textsInContent("h2, h3")
    .filter((heading) => QUESTION_WORD.test(heading) || ENDS_WITH_QUESTION.test(heading))
    .length;
}

/** Whether the page marks up a summary or TL;DR block. */
export function hasSummarySection(html: string): boolean {
  return SUMMARY_SECTION.test(html);
}

/** Which of the three listicle shapes the page has, if any. */
export interface ListicleShape {
  numberedHeading: boolean;
  orderedList: boolean;
  comparisonTable: boolean;
}

/** Whether any of the three shapes is present. */
export function isListicle(shape: ListicleShape): boolean {
  return shape.numberedHeading || shape.orderedList || shape.comparisonTable;
}

/**
 * How the page is laid out, as far as "is this a list?" goes.
 *
 * Reads the markup: an `<ol>` and a `<table>` are structure, not copy, and the
 * item and row counts are what tell a genuine sequence from a two-item nav.
 */
export function listicleShape(html: string): ListicleShape {
  const countInside = (container: RegExp, item: RegExp): boolean => {
    let match: RegExpExecArray | null;
    const scan = new RegExp(container.source, "gi");
    while ((match = scan.exec(html)) !== null) {
      if ((match[1].match(item) ?? []).length >= LISTICLE_MINIMUM) return true;
    }
    return false;
  };

  return {
    numberedHeading: NUMBERED_HEADING.test(html),
    orderedList: countInside(/<ol[^>]*>([\s\S]*?)<\/ol>/, /<li[^>]*>/gi),
    comparisonTable: countInside(/<table[^>]*>([\s\S]*?)<\/table>/, /<tr[^>]*>/gi),
  };
}

/**
 * Whether the copy defines something, in the language it is written in.
 *
 * Goes through `answer-patterns` rather than carrying its own bilingual regex, so
 * a language we cannot read comes back as `unsupported` — the check goes
 * `not-evaluated` and the reader is told we cannot read definitions in their
 * language yet, instead of being told their page has none. `geo-analyzer` had a
 * hardcoded EN+ES regex here and so silently failed German exactly the way
 * `answer-patterns.ts` says it exists to prevent.
 *
 * @param language the page's declared base language, or `null`.
 */
export function definesSomething(
  text: string,
  language: string | null,
): { outcome: "answered"; defines: boolean } | { outcome: "unsupported"; languageName: string } {
  const choice = patternsFor(language);
  if (choice.outcome === "unsupported") {
    return { outcome: "unsupported", languageName: choice.languageName };
  }
  return { outcome: "answered", defines: choice.patterns.definition.test(text) };
}
