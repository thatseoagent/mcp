/**
 * E-E-A-T (Experience, Expertise, Authoritativeness, Trustworthiness) analyzer.
 * Analyzes content quality signals based on Google's Quality Rater Guidelines.
 */

import type { CheerioAPI } from "cheerio";
import { tally, notScored, type Scorable, type ScoreStatus } from "./scored-checks";
import type { ReadableDocument } from "../visible-text";
import { countWords } from "../text-analyzer";
import { escapeRegExp } from "../escape-regexp";
import { isUnauthoredPage, isUndatedPage, type PageKind } from "./page-identity";
import type { ParsedPage } from "./parsed-page";
import { findPageAuthor, type PageAuthor } from "./json-ld-graph";
import type { TrustPageFinding, TrustPageKind } from "../site-trust-pages";

/**
 * The signal names that something outside this file matches on.
 *
 * An indicator's `signal` is persisted verbatim as `EeatCheck.name`, so it is a
 * de-facto key the moment a second module looks one up — the same trap
 * `geo-analyzer`'s `LABEL` was extracted to close. Only the names with an
 * outside reader are listed: a table that claims to be exhaustive and is not is
 * worse than a short one that says what it covers.
 *
 * `report-findings` reads `authorBio` to decide whether to raise an authorship
 * finding, and at what severity given the page's Content Age.
 */
export const EEAT_SIGNAL = {
  authorBio: "Author bio / credentials",
} as const;

/**
  * Extends `Scorable` so an indicator can say it does not apply to this page, which
  * before #337 it could not: `status` was a compile error here, so an author
  * indicator on a page type that legitimately has no author had no outcome available
  * but a 0. See #340 for the four indicators that ask a site-level question.
  */
/**
 * Join a list the way a sentence does.
 *
 * `["statistics", "numbers", "dates"]` → `"statistics, numbers and dates"`.
 */
/**
 * `conjunction` is not decoration. English negates a list with "or", not "and":
 * "no code samples and captioned figures" reads as though the pair together were
 * missing and each one separately might not be. "No code samples or captioned
 * figures" says what is true.
 */
function sentenceList(items: readonly string[], conjunction: "and" | "or"): string {
  if (items.length <= 1) return items[0] ?? "";
  return `${items.slice(0, -1).join(", ")} ${conjunction} ${items[items.length - 1]}`;
}

/**
 * A partial-credit indicator's detail, as a sentence instead of a debug dump.
 *
 * These four indicators award points per sub-signal, so the reader needs to know
 * which sub-signal is missing — that is genuinely useful and was genuinely being
 * reported. It was being reported as `Statistics: false, Numbers: true, Dates:
 * true`, which is the shape of a console.log: a client reading their own audit
 * met three raw JavaScript booleans and had to work out that `false` was the bad
 * one. The same row appeared as `Footnotes: false, Bibliography: false, External
 * links: 23` and `Testimonials: true, Ratings: false`.
 *
 * Present first, because the reader is looking at a score and wants to know what
 * earned it; missing second, because that is the part they can act on.
 */
function presentAndMissing(parts: ReadonlyArray<{ label: string; present: boolean }>): string {
  const has = parts.filter((p) => p.present).map((p) => p.label);
  const lacks = parts.filter((p) => !p.present).map((p) => p.label);
  if (lacks.length === 0) return `Has ${sentenceList(has, "and")}`;
  if (has.length === 0) return `No ${sentenceList(lacks, "or")}`;
  return `Has ${sentenceList(has, "and")}; no ${sentenceList(lacks, "or")}`;
}

export interface EeatIndicator extends Scorable {
  signal: string;
  found: boolean;
  details?: string;
  /**
   * What the indicator is WORTH.
   *
   * It used to hold what the page *earned*, which is the opposite of what the
   * same field name means in `GeoCheck` and `AiVisibilityCheck` — so a failed
   * indicator rendered as "(0 pts)", reading as a check worth nothing rather
   * than a check that scored nothing.
   */
  points: number;
  /** Points this page actually earned. Every indicator here awards partial credit. */
  earned: number;
}

/**
 * One category's arithmetic, coverage included.
 *
 * `notApplicable`/`notEvaluated` are here because `tally` produces them and this
 * shape used to destructure `{ score, max }` and throw them away — so three
 * trustworthiness indicators worth 15 points could leave the fraction and the
 * report would show a score out of 85 with nothing saying why.
 */
