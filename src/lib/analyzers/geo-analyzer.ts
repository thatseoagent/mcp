/**
 * GEO (Generative Engine Optimization) Analyzer — the whole GEO reading of a page.
 *
 * All functions here are pure (no I/O). They accept already-fetched data and
 * return deterministic results, making them straightforward to unit-test.
 *
 * {@link scoreGeo} is the entry point, and it is the only one a caller needs.
 * The run used to be assembled in the Tool handler out of twelve exported steps
 * with an unexpressed ordering constraint among them; which categories exist, in
 * what order, and where the Knowledge Graph points sit are this module's
 * decisions now, the way `scoreEeat` already had them.
 *
 * The `score*` functions stay exported as an **internal seam**: this file's own
 * tests reach through them, and TypeScript has no way to say "exported to the
 * test file only". No caller sequences them.
 */

import {
  annotate,
  qualifier,
  GOOGLE_SAYS,
  HEADING_ACCESSIBILITY,
  CITABILITY_HEURISTIC,
  STATIC_HTML_HEURISTIC,
  FRESHNESS_HEURISTIC,
  ROBOTS_FACT,
  type CheckSource,
} from "./check-source";

// ── Internal types ──

/**
 * A **Scorable** under this file's field name: `label` where the shared type's
 * other implementors say `name` or `signal`.
 *
 * It used to re-declare `passed`, `points`, `earned` and `status` with forty-odd
 * lines of prose restating what `scored-checks.ts` already says about each — two
 * copies of one set of invariants, which can only drift in the direction of
 * disagreeing. The history that is specific to *this* file is kept below; the
 * invariants live in one place.
 *
 * `passed` is required here, unlike on `Scorable`: every check in this module has
 * an answer, and `status` is how one says it had none.
 *
 * Two pieces of this file's own history that the shared type cannot carry.
 * `status` was `na?: boolean`, and the rename is not cosmetic: the old field was
 * credited its full points and relied on `computeGeoScore` to take them back off
 * both sides, whereas a `status` is out of the fraction from the start (#337).
 * And `earned` is set by exactly one check, `dateModified`, which used to express
 * partial credit by writing the earned amount into `points` — so the field held
 * two meanings in one file, and a page with a stale date rendered a literal "0/0"
 * while a page scoring 5 of 10 rendered "0/5".
 */
interface GeoCheck extends Scorable {
  passed: boolean;
  label: string;
  detail?: string;
  /**
   * Where this check gets its authority, in the sense `check-source.ts` means.
   *
   * Optional for exactly one reason: `naCheck()` builds the other kind of check.
   *
   * An earlier version of this comment claimed `applyListicleCheck()` was a second
   * obstacle. It is not — that function pushes checks other functions built, and
   * would need no change. The honest count was always one.
   *
   * And that one is not an obstacle so much as a different case. An N/A check
   * asserts nothing about the page: it says "this does not apply to a homepage" and
   * credits the points so they cannot drag the score down. There is no claim in it
   * to attribute, so requiring a source would mean picking one for sixteen call
   * sites that make no claim — and picking wrong is how a false attribution gets
   * written, which is the failure this field exists to prevent.
   *
   * Every check that does assert something supplies it, and
   * `tests/lib/analyzers/google-conformance.test.ts` asserts the field is present
   * on every non-N/A check of the category that is entirely ours.
   */
  source?: CheckSource;
}

/**
 * Build a category from its checks, deriving every number.
 *
 * `score` and `maxScore` used to be maintained by hand alongside the checks, so
 * a check's points value had to be written up to four times — in the check, in
 * the N/A credit, in a `score +=` line, and in the category's `maxScore`
 * constant — with nothing keeping them in step. Getting one wrong silently
 * changes a page's score, which happened during the page-type work.
 */
function category(key: GeoCategoryKey, name: string, checks: GeoCheck[]): GeoCategory {
  // The arithmetic moved to `scored-checks`, which this file's `category()` was
  // the original of. Three other scoring modules were maintaining a total by
  // hand next to the checks that produce it; they now share this one.
  const { score, max } = tally(checks);
  return { key, name, checks, score, maxScore: max };
}

/**
 * The stored key of every GEO Category, as the persisted section names them.
 *
 * `freshnesSignals` is misspelled and stays misspelled. It is a key in
 * `context_json` and in the frozen `shared_reports.snapshot_json`, so correcting it
 * would mean reading two spellings forever to avoid dropping a whole category from
 * every already-published report. The typo costs nothing; matching on a display
 * string did.
 */
export type GeoCategoryKey =
  | "structuredData" | "contentFreshness" | "contentStructure" | "aiCrawlerAccess"
  | "authorEeat" | "technical" | "contentCitability" | "citationSignals"
  | "freshnesSignals" | "queryOptimization";

export interface GeoCategory {
  /**
   * Where this category is stored, carried rather than looked up.
   *
   * `geo-tools` used to recover it by uppercasing `name` and reading a table, so the
   * human-readable heading was an identifier: rename "FRESHNESS SIGNALS" and that
   * category silently vanished from the stored report, with only two of the ten
   * pinned by a test. The same lesson `GeoCheck.provenance` already records one type
   * up — "`name` is an identifier here" — applied to categories.
   */
  key: GeoCategoryKey;
  name: string;
  score: number;
  maxScore: number;
  checks: GeoCheck[];
}

/**
 * A check's label as the reader should see it, provenance included.
 *
 * The `source` field is inert until something calls this: annotating the checks
 * without annotating the render would have been the same silent-heuristic problem
 * with more ceremony. Both of `geo-tools`' outputs go through here — the text
 * lines and the structured section that the stored audit and the shared report
 * page read — so a heuristic cannot appear as a Google rule on one surface and
 * be marked on another.
 *
 * Falls back to the bare label. A check with no source is not claimed to be
 * Google's, so the failure mode is a missing qualifier rather than a false one.
 */
export function describeCheck(check: { label: string; source?: CheckSource }): string {
  return check.source ? annotate(check.label, check.source) : check.label;
}

/**
 * The same qualifier, on its own, for the structured section.
 *
 * `undefined` for a Google-sourced check and for one with no source at all. Those
 * two cases are not the same thing, but they render the same — unmarked — and the
 * report has no third state to show, so collapsing them here keeps the decision
 * in one place instead of in every consumer.
 */
export function checkProvenance(check: { label: string; source?: CheckSource }): string | undefined {
  // Asks `check-source` for the qualifier instead of slicing it back out of
  // `annotate()`'s output, which was the first version: it hard-coded the " — "
  // separator, so changing the separator in one module would have silently
  // mis-sliced every string in the other.
  return check.source ? qualifier(check.source) : undefined;
}

import { LABEL } from "./geo-check-labels";
import { ARTICLE_TYPES, isUndatedPage, isUnauthoredPage, type PageKind } from "./page-identity";
import { REMOVES_FROM_INDEX } from "./technical-requirements";
import { findNodeInAll, findNodeWith, flattenJsonLd } from "./json-ld-graph";
import { tally, notScored, type Scorable } from "./scored-checks";
import { parseRobots } from "./robots-ruleset";
import { answered, textOrEmpty, type WellKnownRead } from "../well-known";
import { countWords } from "../text-analyzer";
import {
  countQuestionHeadings,
  arrivedInStaticHtml,
  countStatistics,
  definesSomething,
  hasSummarySection,
  isListicle,
  listicleShape,
  statesAStatistic,
} from "./content-signals";
import { SUPPORTED_LANGUAGES } from "./answer-patterns";
import { getSchemaTypes } from "./json-ld-graph";
import type { ParsedPage } from "./parsed-page";
import type { KnowledgeGraphMatch } from "../knowledge-graph";




function naCheck(label: string, points: number, pageType: PageKind): GeoCheck {
  return { passed: true, label, points, detail: `N/A for ${pageType} pages`, status: "not-applicable" };
}


/**
 * `Not assessable` is not a band, it is the absence of one.
 *
 * It is reported when no check on the page could be scored at all, where the four
 * bands would otherwise hand out the report's worst word for the one input we
 * failed to measure rather than the one that scored badly. `report-systems.ts`
 * leaves an unrecognised grade word out of the systems row rather than guessing a
 * health for it, which is the right treatment here and needs no entry there.
 */