export interface EeatCategoryScore {
  score: number;
  maxScore: number;
  /** Points belonging to indicators that do not apply to this page. */
  notApplicable: number;
  /** Points belonging to indicators that could not be evaluated on this run. */
  notEvaluated: number;
  indicators: EeatIndicator[];
}

export interface EeatAnalysisResult {
  url: string;
  score: number;
  maxScore: number;
  /** Points belonging to indicators that do not apply to this page. */
  notApplicable: number;
  /** Points belonging to indicators that could not be evaluated on this run. */
  notEvaluated: number;
  percentage: number;
  grade: "Excellent" | "Good" | "Fair" | "Poor";
  signals: {
    experience: EeatCategoryScore;
    expertise: EeatCategoryScore;
    authoritativeness: EeatCategoryScore;
    trustworthiness: EeatCategoryScore;
  };
  recommendations: string[];
}

/**
 * Analyze E-E-A-T quality signals for a webpage.
 * Returns Result type for explicit error handling.
 */
/**
 * Everything this module needs, all of it already in hand.
 *
 * `url` travels as data rather than as something to go and fetch: `isHttps` and
 * `identifyPage` both need it, and neither is I/O.
 */
export interface EeatInput {
  /**
   * The document, read once.
   *
   * Was `url` plus `html`, so this function parsed, and `identifyPage` parsed
   * again, and the handler had parsed a third time to read the trust-page links
   * — three parses of one document in one run. See `parsed-page.ts`.
   */
  page: ParsedPage;
  /**
   * Whether the SITE publishes a privacy policy, an about page and contact
   * details, resolved by the caller.
   *
   * This is the fetch that used to live inside here. Three indicators ask a
   * question about the site and #340 gave them a module that answers it — but
   * the call stayed in the analyzer, so this file did network I/O twice while
   * `CONTEXT.md` defines an **Analyzer** as "pure, stateless … no network calls,
   * directly unit-testable". `ai-visibility-tools` resolves the same thing on the
   * other side of the seam, so one question was being answered in two different
   * layers.
   *
   * The cost was already visible in the tests: `eeat-page-identity.test.ts` had
   * to start serving a `BARE_HOME` so its arithmetic would go back to being about
   * page identity. When a test has to stand up a network to measure something
   * that is not the network, the interface is in the wrong place.
   */
  trustPages: Record<TrustPageKind, TrustPageFinding>;
}

/**
 * Score a page that has already been read.
 *
 * Pure. No `Result` wrapper either: the only thing that could fail was the
 * fetch, and the fetch is the caller's now.
 */
export function scoreEeat({ page, trustPages }: EeatInput): EeatAnalysisResult {
  const { url, $, schemas, readable } = page;

  const parsedUrl = new URL(url);
  const isHttps = parsedUrl.protocol === "https:";

  // One Page Identity for the whole analysis, derived the way `geo-analyzer` derives
  // it. This module used to know nothing about page type, which meant its two largest
  // indicators — author bio at 10 points and author published elsewhere at 8 — had no
  // outcome available on a page that legitimately has no author but a zero. The
  // predicates were already in the repo, one file away, and `geo-analyzer` already
  // used them on the same signals; they were simply never called here (#337).
  //
  // Google states the expectation conditionally, which is the whole argument: the
  // self-assessment asks whether pages carry "a byline, where one might be expected".
  // No Google page says a product, category, home or legal page should carry one.
  // Parsed once for the whole analysis. This file used to keep a second, private
  // JSON-LD parser beside this call that kept a top-level array as one opaque object,
  // so an `AboutPage` shipped inside `[ … ]` — the shape a `@graph`-less site emits —
  // went undetected. `extractJsonLd` flattens it, and one parser cannot disagree with
  // itself.
  const pageKind = page.identity.kind;

  // Every signal about what the page *says* is matched against the words a
  // reader sees. What a site is built with is not our business, and matching raw
  // HTML made it our business: a class attribute containing "before" passed the
  // before/after check, `width:100%` passed the statistics check, and a
  // `datePublished` field inside JSON-LD reported a "visible" update date on a
  // page showing none. Signals about page *structure* — schema, link targets,
  // `<code>` — still read `$`.
  const content = readable.mainContent();
  const text: PageText = {
    content,
    all: readable.allText(),
    wordCount: countWords(content),
  };

  const experience = analyzeExperience($, text, readable);
  // Resolved once: both the author-bio indicator and the published-elsewhere one ask
  // about the same person, and both used to settle it from any `Person` the page
  // happened to carry (#341).
  const pageAuthor = findPageAuthor(schemas);

  const expertise = analyzeExpertise($, text, pageKind, readable, pageAuthor);
  const authoritativeness = analyzeAuthoritativeness($, text, pageKind, readable, pageAuthor);
  const trustworthiness = analyzeTrustworthiness($, text, isHttps, pageKind, trustPages);

  // One walk of one list, which is what `scored-checks.ts` means by "the only way
  // to get a total". This was two hand-written four-term sums over the categories'
  // own totals — arithmetic that happens to be associative, so it agreed, but it
  // agreed only about the two fields it added up. The coverage was not in either
  // sum and so never reached the report at all.
  const { score, max: maxScore, notApplicable, notEvaluated } = tally([
    ...experience.indicators,
    ...expertise.indicators,
    ...authoritativeness.indicators,
    ...trustworthiness.indicators,
  ]);

  const percentage = maxScore > 0 ? (score / maxScore) * 100 : 0;
  const grade = calculateGrade(percentage);

  // Generate recommendations
  const recommendations = generateRecommendations({
    experience,
    expertise,
    authoritativeness,
    trustworthiness,
    isHttps,
  });

  return {
    url,
    score,
    maxScore,
    notApplicable,
    notEvaluated,
    percentage,
    grade,
    signals: {
      experience,
      expertise,
      authoritativeness,
      trustworthiness,
    },
    recommendations,
  };
}

/** Phrases that introduce an author bio, in both languages the product ships. */
const AUTHOR_BIO_PHRASES = [
  "about the author", "written by", "author bio",
  "sobre el autor", "sobre la autora", "acerca del autor", "escrito por",
] as const;

/**
 * The page's words, split by where they live.
 *
 * A signal about what the page *says* has to read `content`: `all` includes the
 * nav and footer every page on the site shares, and reading those meant
 * "Contact us" scored first-person narrative and a "© 2026" footer scored the
 * page's own statistics. Only a signal that legitimately lives in the chrome —
 * a "Last updated" line, a phone number — reads `all`.
 */
interface PageText {
  /** The page's own copy. */
  content: string;
  /** Everything visible, chrome included. */
  all: string;
  /** How many words the copy contains. */
  wordCount: number;
}

/**
 * Does `text` mention `phrase` as a whole word (or whole phrase)?
 *
 * Substring matching is what made "markdown" count as a medical degree and
 * "colour" as first-person "our". Anchored on both sides, so only a real
 * mention counts.
 */
function mentions(text: string, phrase: string): boolean {
  const escaped = escapeRegExp(phrase);
  // `_` counts as a boundary character in `\w`, which would let `md_ref` match
  // the degree "md". Anchored on letters, digits and underscore explicitly.
  const boundary = "[\\p{L}\\p{N}_]";
  return new RegExp(`(?<!${boundary})${escaped}(?!${boundary})`, "iu").test(text);
}

function mentionsAny(text: string, phrases: readonly string[]): boolean {
  return phrases.some((phrase) => mentions(text, phrase));
}

/**
 * Analyze Experience signals (25 points).
 */