export type GeoGrade = "Excellent" | "Good" | "Moderate" | "Low" | "Not assessable";

export interface GeoScoreResult {
  /** 0-100 score, normalized against the points applicable to this page type. */
  score: number;
  grade: GeoGrade;
  /** Raw points earned over the scorable checks, plus any KG bonus earned. */
  earned: number;
  /** Raw points achievable for this page type, plus KG max. */
  applicableMax: number;
  /** Total points that were N/A for this page type and excluded from scoring. */
  naPoints: number;
  /**
   * Points belonging to checks that could not be evaluated on this run.
   *
   * Distinct from `naPoints` because it is transitory: the same page can produce a
   * different figure on the next run with nothing about the site having changed, so
   * the caller has to say so rather than quietly average over it.
   */
  unevaluatedPoints: number;
}

/**
 * Aggregate category scores into a single 0-100 GEO score (#288).
 *
 * Checks that do not apply to this page type (Article freshness on a homepage) once
 * auto-awarded their full points, inflating homepage scores to "Excellent" while
 * contradicting ai_visibility_score. They are out of both sides of the fraction.
 *
 * This function used to do that subtraction itself, because `tally` credited an N/A
 * check in full and left the correction to whoever normalized. It no longer does
 * (#337): `cat.score` and `cat.maxScore` arrive already net of anything carrying a
 * `status`, so subtracting `naPoints` here again would take the same points off
 * twice. The loop below therefore *adds up* and does not correct — and the counts it
 * keeps are for the sentence the report prints, not for the arithmetic.
 */
export function computeGeoScore(
  categories: GeoCategory[],
  opts: { knowledgeGraph?: Scorable | null } = {},
): GeoScoreResult {
  // One `Scorable`, not three hand-maintained figures. The caller used to write
  // `kgApplicable: … ? 5 : 0`, `kgEarned: … ? 5 : 0` and `kgUnevaluated: … ? 5 : 0`
  // — the number 5 three times, and a fourth in the render — which is exactly the
  // pattern `scored-checks.ts` was written to remove: "`ai-visibility` wrote every
  // value twice … with nothing keeping them in step". `tally` decides now, so the
  // three cases are one branch in `knowledgeGraphCheck` and the points are one
  // constant.
  const kg = tally(opts.knowledgeGraph ? [opts.knowledgeGraph] : []);

  let earned = kg.score;
  let applicableMax = kg.max;
  let naPoints = kg.notApplicable;
  // Counted, never added to either side of the fraction — that is what makes it
  // unevaluated. It exists so the report can say the run is not comparable to the
  // last one, which is the one thing a transitory absence owes the reader.
  let unevaluatedPoints = kg.notEvaluated;
  for (const cat of categories) {
    earned += cat.score;
    applicableMax += cat.maxScore;
    // Re-tallied rather than carried on `GeoCategory`: the counts are needed in one
    // place, and adding two fields to the category would widen the shape stored on
    // every audit to hold a figure only the summary line reads.
    const { notApplicable, notEvaluated } = tally(cat.checks);
    naPoints += notApplicable;
    unevaluatedPoints += notEvaluated;
  }

  const raw = applicableMax > 0 ? Math.round((earned / applicableMax) * 100) : 0;
  const score = Math.max(0, Math.min(100, raw));

  // No applicable points means nothing was measured, and the four bands would hand
  // such a page "Low" — the report's worst word for the one input that did not earn
  // it. This is the #337 class in the module that fixed #288: a confident answer to
  // a question nobody managed to ask.
  const grade: GeoGrade =
    applicableMax === 0 ? "Not assessable" :
    score >= 85 ? "Excellent" :
    score >= 70 ? "Good" :
    score >= 50 ? "Moderate" : "Low";

  return { score, grade, earned, applicableMax, naPoints, unevaluatedPoints };
}

// ── Exported pure functions ────────────────────────────────────────────────────


/**
 * Is this crawler shut out of the site?
 *
 * Was a regex split over the file that only recognised a literal `Disallow: /`,
 * so `Disallow: /*` read as "allowed" here while `ai-visibility-tools` read the
 * same line as "blocked" and the robots section read `Disallow: /admin/` as
 * blocked when neither of the others did. One matcher now answers for all three.
 */
export function isBotBlocked(robotsTxt: string, botName: string): boolean {
  if (!robotsTxt) return false;
  return parseRobots(robotsTxt).blocksEntirely(botName);
}

export function scoreStructuredData(schemas: readonly unknown[], schemaTypes: Set<string>, pageType: PageKind): GeoCategory {
  const checks: GeoCheck[] = [];

  // FAQPage schema: 2 pts, and only on a page that is actually an FAQ.
  //
  // Downgraded May 2026 — Google deprecated FAQ rich results and the Ahrefs
  // causal study showed no AI citation lift from the schema. It used to be scored
  // on every page type, which meant a homepage lost points for not shipping
  // FAQPage and gained them for shipping it: the report rewarded markup that
  // misdescribes the page, which is the abuse `schema-mismatch-analyzer` exists
  // to flag. The visible Q&A pattern is rewarded separately in Content Structure,
  // which is where the value actually is.
  if (pageType !== "faq") {
    checks.push(naCheck("FAQPage schema present", 2, pageType));
  } else {
    const hasFaq = schemaTypes.has("FAQPage");
    checks.push({ passed: hasFaq, label: "FAQPage schema present", source: CITABILITY_HEURISTIC, points: 2 });
  }

  // Article/BlogPosting with author + datePublished + dateModified: 7 pts
  const articleSchemaNA = isUndatedPage(pageType);
  if (articleSchemaNA) {
    checks.push(naCheck(LABEL.articleSchema, 7, pageType));
  } else {
    // ARTICLE_TYPES, not a local literal. This check used its own narrower list
    // (`Article`, `BlogPosting`, `NewsArticle`) while page-identity classified pages
    // using a wider one that also includes `TechArticle` and `Report`. A page carrying
    // TechArticle was therefore identified as an article — which is what makes this
    // check applicable at all — and then failed it for having no article schema. The
    // two lists disagreeing meant no markup could satisfy both, so those pages lost
    // 7 points they could not earn. Both are schema.org subtypes of Article and
    // Google treats them as Article types.
    const complete = findNodeWith(schemas, ARTICLE_TYPES, (n) => !!(n.author && n.datePublished && n.dateModified));
    const articleSchema = complete ?? findNodeInAll(schemas, ARTICLE_TYPES);
    const hasArticleComplete = !!complete;
    checks.push({
      passed: hasArticleComplete,
      label: LABEL.articleSchema, source: CITABILITY_HEURISTIC,
      points: 7,
      detail: articleSchema
        ? "Article schema found but missing author, datePublished or dateModified"
        : "No Article schema found",
    });
  }

  // Organization with sameAs >= 2: 7 pts
  // The page's publishing entity — an Organization on a company site, a Person on
  // a personal one. joost.blog declares eight Organizations, all of them companies
  // its author is involved with, and identifies itself through a Person: demanding
  // an Organization there is the same error as demanding Article of a homepage.
  //
  // Any qualifying node, not the first of its type: interrogating whichever
  // happened to be serialized first is a coin toss.
  const ENTITY = ["Organization", "LocalBusiness", "Person"];
  const orgSchema = findNodeWith(schemas, ENTITY, (n) => Array.isArray(n.sameAs) && n.sameAs.length >= 2)
    ?? findNodeInAll(schemas, ENTITY);
  const sameAs = orgSchema?.sameAs;
  const sameAsCount = Array.isArray(sameAs) ? sameAs.length : sameAs ? 1 : 0;
  const hasOrgSameAs = sameAsCount >= 2;
  checks.push({
    passed: hasOrgSameAs,
    label: LABEL.publishingEntityIdentity, source: CITABILITY_HEURISTIC,
    points: 7,
    detail: `Identity links found: ${sameAsCount}`,
  });

  // 3+ distinct schema types: 4 pts
  const hasMany = schemaTypes.size >= 3;
  checks.push({
    passed: hasMany,
    label: "3+ distinct schema types", source: CITABILITY_HEURISTIC,
    points: 4,
    detail: `Schema types: ${[...schemaTypes].join(", ") || "none"}`,
  });

  // Speakable schema: acknowledged, never required.
  //
  // Google restricts speakable results to publishers approved for Google News,
  // in specific locales. Page type cannot tell us whether a site is one of those,
  // and for everyone else the markup does nothing — so scoring its absence as a
  // 3-point failure docked points for not shipping a feature that would have had
  // no effect, and the recommendation advised every site on earth to add it.
  //
  // Treated as a credited bonus: sites that ship it are acknowledged, nobody is
  // penalised, and it stays out of the scored denominator via its `status`.
  const hasSpeakable = schemaTypes.has("SpeakableSpecification") ||
    schemas.some((s) => flattenJsonLd(s).some((n) => !!n["speakable"]));
  checks.push({
    passed: true,
    status: "not-applicable",
    label: "Speakable schema for voice/AI assistant citation", source: CITABILITY_HEURISTIC,
    points: 3,
    detail: hasSpeakable
      ? "Present. Not scored as a requirement: Google restricts speakable results to Google News-approved publishers."
      : "Not scored: Google restricts speakable results to Google News-approved publishers, so most sites gain nothing by adding it.",
  });

  return category("structuredData", "STRUCTURED DATA", checks);
}