function analyzeExperience($: CheerioAPI, text: PageText, readable: ReadableDocument): EeatCategoryScore {
  const indicators: EeatIndicator[] = [];

  // First-person narrative (5 points)
  // English and Spanish, because the product is bilingual and matching English
  // only scored a correct Spanish page as if it had no narrative at all — the
  // same false negative lib/utils/localized-page-detection.ts exists to fix.
  // "I" is handled separately below: as a keyword it also matches the roman
  // numeral in "Capítulo I" and the list marker in "Fase i".
  const firstPersonWords = [
    "me", "my", "mine", "we", "us", "our", "ours",
    "yo", "mi", "mis", "mí", "conmigo", "nosotros", "nosotras", "nos",
    "nuestro", "nuestra", "nuestros", "nuestras",
  ];
  // The English pronoun: a capital I followed by a lowercase word, which is how
  // it reads in a sentence ("I migrated…") and not how a numeral does ("Fase I:").
  const hasEnglishI = /(?<![\p{L}\p{N}_])I\s+\p{Ll}/u.test(text.content);
  const hasFirstPerson = hasEnglishI || mentionsAny(text.content, firstPersonWords);
  const earned_points1 = hasFirstPerson ? 5 : 0;
  indicators.push({
    signal: "First-person narrative",
    found: hasFirstPerson,
    details: hasFirstPerson
      ? "Content uses first-person perspective"
      : "No first-person perspective detected",
    points: 5,
    earned: earned_points1,
  });

  // Case studies / examples (7 points)
  const caseStudyKeywords = [
    "case study", "case studies", "example", "for instance", "in my experience",
    "caso de estudio", "caso práctico", "por ejemplo", "ejemplo",
    "en mi experiencia",
  ];
  const hasCaseStudies = mentionsAny(text.content, caseStudyKeywords);
  // Inside the copy, not anywhere in the document. A breadcrumb and a nav menu are
  // both `<ol>`, so this awarded 3 of 7 for "the page shows worked examples" to every
  // page on a site whose breadcrumb is marked up correctly (#341).
  const hasNumberedLists = readable.countInContent("ol") > 0;
  const earned_points2 = (hasCaseStudies ? 4 : 0) + (hasNumberedLists ? 3 : 0);
  indicators.push({
    signal: "Case studies / examples",
    found: hasCaseStudies || hasNumberedLists,
    details: hasCaseStudies
      ? "Case study keywords found"
      : hasNumberedLists
      ? "Numbered lists found"
      : "No case studies or examples detected",
    points: 7,
    earned: earned_points2,
  });

  // Before/after evidence — reported, not scored.
  //
  // This was 5 points for any two of `before, after, result, results, outcome,
  // antes, después, resultado, resultados` appearing in the copy, which "antes de
  // empezar, el resultado es claro" already wins. No better word list fixes it: the
  // claim is that the page SHOWS a before and an after, and no vocabulary proves
  // that. A page can document a transformation without one of those words, and use
  // all nine without documenting anything.
  //
  // Zero points rather than deletion, on the precedent `ai-visibility-analyzer` set
  // for llms.txt: a signal we cannot honestly measure is still worth naming, so the
  // reader knows we looked and knows why there is no number (#341).
  const beforeAfterKeywords = [
    "before", "after", "result", "results", "outcome",
    "antes", "después", "resultado", "resultados",
  ];
  const beforeAfterMentions = beforeAfterKeywords.filter((keyword) =>
    mentions(text.content, keyword)
  ).length;
  indicators.push({
    signal: "Before/after evidence (informational — not detectable from HTML)",
    found: true,
    details: beforeAfterMentions > 0
      ? `${beforeAfterMentions} before/after words in the copy. Not scored: the words do not show that the page documents a transformation, and their absence does not show that it does not`
      : "Not scored: whether a page shows a before and an after is not something HTML can be read for",
    points: 0,
    earned: 0,
  });

  // Specific details / numbers (8 points)
  // Each pattern needs a figure specific enough to be a claim. A bare single
  // digit is not: it matched `width:100%`, an element id, and a build hash back
  // when this read raw HTML, so all 8 points were free on every page.
  const hasStatistics = /\d+(?:[.,]\d+)?\s?%/.test(text.content);
  const hasNumbers =
    /(?<!\d)\d{2,}/.test(text.content) || /\d[.,]\d/.test(text.content);
  const hasDates = /(?<!\d)(?:19|20)\d{2}(?!\d)/.test(text.content);
  const earned_points4 =
    (hasStatistics ? 3 : 0) + (hasNumbers ? 3 : 0) + (hasDates ? 2 : 0);
  indicators.push({
    signal: "Specific details / statistics",
    found: hasStatistics || hasNumbers,
    details: presentAndMissing([
      { label: "statistics", present: hasStatistics },
      { label: "numbers", present: hasNumbers },
      { label: "dates", present: hasDates },
    ]),
    points: 8,
    earned: earned_points4,
  });

  const { score, max, notApplicable, notEvaluated } = tally(indicators);
  return { score, maxScore: max, notApplicable, notEvaluated, indicators };
}

/**
 * Analyze Expertise signals (25 points).
 */