/**
 * The `<lastmod>` a sitemap publishes for one specific page, matched by `<loc>`.
 *
 * Returns `null` when the page is absent from the XML — which is a different answer
 * from "present with no lastmod", and the caller reports them differently.
 *
 * URL comparison ignores a trailing slash and is case-insensitive on scheme and host
 * only: a sitemap that lists `https://example.com/a/` describes the same page as
 * `https://example.com/a`, but `/A` is a different path on a case-sensitive server.
 */
/**
 * Un-exported: `scoreFreshness` at the one call site below is its only reader.
 * It was exported with the rest of the scorers and nothing outside this module,
 * not even a test, ever imported it.
 */
function findSitemapLastmod(
  sitemapXml: string,
  pageUrl: string
): { lastmod: string | null } | null {
  const normalize = (u: string): string => {
    try {
      const parsed = new URL(u.trim());
      const path = parsed.pathname.replace(/\/+$/, "");
      return `${parsed.protocol.toLowerCase()}//${parsed.host.toLowerCase()}${path}${parsed.search}`;
    } catch {
      return u.trim().replace(/\/+$/, "");
    }
  };

  const target = normalize(pageUrl);

  for (const block of sitemapXml.match(/<url\b[\s\S]*?<\/url>/gi) ?? []) {
    const loc = block.match(/<loc>\s*([\s\S]*?)\s*<\/loc>/i)?.[1];
    if (!loc || normalize(loc) !== target) continue;
    const lastmod = block.match(/<lastmod>\s*([\s\S]*?)\s*<\/lastmod>/i)?.[1];
    return { lastmod: lastmod ?? null };
  }

  return null;
}

/**
 * `pageUrl` is optional so the check can say why it could not run rather than
 * silently comparing against an unrelated entry, which is what it used to do.
 */
/**
 * `sitemapRead` rather than the XML, for one branch out of five.
 *
 * The sitemap-consistency check below resolves to `passed: false` for five distinct
 * states, and only three of them are findings about the site. "Page is not listed"
 * and "no lastmod published" are real, and stay scored. "We could not read a
 * sitemap" is not: it is the same unanswered read as the four bot checks, and it
 * cost 5 points (#337).
 *
 * Deliberately narrow. `absent` — the site has no sitemap at all — stays a scored
 * failure, because that IS a finding, and telling the two apart is exactly what the
 * three-state read is for.
 */
export function scoreFreshness(
  schemas: readonly unknown[],
  sitemapRead: WellKnownRead,
  pageType: PageKind,
  pageUrl?: string
): GeoCategory {
  const sitemapXml = textOrEmpty(sitemapRead);
  const checks: GeoCheck[] = [];

  const freshnessNA = isUndatedPage(pageType);
  if (freshnessNA) {
    checks.push(naCheck(LABEL.dateModified, 10, pageType));
    checks.push(naCheck(LABEL.sitemapLastmod, 5, pageType));
  } else {
    let dateModifiedStr: string | null = null;
    for (const s of schemas) {
      const rec = s as Record<string, unknown>;
      if (rec.dateModified) { dateModifiedStr = String(rec.dateModified); break; }
    }

    let freshnessPoints = 0;
    let freshnessDetail = "No dateModified found in schema";
    if (dateModifiedStr) {
      const modified = new Date(dateModifiedStr);
      const now = new Date();
      const daysDiff = Math.floor((now.getTime() - modified.getTime()) / (1000 * 60 * 60 * 24));
      if (daysDiff <= 90) {
        freshnessPoints = 10;
        freshnessDetail = `Modified ${daysDiff} days ago (≤90 days)`;
      } else if (daysDiff <= 180) {
        freshnessPoints = 5;
        freshnessDetail = `Modified ${daysDiff} days ago (≤180 days, partial score)`;
      } else {
        freshnessDetail = `Modified ${daysDiff} days ago (>180 days)`;
      }
    }
    checks.push({
      passed: freshnessPoints >= 10,
      label: LABEL.dateModified, source: FRESHNESS_HEURISTIC,
      points: 10,
      earned: freshnessPoints,
      detail: freshnessDetail,
    });

    // This used to read the first <lastmod> in the document, whatever URL it belonged
    // to, and compare that against the analyzed page. On a sitemap index the first
    // <lastmod> is the index's entry for a child sitemap, so the check compared the
    // index's date to the page's — thatseoagent.com reported "differs by 47 days" while
    // its child sitemap carried the correct per-URL date. On any multi-URL sitemap it
    // compared some other page's date. Both produce a failure the site cannot act on.
    const entry = pageUrl ? findSitemapLastmod(sitemapXml, pageUrl) : null;
    let sitemapConsistent = false;
    let sitemapDetail: string;

    if (!answered(sitemapRead)) {
      sitemapDetail = notScored(
        sitemapRead.outcome === "unavailable" ? sitemapRead.reason : "the sitemap could not be read on this run",
      );
    } else if (!sitemapXml.trim()) {
      sitemapDetail = "No sitemap available to check";
    } else if (!pageUrl) {
      sitemapDetail = "No page URL supplied, cannot match a sitemap entry";
    } else if (!entry) {
      // A distinct, more actionable finding than a date mismatch: a page missing from
      // the sitemap has a discovery problem, not a freshness one.
      sitemapDetail = "Page is not listed in the sitemap";
    } else if (!entry.lastmod) {
      sitemapDetail = "Sitemap lists this page but publishes no lastmod for it";
    } else if (!dateModifiedStr) {
      sitemapDetail = "Sitemap has lastmod for this page but the schema has no dateModified";
    } else {
      const diffDays =
        Math.abs(new Date(entry.lastmod).getTime() - new Date(dateModifiedStr).getTime()) /
        (1000 * 60 * 60 * 24);
      sitemapConsistent = diffDays <= 7;
      sitemapDetail = sitemapConsistent
        ? "Sitemap lastmod within 7 days of dateModified"
        : `Sitemap lastmod for this page differs by ${Math.round(diffDays)} days`;
    }

    checks.push({
      passed: sitemapConsistent,
      label: LABEL.sitemapLastmod, source: FRESHNESS_HEURISTIC,
      points: 5,
      status: answered(sitemapRead) ? undefined : "not-evaluated",
      detail: sitemapDetail,
    });
  }

  return category("contentFreshness", "CONTENT FRESHNESS", checks);
}

/**
 * Structure of the page's own copy: headings, lists, Q&A shape.
 *
 * Took `schemas` and `pageType` until the word-count check was removed. Both
 * existed only to decide whether to score a homepage against a 500-word floor,
 * and that floor is gone: Google states length alone does not affect ranking.
 *
 * `pageType` came back for the listicle check, which belongs to this category and
 * used to be bolted on afterwards by an exported `applyListicleCheck(category,
 * html, pageType)` — a second call with an unexpressed ordering constraint, that
 * mutated the category and then rebuilt its totals with `Object.assign` because
 * appending a check invalidates them. One function builds the whole category now,
 * so there is nothing to sequence and nothing to mutate.
 */