function analyzeExpertise(
  $: CheerioAPI,
  text: PageText,
  pageKind: PageKind,
  readable: ReadableDocument,
  pageAuthor: PageAuthor | undefined
): EeatCategoryScore {
  const wordCount = text.wordCount;
  const indicators: EeatIndicator[] = [];
  // A page kind with no personal author to credit. `geo-analyzer` gates the same
  // signals on the same predicate; this module did not, so a product page was docked
  // 18 of its 100 points for lacking a byline it was never meant to have.
  const unauthored = isUnauthoredPage(pageKind);

  // Author bio with credentials (10 points)
  // The author of this page's main entity, resolved by the module that owns the
  // graph. This was `@type === "Person"` on any top-level node OR the presence of an
  // `author` key anywhere, so a `Person` describing the writer of a testimonial won
  // the full 10 points for a page carrying no author bio at all (#341).
  const hasAuthorSchema = pageAuthor !== undefined;
  const hasAuthorBio =
    $('[class*="author"]').length > 0 ||
    $('[class*="byline"]').length > 0 ||
    mentionsAny(text.content, AUTHOR_BIO_PHRASES);
  const earned_points1 = hasAuthorSchema ? 10 : hasAuthorBio ? 6 : 0;
  indicators.push({
    signal: EEAT_SIGNAL.authorBio,
    found: hasAuthorSchema || hasAuthorBio,
    status: unauthored ? "not-applicable" : undefined,
    details: unauthored
      ? `N/A for ${pageKind} pages: this kind of page has no personal author to credit`
      : hasAuthorSchema
      ? "Author schema found"
      : hasAuthorBio
      ? "Author bio section found"
      : "No author information detected",
    points: 10,
    earned: earned_points1,
  });

  // Professional certifications (5 points)
  const certKeywords = [
    "certified", "certification", "phd", "md", "mba", "degree", "licensed",
    "certificado", "certificada", "certificación", "licenciado", "licenciada",
    "licenciatura", "máster", "maestría", "doctorado", "titulado", "titulada",
  ];
  const hasCertifications = mentionsAny(text.content, certKeywords);
  const earned_points2 = hasCertifications ? 5 : 0;
  indicators.push({
    signal: "Professional certifications",
    found: hasCertifications,
    // Same predicate: a credential belongs to a person, so a page with no author to
    // credit has nobody whose certifications these would be.
    status: unauthored ? "not-applicable" : undefined,
    details: unauthored
      ? `N/A for ${pageKind} pages: a credential belongs to an author, and this page has none to credit`
      : hasCertifications
      ? "Certification keywords found"
      : "No certifications mentioned",
    points: 5,
    earned: earned_points2,
  });

  // Detailed technical content (6 points)
  // `wordCount` counts the words a reader sees. It used to tokenize raw HTML,
  // which read 49,410 against a 1,500 threshold, so this check passed
  // unconditionally.
  const hasCodeSnippets = readable.countInContent("code") > 0 || readable.countInContent("pre") > 0;
  // Was `$("svg").length > 0 || $("img").length > 5`, against the whole document, so
  // six nav logos and a social icon proved the page carries technical diagrams.
  //
  // The image branch is gone rather than scoped, because scoping does not rescue it:
  // a count of images is not evidence of technical depth at any threshold, and an
  // illustrated listicle would clear whatever number we picked. `<code>` and `<pre>`
  // above are evidence, which is why they keep their points and this asks for a
  // figure that captions itself instead (#341).
  const hasDiagrams = readable.countInContent("figure figcaption") > 0;
  const earned_points3 =
    (wordCount > 1500 ? 3 : 0) + (hasCodeSnippets ? 2 : 0) + (hasDiagrams ? 1 : 0);
  indicators.push({
    signal: "Detailed technical content",
    found: wordCount > 1000 || hasCodeSnippets,
    // Word count leads because it carries the most of the award (3 of 6) and is
    // the only part of this indicator that is a measurement rather than a yes/no.
    details: `${wordCount.toLocaleString("en-US")} words. ${presentAndMissing([
      { label: "code samples", present: hasCodeSnippets },
      { label: "captioned figures", present: hasDiagrams },
    ])}`,
    points: 6,
    earned: earned_points3,
  });

  // Industry terminology — reported, not scored.
  //
  // 4 points for more than ten words of twelve letters or more, as a proxy for
  // technical vocabulary. Spanish morphology produces those far more often than
  // English does, so the same page scored differently for reasons that have nothing
  // to do with its author's expertise (#342).
  //
  // A per-language threshold does not fix that, it makes the nonsense equitable: word
  // length is not evidence of technical vocabulary in any language. The defensible
  // version is a term list per vertical, which is a different product. Retired to 0
  // on the llms.txt precedent, like before/after evidence in #341 — named for the
  // reader, worth nothing to the score.
  const longWords = text.content.match(/(?<![\p{L}\p{N}])\p{L}{12,}(?![\p{L}\p{N}])/gu);
  indicators.push({
    signal: "Industry terminology (informational — word length is not expertise)",
    found: true,
    details: `${longWords?.length ?? 0} words of 12+ letters. Not scored: long words are commoner in some languages than others, so this measured the language and not the vocabulary`,
    points: 0,
    earned: 0,
  });

  const { score, max, notApplicable, notEvaluated } = tally(indicators);
  return { score, maxScore: max, notApplicable, notEvaluated, indicators };
}