export function scoreContentStructure(page: ParsedPage, pageType: PageKind): GeoCategory {
  const { html, readable } = page;
  const checks: GeoCheck[] = [];

  // The page's copy, through the one module that knows how to read it. This was
  // a body regex — one of four in this file and seven in the codebase — which
  // kept `<script>` text nodes, glued `<h1>foo<br>bar</h1>` into one word, and
  // deleted React's streamed containers. `visible-text.ts` handles all three and
  // was never called from here.
  const textContent = readable.mainContent();
  const wordCount = countWords(textContent);

  // Word count is reported, not scored. It was worth 2 points above 500, which
  // is the same invented floor the page analyzers carried, and Google states
  // "the length of the content alone doesn't matter for ranking purposes".
  checks.push({
    passed: true,
    label: "Word count (informational — length alone is not a ranking factor)", source: CITABILITY_HEURISTIC,
    points: 0,
    detail: `Word count: ${wordCount}`,
  });

  // A page with no H1 has not stated its subject anywhere an extractor can find
  // it, which is a real problem for anything trying to summarise it. *Two* H1s
  // is not — Google says heading order and count do not matter, and no engine
  // has claimed otherwise. The check used to demand exactly one and dock a
  // correctly built page three points for having a second.
  const h1Count = (html.match(/<h1[^>]*>/gi) ?? []).length;
  checks.push({
    passed: h1Count >= 1,
    label: "Page states its subject in an H1", source: HEADING_ACCESSIBILITY,
    points: 3,
    detail:
      h1Count === 0
        ? "No H1 found — nothing names the page's subject"
        : `H1 tags found: ${h1Count}`,
  });

  // Visible Q&A pattern in the DOM (semantic disclosure, definition list, or

  const listItems = (html.match(/<li[^>]*>/gi) ?? []).length;
  const paragraphCount = (html.match(/<p[^>]*>/gi) ?? []).length;
  const hasLists = listItems >= 5 || (paragraphCount > 0 && listItems / paragraphCount > 0.1);
  checks.push({
    passed: hasLists,
    label: "Lists ratio > 10% (structured content)", source: CITABILITY_HEURISTIC,
    points: 3,
    detail: `List items: ${listItems}, paragraphs: ${paragraphCount}`,
  });

  // Numbered headings and comparison tables are how a listicle is built. A
  // homepage is not one, and telling its owner to restructure it as a list is
  // advice that would make the page worse.
  checks.push(
    pageType === "homepage"
      ? naCheck(LABEL.listicleFormatting, 5, pageType)
      : scoreListicleFormatting(html),
  );

  return category("contentStructure", "CONTENT STRUCTURE", checks);
}

/**
 * `robotsRead` is three-state, and that is the whole repair.
 *
 * This took `robotsTxt: string`, and `geo-tools` handed it `""` whenever the fetch
 * failed. `isBotBlocked("", "GPTBot")` finds no rule and returns false, so all four
 * bot checks **passed** — a robots.txt we never read awarded 13 points across GPTBot
 * (5), PerplexityBot (3), ClaudeBot (3) and Google-Extended (2). Not a penalty for an
 * unanswerable question but the other face of it: full marks for one (#337).
 *
 * `absent` is deliberately still a pass. No robots.txt means no rules, so every
 * crawler really is allowed — the case this used to get right by accident and now
 * gets right on purpose.
 */