/**
 * Analyze Authoritativeness signals (25 points).
 */
function analyzeAuthoritativeness(
  $: CheerioAPI,
  text: PageText,
  pageKind: PageKind,
  readable: ReadableDocument,
  pageAuthor: PageAuthor | undefined
): EeatCategoryScore {
  const indicators: EeatIndicator[] = [];
  const unauthored = isUnauthoredPage(pageKind);

  // Citations / references (10 points)
  const hasFootnotes =
    readable.countInContent('[class*="footnote"]') > 0 ||
    readable.countInContent('[class*="reference"]') > 0;
  const hasBibliography = mentionsAny(text.content, [
    "references", "bibliography", "sources",
    "referencias", "bibliografía", "fuentes",
  ]);
  // Links out of the page's own copy. Counted across the whole document, a footer of
  // social icons and a nav of partner logos cleared the threshold of five on every
  // page of the site, awarding 5 of 10 for "claims are sourced" (#341).
  const externalLinks = readable.countInContent('a[href^="http"]');
  const earned_points1 = hasFootnotes ? 10 : hasBibliography ? 7 : externalLinks > 5 ? 5 : 0;
  indicators.push({
    signal: "Citations / references",
    found: hasFootnotes || hasBibliography || externalLinks > 5,
    details: `${presentAndMissing([
      { label: "footnotes", present: hasFootnotes },
      { label: "bibliography", present: hasBibliography },
    ])}. ${externalLinks} outbound link${externalLinks === 1 ? "" : "s"} in the page copy`,
    points: 10,
    earned: earned_points1,
  });

  // Author published elsewhere (8 points)
  // The AUTHOR's `sameAs`, not the page's. The old reading accepted a top-level
  // `sameAs` too, which on almost every site is the Organization's — so a company's
  // own social profiles scored 8 points for "the author has published elsewhere"
  // (#341).
  const hasSameAs =
    pageAuthor?.form === "node" && Boolean(pageAuthor.node["sameAs"]);
  // In the copy, where a link to an author's profile belongs. Site-wide social icons
  // live in the footer, and counting them scored "the author has an off-site
  // footprint" on every page of the site, including pages with no author (#341).
  const hasSocialLinks =
    readable.countInContent('a[href*="linkedin"]') > 0 ||
    readable.countInContent('a[href*="twitter"]') > 0 ||
    readable.countInContent('a[href*="github"]') > 0;
  const earned_points2 = hasSameAs ? 8 : hasSocialLinks ? 5 : 0;
  indicators.push({
    signal: "Author published elsewhere",
    found: hasSameAs || hasSocialLinks,
    // The indicator asks about an author's off-site footprint, so on a page with no
    // author it had no honest outcome: 0 for a page that owes nothing, or — via the
    // social-links branch, which matches a site-wide footer — 5 points for "the
    // author has a footprint" on a page with no author at all (#341).
    status: unauthored ? "not-applicable" : undefined,
    details: unauthored
      ? `N/A for ${pageKind} pages: there is no author here whose other work could be counted`
      : hasSameAs
      ? "sameAs schema found"
      : hasSocialLinks
      ? "Social profile links found"
      : "No external author profiles",
    points: 8,
    earned: earned_points2,
  });

  // Social proof / testimonials (7 points)
  const hasTestimonials =
    $('[class*="testimonial"]').length > 0 ||
    $('[class*="review"]').length > 0 ||
    mentionsAny(text.content, [
      "testimonial", "testimonials", "testimonio", "testimonios", "reseña", "reseñas",
    ]);
  const hasRatings = $('[itemprop="rating"]').length > 0 ||
    /★/.test(text.content) ||
    /\d+(?:\.\d+)?\s*\/\s*5(?!\d)/.test(text.content);
  const earned_points3 = (hasTestimonials ? 4 : 0) + (hasRatings ? 3 : 0);
  indicators.push({
    signal: "Social proof / testimonials",
    found: hasTestimonials || hasRatings,
    details: presentAndMissing([
      { label: "testimonials", present: hasTestimonials },
      { label: "ratings", present: hasRatings },
    ]),
    points: 7,
    earned: earned_points3,
  });

  const { score, max, notApplicable, notEvaluated } = tally(indicators);
  return { score, maxScore: max, notApplicable, notEvaluated, indicators };
}