export function scoreAiCrawlerAccess(
  robotsRead: WellKnownRead,
  html: string,
  llmsTxtExists: boolean,
): GeoCategory {
  // Empty for `absent`, which is the correct input for a parser: no file, no rules.
  // Guarded by the branch below, so `unavailable` never reaches it.
  const robotsTxt = textOrEmpty(robotsRead);
  const robotsUnread = !answered(robotsRead);
  const robotsDetail = robotsRead.outcome === "unavailable"
    ? notScored(robotsRead.reason, "retry, or check that /robots.txt is reachable")
    : null;
  const checks: GeoCheck[] = [];

  /**
   * The four AI crawlers, as one loop.
   *
   * They were four copies of the same nine lines differing only in a name and a
   * point value, and each copy's `detail` restated its own label: the row read
   * "GPTBot allowed in robots.txt" with "GPTBot is allowed" underneath it. That
   * was invisible while `CheckRow` discarded details on scored rows; the moment
   * it started printing them, the AI Crawler Access card was four rows of the
   * same sentence twice.
   *
   * So the detail says *why* the answer is what it is, which is the part the
   * label cannot carry — and the three-state read makes that a real distinction:
   * "no robots.txt at all" and "a robots.txt with no rule against you" are both
   * a pass, for different reasons, and only one of them is worth acting on if it
   * changes.
   */
  const AI_CRAWLERS: ReadonlyArray<{ bot: string; points: number }> = [
    { bot: "GPTBot", points: 5 },
    { bot: "PerplexityBot", points: 3 },
    { bot: "ClaudeBot", points: 3 },
    { bot: "Google-Extended", points: 2 },
  ];

  for (const { bot, points } of AI_CRAWLERS) {
    const blocked = isBotBlocked(robotsTxt, bot);
    checks.push({
      passed: !blocked,
      label: `${bot} allowed in robots.txt`, source: ROBOTS_FACT,
      points,
      status: robotsUnread ? "not-evaluated" : undefined,
      detail:
        robotsDetail ??
        (blocked
          ? `A Disallow rule in /robots.txt applies to ${bot}`
          : robotsRead.outcome === "absent"
            ? "No /robots.txt, so no rule excludes it"
            : `/robots.txt has no Disallow rule matching ${bot}`),
    });
  }

  const metaRobotsContent = html.match(/<meta[^>]+name=["']robots["'][^>]*content=["']([^"']+)["']/i)?.[1] ?? "";
  const hasNosnippet = /nosnippet/i.test(metaRobotsContent) || /data-nosnippet/i.test(html);
  checks.push({
    passed: !hasNosnippet,
    label: "No nosnippet in meta robots or data-nosnippet", source: ROBOTS_FACT,
    points: 2,
    detail: hasNosnippet ? "nosnippet detected — AI cannot excerpt this content" : "No nosnippet restrictions",
  });

  // llms.txt scores nothing. Google's guide to optimizing for generative AI
  // names it among the practices it does not use: "Google Search doesn't use
  // llms.txt files; they neither help nor harm a site's performance in Google
  // Search." No other engine has published a claim that it reads them either.
  //
  // Awarding points here was the sharpest contradiction in the product — a tool
  // whose premise is "we check what Google checks" was spending a
  // recommendation slot on a file Google ignores. It is still detected, because
  // knowing it exists is worth something, and it is reported as what it is.
  checks.push({
    passed: true,
    label: "llms.txt (informational — Google Search does not use it)", source: ROBOTS_FACT,
    points: 0,
    detail: llmsTxtExists
      ? "llms.txt found. Google Search does not read it; it neither helps nor harms. Harmless to keep."
      : "No llms.txt. Google Search does not use it, so this costs nothing.",
  });

  return category("aiCrawlerAccess", "AI CRAWLER ACCESS", checks);
}

/**
 * The author a page declares in its structured data.
 *
 * `author` arrives three ways in the wild: a plain string, an inline Person, or —
 * the Yoast shape — an `@id` reference to a Person node elsewhere in the graph.
 * All three are the page telling us who wrote it, and all three used to be
 * ignored in favour of a prose pattern.
 */
function schemaAuthorName(schemas: readonly unknown[]): string {
  const article = findNodeInAll(schemas, ["Article", "BlogPosting", "NewsArticle"]);
  const author = article?.author;

  if (typeof author === "string") return author.trim();

  if (author && typeof author === "object") {
    const a = author as Record<string, unknown>;
    if (typeof a.name === "string") return a.name.trim();
    // A reference: resolve the @id against the Person nodes in the same payload.
    if (typeof a["@id"] === "string") {
      const target = findNodeWith(schemas, ["Person", "Organization"], (n) => n["@id"] === a["@id"]);
      if (typeof target?.name === "string") return target.name.trim();
    }
  }

  // No Article node, or none with an author: fall back to any named Person the
  // page declares, which on a personal site is the author.
  const person = findNodeWith(schemas, ["Person"], (n) => typeof n.name === "string" && !!n.name);
  return typeof person?.name === "string" ? person.name.trim() : "";
}

export function scoreAuthorEeat(html: string, schemas: readonly unknown[], pageType: PageKind): GeoCategory {
  const checks: GeoCheck[] = [];

  const authorNA = isUnauthoredPage(pageType);
  if (authorNA) {
    checks.push(naCheck("Named author (not generic Team/Admin/Staff)", 4, pageType));
  } else {
    // EN + ES bylines. No /i flag: the name must stay capitalized so Spanish "por"
    // ("por la mañana") doesn't match a non-name; keyword cases are listed explicitly.
    const authorRe = /(?:[Bb]y|[Aa]uthor|[Ww]ritten by|[Pp]osted by|[Pp]or|[Aa]utor|[Ee]scrito por|[Pp]ublicado por)[:\s]+([A-ZÁÉÍÓÚÑ][a-záéíóúñ]+ [A-ZÁÉÍÓÚÑ][a-záéíóúñ]+)/;
    // Schema first: `Article.author` is the page's own unambiguous declaration,
    // where a prose regex is a guess. This check used to read only the prose, so a
    // post declaring `Person: Joost de Valk` in its @graph and naming him ten
    // times still failed for want of a literal "by Joost de Valk".
    const authorText = schemaAuthorName(schemas) || html.match(authorRe)?.[1] || "";
    const isGenericAuthor = /\b(team|admin|staff|editor|webmaster|anonymous|equipo|redacción|redaccion|administrador|anónimo|anonimo)\b/i.test(authorText);
    const hasNamedAuthor = !!(authorText && !isGenericAuthor);
    checks.push({
      passed: hasNamedAuthor,
      label: "Named author (not generic Team/Admin/Staff)", source: CITABILITY_HEURISTIC,
      points: 4,
      detail: hasNamedAuthor ? `Author: ${authorText}` : "No named author detected",
    });
  }

  const personNA = isUnauthoredPage(pageType);
  if (personNA) {
    checks.push(naCheck(LABEL.personSchema, 5, pageType));
  } else {
    // Merged from STRUCTURED DATA, which scored the same markup for 4 more points.
    // Takes the union of the two predicates: that copy accepted `jobTitle` too, so
    // keeping only `sameAs` would newly fail pages that used to pass.
    const personSchema = findNodeWith(schemas, ["Person"], (n) => !!(n.sameAs || n.jobTitle))
      ?? findNodeInAll(schemas, ["Person"]);
    const hasPerson = !!(personSchema?.sameAs || personSchema?.jobTitle);
    checks.push({
      passed: hasPerson,
      label: LABEL.personSchema, source: CITABILITY_HEURISTIC,
      points: 5,
      detail: personSchema?.sameAs ? "Person schema with a profile link found"
        : personSchema?.jobTitle ? "Person schema with jobTitle but no sameAs"
        : "No Person schema",
    });
  }

  const eduGovLinks = html.match(/href=["'][^"']*\.(?:edu|gov)[^"']*["']/gi) ?? [];
  const hasEduGov = eduGovLinks.length > 0;
  checks.push({
    passed: hasEduGov,
    label: "Outbound links to .edu or .gov domains", source: CITABILITY_HEURISTIC,
    points: 4,
    detail: hasEduGov ? `${eduGovLinks.length} .edu/.gov link(s) found` : "No .edu/.gov outbound links",
  });

  // A Person is the publishing entity of a personal site, and schema.org gives it
  // `image` where an Organization has `logo`. Both are the same claim: here is the
  // entity, here is its canonical URL, here is its mark.
  const entitySchema = findNodeWith(schemas, ["Organization", "LocalBusiness", "Person"],
    (n) => !!(n.url && (n.logo || n.image)));
  const hasOrgComplete = !!entitySchema;
  checks.push({
    passed: hasOrgComplete,
    label: "Publishing entity with url + logo/image (Organization or Person)", source: CITABILITY_HEURISTIC,
    points: 2,
    detail: hasOrgComplete
      ? `${entitySchema?.["@type"]} with url and ${entitySchema?.logo ? "logo" : "image"}`
      : "No Organization or Person schema carrying both a url and a logo/image",
  });

  return category("authorEeat", "AUTHOR / E-E-A-T", checks);
}

export function scoreTechnical(page: ParsedPage, httpStatus: number): GeoCategory {
  const { html, readable } = page;
  const checks: GeoCheck[] = [];

  const isHttp200 = httpStatus === 200;
  checks.push({ passed: isHttp200, label: "HTTP 200 status code", source: GOOGLE_SAYS.onlyHttp200IsIndexed, points: 3, detail: `HTTP status: ${httpStatus || "unreachable"}` });

  const metaRobotsContent = html.match(/<meta[^>]+name=["']robots["'][^>]*content=["']([^"']+)["']/i)?.[1] ?? "";
  // Shares the predicate with the indexability gate. A bare `/noindex/i` here
  // missed `none`, which Google defines as "Equivalent to `noindex, nofollow`", so
  // this check called a page indexable while the gate called it excluded.
  const hasNoindex = REMOVES_FROM_INDEX.test(metaRobotsContent);
  checks.push({
    passed: !hasNoindex,
    label: LABEL.noindexAbsent, source: GOOGLE_SAYS.noindexRemovesThePage,
    points: 4,
    detail: hasNoindex ? `noindex detected: ${metaRobotsContent}` : "Indexable (no noindex directive)",
  });

  // Every visible word, chrome included: the question is whether *any* content
  // arrived in the static HTML, not how much the page says.
  //
  // This copy and `ai-visibility-analyzer`'s are the same check with the same
  // 300-character threshold, and they disagreed: one joined tags with `""` and
  // the other with `" "`, so the two measured the same page and got different
  // character counts. One derivation, one answer.
  const staticText = readable.allText();
  const hasStaticContent = arrivedInStaticHtml(readable);
  checks.push({
    passed: hasStaticContent,
    label: "Content visible in static HTML (not JS-only)", source: STATIC_HTML_HEURISTIC,
    points: 3,
    detail: `Static text: ${staticText.length} chars`,
  });

  return category("technical", "TECHNICAL", checks);
}

export function scoreContentCitability(page: ParsedPage, pageType: PageKind): GeoCategory {
  const { readable } = page;
  const checks: GeoCheck[] = [];

  const textContent = readable.mainContent();

  // Definitional phrasing, in the language the page declares. This was a
  // hardcoded EN+ES regex, which fixed Spanish and left German exactly as
  // broken — silently, which `answer-patterns.ts` says is "the shape of the
  // original bug, not a fix for it". Going through it means an unreadable
  // language becomes `not-evaluated` and the reader is told we cannot read
  // definitions in their language yet, instead of being told their page has none.
  const defines = definesSomething(textContent, page.language);
  const DEFINITION_LABEL = "Definition patterns present (X is a…, refers to, means)";
  if (pageType === "homepage") {
    checks.push(naCheck(DEFINITION_LABEL, 4, pageType));
  } else if (defines.outcome === "unsupported") {
    checks.push({
      passed: false,
      label: DEFINITION_LABEL, source: CITABILITY_HEURISTIC,
      points: 4,
      status: "not-evaluated",
      detail: notScored(
        `we cannot read definitional phrasing in ${defines.languageName} yet`,
        `the page is not at fault — supported languages are ${SUPPORTED_LANGUAGES.join(", ")}`,
      ),
    });
  } else {
    checks.push({
      passed: defines.defines,
      label: DEFINITION_LABEL, source: CITABILITY_HEURISTIC,
      points: 4,
      detail: defines.defines
        ? "Definition patterns detected"
        : "No definition patterns found — add definitional sentences near the top",
    });
  }

  const first150Words = textContent.split(/\s+/).slice(0, 150).join(" ");
  const earlyDefines = definesSomething(first150Words, page.language);
  const hasEarlyAnswer =
    first150Words.length > 80 &&
    ((earlyDefines.outcome === "answered" && earlyDefines.defines) ||
      statesAStatistic(first150Words));
  checks.push({
    passed: hasEarlyAnswer,
    label: "Answer-first structure (key info/stats in first 150 words)", source: CITABILITY_HEURISTIC,
    points: 3,
    detail: hasEarlyAnswer
      ? "Page leads with a direct answer or data point"
      : "No direct answer detected near page start — lead with a definition or key statistic",
  });

  return category("contentCitability", "CONTENT CITABILITY", checks);
}

export function scoreCitationSignals(page: ParsedPage, pageType: PageKind): GeoCategory {
  const { html, readable } = page;
  const checks: GeoCheck[] = [];

  const textContent = readable.mainContent();

  // The union of what the two merged checks detected, and it lives in
  // `content-signals` now. The written magnitudes are the part a fork dropped:
  // losing `millones|mil` "would have quietly stopped counting 'más de 80
  // millones' as a statistic on every Spanish page", which is exactly what
  // happened when `seo-content-analysis` copied the English half.
  const statisticCount = countStatistics(textContent);
  // CONTENT STRUCTURE excused a homepage from its statistics check while this one
  // scored the same signal anyway: one page, two verdicts. Gated identically now.
  if (pageType === "homepage") {
    checks.push(naCheck("Statistics & numerical data (%, $, ratios)", 5, pageType));
  } else {
    // Merged from CONTENT STRUCTURE, which scored the same signal for 3 more
    // points using density rather than a count. Either satisfies it: neither test
    // is wrong, and requiring only one would newly fail the pages the other
    // caught — a short page with two figures, or a long one with a good rate.
    const words = textContent.split(/\s+/).filter(Boolean).length;
    const per1k = words > 0 ? (statisticCount / words) * 1000 : 0;
    const hasStats = statisticCount >= 2 || per1k >= 2;
    checks.push({
      passed: hasStats,
      label: "Statistics & numerical data (%, $, ratios)", source: CITABILITY_HEURISTIC,
      points: 5,
      detail: `${statisticCount} statistical pattern(s), ${per1k.toFixed(1)} per 1k words`,
    });
  }

  const sourcePattern = /\b(according to|a study by|research (?:from|by|shows)|data from|published (?:in|by)|según|segun|de acuerdo con|un estudio de|estudio de|investigación (?:de|por)|investigacion (?:de|por)|datos de|publicado (?:en|por))\b/gi;
  const sourceMatches = textContent.match(sourcePattern) ?? [];
  const hasSources = sourceMatches.length >= 1;
  checks.push({
    passed: hasSources,
    label: "Source attribution phrases (according to, study by, data from)", source: CITABILITY_HEURISTIC,
    points: 5,
    detail: hasSources ? `${sourceMatches.length} source attribution(s) found` : "No source attribution phrases detected",
  });

  const blockquoteCount = (html.match(/<blockquote[^>]*>/gi) ?? []).length;
  const hasBlockquotes = blockquoteCount >= 1;
    // Blockquotes and a references section are article conventions. A homepage
  // that quotes nobody and cites nothing is not deficient; it is a homepage.
  if (pageType === "homepage") {
    checks.push(naCheck("Blockquote elements present", 5, pageType));
  } else {
  checks.push({
      passed: hasBlockquotes,
      label: "Blockquote elements present", source: CITABILITY_HEURISTIC,
      points: 5,
      detail: `${blockquoteCount} <blockquote> element(s) found`,
    });
  }

  const refSectionPattern = /<h[2-6][^>]*>[^<]*(?:references|sources|footnotes|bibliography|referencias|fuentes|bibliografía|bibliografia|notas)[^<]*<\/h[2-6]>/gi;
  const hasRefSection = refSectionPattern.test(html);
  const nofollowLinks = (html.match(/href=["'][^"']*["'][^>]*rel=["'][^"']*nofollow[^"']*["']/gi) ?? []).length +
    (html.match(/rel=["'][^"']*nofollow[^"']*["'][^>]*href=["'][^"']*["']/gi) ?? []).length;
  const hasRefLinks = hasRefSection || nofollowLinks >= 1;
  
  if (pageType === "homepage") {
    checks.push(naCheck("Reference links (nofollow external links or references section)", 5, pageType));
  } else {
  checks.push({
      passed: hasRefLinks,
      label: "Reference links (nofollow external links or references section)", source: CITABILITY_HEURISTIC,
      points: 5,
      detail: hasRefSection
        ? "References/footnotes/bibliography heading found"
        : nofollowLinks >= 1
          ? `${nofollowLinks} nofollow link(s) found`
          : "No reference section or nofollow links detected",
    });
  }

  return category("citationSignals", "CITATION SIGNALS", checks);
}

export function scoreFreshnessSignals(html: string, responseHeaders: Record<string, string>, pageType: PageKind): GeoCategory {
  const checks: GeoCheck[] = [];

  const jsonLdPattern = /<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  // A JSON-LD publication date is the same signal CONTENT FRESHNESS and the
  // `article:*` meta tags already excuse on an undated page. It was the only one
  // of the three left ungated, and at 7 points the most expensive: a homepage was
  // N/A for both of the others and then lost 7 points for the third.
  if (isUndatedPage(pageType)) {
    checks.push(naCheck(LABEL.jsonLdDates, 7, pageType));
  } else {
    let jsonLdHasFreshness = false;
    let m: RegExpExecArray | null;
    while ((m = jsonLdPattern.exec(html)) !== null) {
      if (/"dateModified"|"datePublished"/i.test(m[1])) {
        jsonLdHasFreshness = true;
        break;
      }
    }
    checks.push({
      passed: jsonLdHasFreshness,
      label: LABEL.jsonLdDates, source: FRESHNESS_HEURISTIC,
      points: 7,
      detail: jsonLdHasFreshness
        ? "Freshness date found in JSON-LD structured data"
        : "No dateModified or datePublished in any JSON-LD block",
    });
  }

  const hasLastModified = !!(responseHeaders["last-modified"] || responseHeaders["Last-Modified"]);
  const hasEtag = !!(responseHeaders["etag"] || responseHeaders["ETag"]);
  const hasFreshnessHeader = hasLastModified || hasEtag;
  checks.push({
    passed: hasFreshnessHeader,
    label: "Last-Modified or ETag response header present", source: FRESHNESS_HEURISTIC,
    points: 4,
    detail: hasLastModified
      ? `Last-Modified: ${responseHeaders["last-modified"] ?? responseHeaders["Last-Modified"]}`
      : hasEtag
        ? "ETag header present"
        : "No Last-Modified or ETag header",
  });

  // `article:*` Open Graph tags describe an article. Asking a homepage for a
  // publication date is asking it to claim it is something it is not.
  if (isUndatedPage(pageType)) {
    checks.push(naCheck(LABEL.openGraphDates, 4, pageType));
  } else {
    const hasArticleModified = /<meta[^>]+property=["']article:modified_time["'][^>]*>/i.test(html);
    const hasArticlePublished = /<meta[^>]+property=["']article:published_time["'][^>]*>/i.test(html);
    const hasOgFreshness = hasArticleModified || hasArticlePublished;
    checks.push({
      passed: hasOgFreshness,
      label: LABEL.openGraphDates, source: FRESHNESS_HEURISTIC,
      points: 4,
      detail: hasArticleModified
        ? "article:modified_time found"
        : hasArticlePublished
          ? "article:published_time found"
          : "No Open Graph article timestamp meta tags",
    });
  }

  return category("freshnesSignals", "FRESHNESS SIGNALS", checks);
}

export function scoreQueryOptimization(
  page: ParsedPage,
  schemas: readonly unknown[],
  pageType: PageKind,
): GeoCategory {
  const { html, readable } = page;
  const checks: GeoCheck[] = [];

  // Counted inside the page's own copy. It used to scan every `<h2>`/`<h3>` in the
  // markup, so a site-wide nav heading counted as this page asking a question —
  // the distinction `textsInContent` exists to draw.
  const qaHeadingCount = countQuestionHeadings(readable);
  const hasQaHeadings = qaHeadingCount >= 1;
  checks.push({
    passed: hasQaHeadings,
    // Merged from CONTENT CITABILITY, whose copy only matched a literal "?" for 3
    // more points. This test is a superset of it, so nothing newly fails.
    label: LABEL.questionHeadings, source: CITABILITY_HEURISTIC,
    points: 5,
    detail: `${qaHeadingCount} question-phrased heading(s) found`,
  });

  const hasSummary = hasSummarySection(html);
  // A TL;DR summarises a long read. A homepage has nothing to summarise.
  if (pageType === "homepage") {
    checks.push(naCheck(LABEL.tldr, 5, pageType));
  } else {
    checks.push({
      passed: hasSummary,
      label: LABEL.tldr, source: CITABILITY_HEURISTIC,
      points: 5,
      detail: hasSummary
        ? "Summary/TL;DR section detected (class/id contains tldr, summary, takeaway, or overview)"
        : "No summary or TL;DR section detected",
    });
  }

  const snippetPattern = /<h[1-6][^>]*>[\s\S]*?<\/h[1-6]>\s*<p[^>]*>([\s\S]*?)<\/p>/gi;
  let hasSnippetCandidate = false;
  let sm: RegExpExecArray | null;
  while ((sm = snippetPattern.exec(html)) !== null) {
    const paraText = sm[1].replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
    const wordCount = paraText.split(/\s+/).filter((w) => w.length > 0).length;
    if (wordCount >= 40 && wordCount <= 60) {
      hasSnippetCandidate = true;
      break;
    }
  }
  checks.push({
    passed: hasSnippetCandidate,
    label: "Featured snippet candidate paragraph (40-60 words after heading)", source: CITABILITY_HEURISTIC,
    points: 5,
    detail: hasSnippetCandidate
      ? "40-60 word paragraph immediately after a heading detected — featured snippet candidate"
      : "No 40-60 word paragraph immediately following a heading found",
  });

  const hasFaqSchema2 = !!findNodeInAll(schemas, ["FAQPage"]);
  const hasDisclosure = /<details[^>]*>[\s\S]*?<summary[^>]*>/i.test(html);
  const hasFaqDom2 = hasDisclosure || /<dt[^>]*>/i.test(html) || /(?:class|id)=["'][^"']*faq[^"']*["']/i.test(html);
  const hasFaq2 = hasFaqDom2;
  checks.push({
    passed: hasFaq2,
    // Merged from CONTENT STRUCTURE, which ran the identical DOM test for 4 more
    // points. Same predicate, so no page changes verdict — only the weight does.
    label: LABEL.qaPattern, source: CITABILITY_HEURISTIC,
    points: 5,
    detail: hasDisclosure
      ? "Semantic <details>/<summary> disclosure pattern detected"
      : hasFaqSchema2
        ? "FAQPage JSON-LD found (note: Google deprecated FAQ rich results May 2026)"
        : hasFaqDom2
          ? "FAQ DOM container detected"
          : "No Q&A pattern detected — consider <details>/<summary> with visible questions and answers",
  });

  return category("queryOptimization", "QUERY OPTIMIZATION", checks);
}

function scoreListicleFormatting(html: string): GeoCheck {
  const shape = listicleShape(html);
  const passed = isListicle(shape);
  const detailParts: string[] = [];
  if (shape.numberedHeading) detailParts.push("numbered heading (Top N / N best)");
  if (shape.orderedList) detailParts.push("ordered list with 3+ items");
  if (shape.comparisonTable) detailParts.push("table with 3+ rows");

  return {
    passed,
    label: LABEL.listicleFormatting, source: CITABILITY_HEURISTIC,
    points: 5,
    detail: passed
      ? `Listicle signals: ${detailParts.join(", ")}`
      : "No listicle formatting detected (no numbered headings, no <ol> ≥3 items, no table ≥3 rows)",
  };
}

export function buildRecommendations(categories: GeoCategory[]): string[] {
  const recs: string[] = [];
  // What an action may say, and what it may not.
  //
  // Every line here used to end in a claim about machinery nobody has published:
  // "cited 2× more by AI than generic prose", "increase AI citation rates ~2x",
  // "extracted at ~3× the rate of prose", "the sweet spot". No AI platform
  // releases citation rates, so those multipliers were not measurements of
  // anything — and Google's AI-optimization guide names the two techniques they
  // were selling ("divide content into small pieces", "write in a specific way
  // only for generative AI") among the things that are not necessary.
  //
  // So the rule is: an action may say what to change, and what becomes true of
  // the page once you do. It may not say what an engine does in response. The
  // three exceptions all earn it — a blocked crawler demonstrably cannot fetch
  // the page, Google publishes what `noindex` does, and the two Q&A lines cite a
  // study by name so the reader can go and disagree with it.
  const labelMap: Record<string, string> = {
    "FAQPage schema present": "FAQPage schema is optional — Google deprecated FAQ rich results May 2026 and Ahrefs' causal study found no AI citation lift (ahrefs.com/blog/schema-ai-citations). Prefer visible Q&A patterns (details/summary) over schema.",
    [LABEL.articleSchema]: "Add Article schema naming the author and both dates, so the page states who wrote it and when in a form a machine can read. The three fields are author, datePublished and dateModified",
    [LABEL.publishingEntityIdentity]: "Add sameAs to your Organization or Person schema, pointing at Wikipedia, Wikidata, LinkedIn or your other profiles — sameAs is how schema.org expresses \"this is the same entity as that\"",
    "3+ distinct schema types": "Describe more of the page in schema (WebPage, BreadcrumbList, Person) so its parts are machine-readable, not only its subject",
    [LABEL.personSchema]: "Add Person schema for authors, giving each one a job title or links to their profiles elsewhere. The two fields are jobTitle and sameAs",
    [LABEL.dateModified]: "Update the modified date in your schema, the dateModified field, whenever you revise the page. The 90 and 180-day windows are ours; Google publishes no freshness threshold",
    [LABEL.sitemapLastmod]: "Make the sitemap's lastmod agree with the modified date in your schema. Two different dates for one page means at least one of them is wrong",
    // No remediation for word count: the check no longer fails, and there is no
    // length at which Google considers a page deficient.
    "Page states its subject in an H1": "Add an H1 naming what this page is about — with no H1, nothing states the subject. The count does not matter; Google states heading order and number do not affect ranking.",
    [LABEL.qaPattern]: "Add a Q&A section in the page itself using semantic HTML (details/summary or dt/dd), not only in schema — per Ahrefs' 2026 causal study the schema alone produced no measurable lift (ahrefs.com/blog/schema-ai-citations)",
    "Lists ratio > 10% (structured content)": "Use lists (ul/ol) where the content is a list. A reader skimming finds the items; prose hides them",
    "Statistics & numerical data (%, $, ratios)": "Include the actual numbers behind your claims — a figure someone can check is worth more than an adjective",
    "GPTBot allowed in robots.txt": "Remove the GPTBot block from robots.txt if you want ChatGPT to be able to read this page — while it is blocked, it cannot fetch the page at all",
    "PerplexityBot allowed in robots.txt": "Remove the PerplexityBot block from robots.txt if you want Perplexity to be able to read this page",
    "ClaudeBot allowed in robots.txt": "Remove the ClaudeBot block from robots.txt if you want Claude to be able to read this page",
    "Google-Extended allowed in robots.txt": "Allow Google-Extended in robots.txt if you want the page usable by Gemini and grounding in AI Overviews. It does not affect Google Search ranking or indexing",
    "No nosnippet in meta robots or data-nosnippet": "Remove nosnippet if you want the page quoted — it tells Google not to show a text snippet for the page",
    "Named author (not generic Team/Admin/Staff)": "Credit a named person rather than \"Team\" or \"Admin\", so a reader can see who is accountable for the claims. Note Google states E-E-A-T is not itself a ranking factor",
    "Outbound links to .edu or .gov domains": "Link to the primary sources you relied on, wherever they live. Our check looks for .edu and .gov because they are easy to recognise, not because other sources count less",
    "Publishing entity with url + logo/image (Organization or Person)": "Add url plus logo (Organization) or image (Person) to your entity schema — Google lists both among the requirements for its own entity features",
    "HTTP 200 status code": "Fix the HTTP status. Google names an HTTP 200 as one of three technical requirements for a page to appear in Search at all",
    [LABEL.noindexAbsent]: "Remove the noindex directive — Google documents it as instructing search engines not to index the page",
    "Content visible in static HTML (not JS-only)": "Serve the main content in the HTML response rather than assembling it with JavaScript. Google renders JavaScript before indexing; whether a given AI crawler does is not documented by its operator, so static HTML is the safer assumption",
    // No remediation for llms.txt: the check no longer fails, and Google states
    // it does not read the file.
    "Definition patterns present (X is a…, refers to, means)": "Define your subject in a plain sentence near the top (\"X is a …\") — a definition is the one part of a page that stands on its own out of context",
    [LABEL.questionHeadings]: "Where a section answers a question your readers actually ask, let the heading be that question",
    "Answer-first structure (key info/stats in first 150 words)": "Answer the page's question in the opening paragraph instead of building up to it, so a reader who stops there still gets the answer",
    "Source attribution phrases (according to, study by, data from)": "Name the study, organisation or dataset behind each claim, so a reader can verify it without leaving to search for it",
    "Blockquote elements present": "Mark direct quotes with <blockquote> so the page distinguishes what you wrote from what you are quoting",
    "Reference links (nofollow external links or references section)": "Add a references section linking to the material you used",
    [LABEL.jsonLdDates]: "State both dates in your JSON-LD, using the datePublished and dateModified fields, so they are machine-readable rather than only printed on the page",
    "Last-Modified or ETag response header present": "Configure the server to send Last-Modified and ETag. Both are cache-validation headers; treating them as freshness evidence is our inference, not a documented signal",
    [LABEL.openGraphDates]: "Add Open Graph article:modified_time and article:published_time — these are what social and link previews read for dates",
    [LABEL.tldr]: "Add a summary near the top if the page is long enough to need one. Google states content does not need dividing into small pieces for AI, so this is for the reader who wants the short version",
    "Featured snippet candidate paragraph (40-60 words after heading)": "Follow each key heading with a paragraph that answers it completely on its own. We look for roughly 40-60 words as a proxy for \"a complete short answer\" — the number is ours, and writing to it is not the point",
    [LABEL.listicleFormatting]: "Use numbered lists or a comparison table where the content is genuinely a sequence or a comparison, and prose where it is not",
  };

  for (const cat of categories) {
    for (const check of cat.checks) {
      // `status` is checked explicitly rather than relying on `naCheck` setting
      // `passed: true`. Never advise a page to add something that does not apply
      // to it: that is how a homepage came to be told to add FAQPage schema and
      // Open Graph article timestamps. A `not-evaluated` check is skipped for a
      // different reason: we do not know whether it needs advice.
      if (check.status || check.passed) continue;
      if (labelMap[check.label]) recs.push(`• ${labelMap[check.label]}`);
    }
  }
  return recs.slice(0, 8);
}



/** What a Knowledge Graph entity is worth. Written once, and read by the render. */
export const KNOWLEDGE_GRAPH_POINTS = 5;

/**
 * The Knowledge Graph lookup as a scored check.
 *
 * ── Three cases, and why `null` is one of them ──
 *
 * - **No key configured.** `null`: the check does not exist. This is our
 *   deployment and not the site's business, so its ceiling is 0 and it is not
 *   "not applicable" either — a `not-applicable` would put the points into the
 *   report's "these do not apply to this page" sentence, which would be blaming
 *   the page for a variable the Operator did not set.
 * - **A key, and no answer.** `not-evaluated`: the points leave both sides and
 *   the run is reported as incomparable. Telling a brand with a Knowledge Panel
 *   to strengthen its entity signals because the API 503'd is exactly the failure
 *   to avoid.
 * - **An answer.** Scored.
 *
 * The three used to be three expressions at the call site, each writing the
 * number 5, with a fourth `+5 pts` in the render. One `Scorable` now, and `tally`
 * does the arithmetic — which is what `scored-checks.ts` exists for.
 */
export function knowledgeGraphCheck(
  lookup: KnowledgeGraphMatch,
  keyConfigured: boolean,
): Scorable | null {
  if (!keyConfigured) return null;
  if (lookup.found === null) {
    return {
      points: KNOWLEDGE_GRAPH_POINTS,
      passed: false,
      status: "not-evaluated",
      detail: notScored(
        lookup.reason ?? "the Knowledge Graph API did not answer on this run",
      ),
    };
  }
  return { points: KNOWLEDGE_GRAPH_POINTS, passed: lookup.found };
}

/** Everything the GEO reading needs, all of it already in hand. */
export interface GeoInput {
  /** The document, read once. Carries the URL, the schemas and the Page Identity. */
  page: ParsedPage;
  /** The raw markup, for the scorers that still match against it. */
  html: string;
  httpStatus: number;
  responseHeaders: Record<string, string>;
  /** What the site's robots.txt said, or why we do not know. */
  robotsRead: WellKnownRead;
  /** The sitemap that actually contains this page, resolved by the caller. */
  sitemapRead: WellKnownRead;
  /** Whether the site publishes an llms.txt. Worth 0 points, and says so. */
  llmsTxtExists: boolean;
  /** The brand's Knowledge Graph lookup, and whether a key was configured. */
  knowledgeGraph: { lookup: KnowledgeGraphMatch; keyConfigured: boolean };
}

/** The GEO reading of a page: every category, the score, and what to do about it. */
export interface GeoReading extends GeoScoreResult {
  /** The ten categories, in the order the report prints them. */
  categories: GeoCategory[];
  recommendations: string[];
  /** `null` when no key was configured, so the render can leave the line out. */
  knowledgeGraph: Scorable | null;
}

/**
 * Score a page that has already been read.
 *
 * ── Why this exists ──
 *
 * The GEO run was assembled in the Tool handler: ten `score*` calls, then
 * `applyListicleCheck` mutating a category built two lines earlier, then a
 * ten-element array, then three hand-written expressions for the Knowledge Graph
 * points, then `computeGeoScore`. Twelve exported steps a caller had to sequence
 * correctly, with the one ordering constraint among them expressed nowhere.
 *
 * `scoreEeat({ page, trustPages })` and the three `audit*` functions in the agent
 * tier already had this shape. This is the same move: which categories exist, in
 * which order, what each needs, and where the Knowledge Graph points sit are all
 * decisions this module owns. The handler is left with the fetches and the
 * printing.
 *
 * Pure, like everything else here. Every network answer arrives as data.
 *
 * The `score*` functions stay exported. They are an **internal seam**: this
 * module's own tests reach through them — `geo-analyzer.test.ts` is 1083 lines of
 * exactly that, and `no-answer-says-why.test.ts` walks two of them to check an
 * invariant across every check they build — and TypeScript has no way to say
 * "exported to the test file only". What changed is that no *caller* sequences
 * them any more.
 */
export function scoreGeo(input: GeoInput): GeoReading {
  const { page, html, httpStatus, responseHeaders, robotsRead, sitemapRead } = input;
  // The four scorers that read the page's *words* take the document, because
  // `html` and the reading of it are one thing — "a data clump wearing a
  // parameter list", as `parsed-page.ts` puts it about the signatures it fixed
  // elsewhere. The rest still take `html`: they match against markup structure,
  // where the raw string is the honest input.
  const { schemas } = page;
  const pageType = page.identity.kind;
  const schemaTypes = getSchemaTypes(schemas);

  const categories: GeoCategory[] = [
    scoreStructuredData(schemas, schemaTypes, pageType),
    scoreFreshness(schemas, sitemapRead, pageType, page.url),
    scoreContentStructure(page, pageType),
    scoreAiCrawlerAccess(robotsRead, html, input.llmsTxtExists),
    scoreAuthorEeat(html, schemas, pageType),
    scoreTechnical(page, httpStatus),
    scoreContentCitability(page, pageType),
    scoreCitationSignals(page, pageType),
    scoreFreshnessSignals(html, responseHeaders, pageType),
    scoreQueryOptimization(page, schemas, pageType),
  ];

  const knowledgeGraph = knowledgeGraphCheck(
    input.knowledgeGraph.lookup,
    input.knowledgeGraph.keyConfigured,
  );

  return {
    ...computeGeoScore(categories, { knowledgeGraph }),
    categories,
    recommendations: buildRecommendations(categories),
    knowledgeGraph,
  };
}