/**
 * What each site-level indicator says, in each of the four situations it can be in.
 *
 * Written out per kind rather than templated because the reader is being told what to
 * do about it, and "linked from the home but not from here" is a different piece of
 * advice from "nowhere on the site" — the first is a template problem, the second is
 * a missing page.
 *
 * ## Why there is no wording for the plainest case
 *
 * Found on this page has nothing to say. It read "Privacy policy link found" under a
 * label reading "Privacy policy", next to a green tick and a `+5` — three ways of
 * saying the same word. That was invisible while the report discarded details on
 * scored rows, and became visible the moment it stopped, alongside the four AI
 * crawler rows that had the same shape.
 *
 * The other two situations do carry information and keep their line, which is the
 * whole reason this is a table and not a template. There is nothing left to measure
 * once a policy is linked from the page you are looking at: the label is the finding.
 * Absent rather than a rephrasing, because a detail whose only job is to restate its
 * own label costs the reader a line and tells them nothing — and `eeat-tools` guards
 * on `if (indicator.details)`, so the MCP text output drops it too.
 */
const TRUST_PAGE_WORDS: Record<TrustPageKind, { onHome: string; absent: string }> = {
  privacy: {
    onHome: "Privacy policy linked from the site home, but not from this page",
    absent: "No privacy policy link, on this page or the site home",
  },
  about: {
    onHome: "About page linked from the site home, but not from this page",
    absent: "No about page link, on this page or the site home",
  },
  contact: {
    onHome: "Contact info published on the site home, but not reachable from this page",
    absent: "No contact information, on this page or the site home",
  },
};

/**
 * One indicator for a question about the site rather than about the page.
 *
 * Found on the home still earns the full 5: the claim is "this site publishes a
 * privacy policy", and it does. What changes is the detail line, because a reader
 * whose global chrome does not reach this template has something worth knowing and
 * nothing worth panicking about.
 *
 * `unknown` becomes `not-evaluated`, which takes the 5 points out of the denominator
 * instead of out of the score. A home that 5xx'd is not evidence about a privacy
 * policy, and charging for it is the bug #337 is named after.
 */
function siteIndicator(
  signal: string,
  kind: TrustPageKind,
  finding: TrustPageFinding
): EeatIndicator {
  const words = TRUST_PAGE_WORDS[kind];
  if (finding.answer === "unknown") {
    return {
      signal,
      found: false,
      status: "not-evaluated",
      details: notScored(finding.reason),
      points: 5,
      earned: 0,
    };
  }
  const present = finding.answer === "present";
  return {
    signal,
    found: present,
    // Undefined for "present, on this page": see the note on TRUST_PAGE_WORDS.
    details: present
      ? finding.where === "page"
        ? undefined
        : words.onHome
      : words.absent,
    points: 5,
    earned: present ? 5 : 0,
  };
}

/**
 * Analyze Trustworthiness signals (25 points).
 */
function analyzeTrustworthiness(
  $: CheerioAPI,
  text: PageText,
  isHttps: boolean,
  pageKind: PageKind,
  trustPages: Record<TrustPageKind, TrustPageFinding>
): EeatCategoryScore {
  const indicators: EeatIndicator[] = [];
  // Not `isUnauthoredPage`: a profile page has an author but is still not published
  // on a date, and the two predicates differ on exactly that case.
  const undated = isUndatedPage(pageKind);

  // HTTPS (5 points)
  const earned_points1 = isHttps ? 5 : 0;
  indicators.push({
    signal: "HTTPS encryption",
    found: isHttps,
    // No line for the pass. "Site uses HTTPS" under a label reading "HTTPS
    // encryption" is the label again; the failure is worth spelling out because
    // "insecure" is the consequence and the label does not carry it.
    details: isHttps ? undefined : "Site uses HTTP (insecure)",
    points: 5,
    earned: earned_points1,
  });

  // Privacy policy, About page, Contact information (5 points each).
  //
  // All three ask about the SITE, so all three are answered the same way and the
  // wording is written once rather than three times. See `site-trust-pages.ts`.
  indicators.push(siteIndicator("Privacy policy", "privacy", trustPages.privacy));
  indicators.push(siteIndicator("About page", "about", trustPages.about));
  indicators.push(siteIndicator("Contact information", "contact", trustPages.contact));

  // Last updated date (5 points)
  const hasDateModified = $('[itemprop="dateModified"]').length > 0 ||
    $('[class*="updated"]').length > 0 ||
    $('[class*="modified"]').length > 0;
  // Visible means visible: this matched `datePublished` inside a JSON-LD block,
  // so pages showing no date at all were credited with one.
  // Chrome, deliberately: "Last updated" is usually a footer line.
  const hasVisibleDate = mentionsAny(text.all, [
    "updated", "modified", "published",
    "actualizado", "actualizada", "modificado", "modificada", "publicado", "publicada",
  ]);
  const earned_points5 = hasDateModified ? 5 : hasVisibleDate ? 3 : 0;
  indicators.push({
    signal: "Last updated date",
    found: hasDateModified || hasVisibleDate,
    status: undated ? "not-applicable" : undefined,
    details: undated
      ? `N/A for ${pageKind} pages: this kind of page is not published on a date`
      : hasDateModified
      ? "dateModified schema found"
      : hasVisibleDate
      ? "Update timestamp visible"
      : "No update date visible",
    points: 5,
    earned: earned_points5,
  });

  const { score, max, notApplicable, notEvaluated } = tally(indicators);
  return { score, maxScore: max, notApplicable, notEvaluated, indicators };
}

/**
 * Calculate grade from percentage.
 */
function calculateGrade(
  percentage: number
): "Excellent" | "Good" | "Fair" | "Poor" {
  if (percentage >= 75) return "Excellent";
  if (percentage >= 60) return "Good";
  if (percentage >= 40) return "Fair";
  return "Poor";
}

/**
 * Generate recommendations based on scores.
 */
function generateRecommendations(data: {
  experience: EeatCategoryScore;
  expertise: EeatCategoryScore;
  authoritativeness: EeatCategoryScore;
  trustworthiness: EeatCategoryScore;
  isHttps: boolean;
}): string[] {
  const recommendations: string[] = [];

  // Experience
  if (data.experience.score < 15) {
    recommendations.push(
      "Experience: Add first-person narratives, case studies, and specific examples from real experience"
    );
  }

  // Expertise
  if (data.expertise.score < 15) {
    recommendations.push(
      "Expertise: Add author bio with credentials, certifications, and detailed technical content"
    );
  }

  // Authoritativeness
  if (data.authoritativeness.score < 15) {
    recommendations.push(
      "Authoritativeness: Add citations, references, and links to author's other published work"
    );
  }

  // Trustworthiness
  if (data.trustworthiness.score < 15) {
    recommendations.push(
      "Trustworthiness: Add privacy policy, about page, contact information, and last updated dates"
    );
  }

  if (!data.isHttps) {
    recommendations.push("🔴 CRITICAL: Migrate to HTTPS (required for trustworthiness)");
  }

  if (recommendations.length === 0) {
    recommendations.push("✅ Strong E-E-A-T signals across all categories!");
  }

  return recommendations;
}

// ── Section types (co-located with the module that produces them) ──────────────

export type EeatCheck = {
  name: string;
  passed: boolean;
  /** What the check is WORTH, matching GeoCheck and AiVisibilityCheck. */
  points: number;
  /** What this page earned of it. Every E-E-A-T check awards partial credit. */
  earned: number;
  detail: string;
  /**
   * Why this check has no score, when it has none. See `scored-checks.ts`.
   *
   * Persisted because the report has to draw the state, and `passed: false` is the
   * only other thing it could say — which is how a product page came to show a red
   * cross beside "Author bio / credentials" for a byline it was never meant to carry.
   */
  status?: ScoreStatus;
};

export type EeatCategory = {
  score: number;
  max: number;
  checks: EeatCheck[];
};

export type EeatSection = {
  grade: string;
  score: number;
  maxScore: number;
  categories: {
    experience: EeatCategory;
    expertise: EeatCategory;
    authoritativeness: EeatCategory;
    trustworthiness: EeatCategory;
  };
  recommendations: string[];
};
