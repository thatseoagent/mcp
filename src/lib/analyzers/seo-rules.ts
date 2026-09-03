/**
 * The rules a page is judged against, stated once.
 *
 * Two modules used to state each of these. `onpage-seo` held the threshold and a
 * line written for a practitioner; `report-findings` held its own copy of the
 * threshold, a severity, and a line written for the site's owner. Nothing linked
 * them, so when the analyzers were corrected against Google Search Central the
 * report kept every old rule — a client opening a shared link still read
 * "60 or fewer" and "Exactly one H1" long after we had documented that Google
 * says neither.
 *
 * The two audiences are real and stay separate: a practitioner wants "Title is
 * 84 characters and may be truncated", an owner wants "Page title may be cut
 * short in results" with a reason it costs them something. What was never real
 * was the two copies of *the rule itself* underneath them.
 *
 * So a rule owns its threshold, its severity, its `CheckSource` and both
 * wordings, and it is the only thing that can decide whether it fires. Callers
 * receive verdicts, never measurements, which is what makes a hardcoded
 * threshold somewhere else impossible rather than merely discouraged: there is
 * no number here to copy and no comparison to re-implement.
 *
 * Modelled on `vital-thresholds.ts`, which already does this for Core Web Vitals
 * and is the one block of `report-findings` that never went stale.
 *
 * Not to be called a Check. `GeoCheck` and `AiVisibilityCheck` carry points that
 * sum into a score; an SEO Rule carries a verdict. See
 * `docs/domain/flagged-ambiguities.md`.
 */

import { annotate, GOOGLE_SAYS, HEADING_ACCESSIBILITY, type CheckSource } from "./check-source";

/**
 * What the reader should do about a finding, in the order they should care.
 *
 * Fixed by `docs/domain/scoring-and-severity.md`: `critical` costs the site
 * traffic it already has, `warning` costs traffic it could have, and
 * `opportunity` is worth knowing with nothing breaking if it waits. Do not coin
 * a fourth or a synonym — `info` was one, and it meant two different things in
 * two analyzers.
 *
 * Lives here rather than in `report-findings` because a rule states its own
 * severity, and the report may not import back into the analyzers.
 * `report-findings` re-exports it so existing imports keep working.
 */
export type Severity = "critical" | "warning" | "opportunity";

export type RuleId =
  | "title-missing"
  | "title-long"
  | "description-missing"
  | "description-long"
  | "h1-missing"
  | "h1-multiple"
  | "canonical-missing"
  | "viewport-missing"
  | "lang-missing"
  | "images-alt";

/**
 * Everything the rules need to judge a page, and nothing else.
 *
 * Deliberately not `OnPageSection`: a rule should not be able to reach for a
 * field nobody decided it could use, and the analyzer needs to evaluate before
 * a section exists. Both sides build this — the analyzer from what it just
 * parsed, the report from what was stored.
 */
export interface PageFacts {
  titleLength: number;
  descriptionLength: number;
  h1Count: number;
  canonical: string | null;
  viewport: string | null;
  lang: string | null;
  imagesTotal: number;
  imagesMissingAlt: number;
}

/** How a rule reads to the site's owner, or `null` when it is not their problem. */
type ReaderCopy = {
  severity: Severity;
  title: string;
  why: string;
  target?: string;
} | null;

interface SeoRule {
  id: RuleId;
  /** Google's words, our judgement, or an accessibility standard. */
  source: CheckSource;
  fires: (f: PageFacts) => boolean;
  /** The measured value, when quoting it helps. */
  value?: (f: PageFacts) => string;
  /** The practitioner's line, before provenance is stamped on. */
  practitioner: (f: PageFacts) => string;
  /**
   * The owner's version. `null` means the rule is real but is not a task for
   * them — Google says the thing it describes is fine — so it reaches the
   * practitioner channel and stops there.
   */
  reader: ReaderCopy | ((f: PageFacts) => ReaderCopy);
  /**
   * This rule claims something is *absent* from the page body, so it is only
   * trustworthy if we saw the page the way Google does.
   *
   * We read the HTML as served; Google renders JavaScript first. On a page whose
   * content arrives by script, "no H1" means "no H1 in the bytes we were given",
   * which is not the claim the report makes. Absence is the problem: a rule that
   * reports something it *found* is fine either way, because we did find it.
   *
   * Head metadata is served statically even on a single-page app, so title,
   * description, canonical, viewport and lang are not marked.
   */
  needsRenderedContent?: boolean;
}

/**
 * Lengths past which a title or description usually does not survive to the
 * result page.
 *
 * Observations about rendering, not rules. Google publishes no limit for either
 * and truncates by device width, so the honest thing to say is "this may not be
 * shown in full" — never "too long". They sit well above the old 60/160
 * verdicts on purpose: the point is to catch the title that is certainly losing
 * its ending, not to police one that is thirty characters long and perfectly
 * good.
 */
export const TITLE_LIKELY_TRUNCATED = 70;
export const DESCRIPTION_LIKELY_TRUNCATED = 165;

const RULES: SeoRule[] = [
  {
    id: "title-missing",
    source: GOOGLE_SAYS.titleTruncatedByWidth,
    fires: (f) => f.titleLength === 0,
    practitioner: () => "Missing <title> tag",
    reader: {
      severity: "critical",
      title: "No page title",
      why: "The title is the headline of your search result. Without one, Google writes its own.",
      target: "A title describing the page",
    },
  },
  {
    id: "title-long",
    source: GOOGLE_SAYS.titleTruncatedByWidth,
    fires: (f) => f.titleLength > TITLE_LIKELY_TRUNCATED,
    value: (f) => `${f.titleLength} chars`,
    practitioner: (f) =>
      `Title is ${f.titleLength} characters and may be truncated in results — Google truncates to fit the device width, not to a character count`,
    reader: {
      severity: "opportunity",
      title: "Page title may be cut short in results",
      why: "Google trims the title to fit the device it is shown on, so a long one risks losing its ending on a phone.",
    },
  },
  {
    id: "description-missing",
    source: GOOGLE_SAYS.descriptionsMustBeUnique,
    fires: (f) => f.descriptionLength === 0,
    practitioner: () => "Missing meta description",
    reader: {
      severity: "warning",
      title: "No meta description",
      why: "This is the sales copy under your search result. Leave it empty and Google pulls an arbitrary sentence from the page.",
      target: "A unique description for this page",
    },
  },
  {
    id: "description-long",
    source: GOOGLE_SAYS.descriptionHasNoLimit,
    fires: (f) => f.descriptionLength > DESCRIPTION_LIKELY_TRUNCATED,
    value: (f) => `${f.descriptionLength} chars`,
    practitioner: (f) =>
      `Meta description is ${f.descriptionLength} characters and will likely be truncated in results`,
    // Truncation costs the owner nothing they can act on beyond rewriting, and
    // Google composes the snippet from the page as often as from this tag.
    reader: null,
  },
  {
    id: "h1-missing",
    source: {
      kind: "heuristic",
      rationale:
        "Google states no H1 requirement, but a page with no main heading has not stated its subject anywhere an extractor can find it",
    },
    fires: (f) => f.h1Count === 0,
    // The one on-page rule that claims a body element is absent.
    needsRenderedContent: true,
    practitioner: () => "Missing H1 heading",
    reader: {
      severity: "critical",
      title: "No H1 heading",
      why: "The H1 is the clearest statement of what a page is about, for both readers and crawlers.",
      target: "One H1 naming the subject",
    },
  },
  {
    id: "h1-multiple",
    source: HEADING_ACCESSIBILITY,
    fires: (f) => f.h1Count > 1,
    value: (f) => String(f.h1Count),
    practitioner: (f) => `Multiple H1 headings found (${f.h1Count})`,
    // Google: heading order and count do not affect ranking. It matters to
    // someone navigating by headings, which is not a search finding.
    reader: null,
  },
  {
    id: "canonical-missing",
    source: GOOGLE_SAYS.canonicalNotRequired,
    fires: (f) => !f.canonical,
    practitioner: () =>
      "No canonical URL specified — Google will choose one for you; set it explicitly only if this page has duplicates",
    // Google: "none of them are required; your site will likely do just fine
    // without specifying a canonical preference." A correctly built page is not
    // a task.
    reader: null,
  },
  {
    id: "viewport-missing",
    source: {
      kind: "heuristic",
      rationale:
        "Google indexes mobile-first; without a viewport the page is rendered at desktop width on a phone",
    },
    fires: (f) => !f.viewport,
    practitioner: () => "Missing viewport meta tag",
    reader: {
      severity: "critical",
      title: "No mobile viewport tag",
      why: "Google indexes the mobile version of your site, and without this the page is rendered at desktop width on a phone.",
      target: "width=device-width",
    },
  },
  {
    id: "lang-missing",
    source: {
      kind: "accessibility",
      standard: "WCAG 2.2 §3.1.1 Language of Page",
      seoImpact: "Google infers language from content; the attribute helps translation and screen readers",
    },
    fires: (f) => !f.lang,
    practitioner: () => "Missing lang attribute on <html> tag",
    reader: {
      severity: "opportunity",
      title: "No language declared",
      why: "Screen readers and translation tools use this to pick the right voice and dictionary.",
      target: "A lang attribute on <html>",
    },
  },
  {
    id: "images-alt",
    source: {
      kind: "google",
      doc: "https://developers.google.com/search/docs/appearance/google-images",
      quote:
        "Google uses alt text along with computer vision algorithms and the contents of the page to understand the subject matter of the image.",
    },
    fires: (f) => f.imagesMissingAlt > 0,
    value: (f) => String(f.imagesMissingAlt),
    practitioner: (f) => `${f.imagesMissingAlt} image(s) missing alt attribute`,
    reader: (f) => ({
      severity: "warning",
      title: `${f.imagesMissingAlt} of ${f.imagesTotal} images have no alt text`,
      why: "Alt text is how Google reads an image, and how anyone using a screen reader does.",
      target: "0",
    }),
  },
];

/** A rule that fired, holding the facts it fired on. */
export interface RuleVerdict {
  id: RuleId;
  rule: SeoRule;
  facts: PageFacts;
}

/**
 * Every rule that fires for this page, in declaration order.
 *
 * The only way to learn whether a page has a problem. Callers get verdicts, not
 * measurements, so no caller is in a position to invent a threshold of its own.
 */
export function evaluatePage(facts: PageFacts): RuleVerdict[] {
  return RULES.filter((rule) => rule.fires(facts)).map((rule) => ({
    id: rule.id,
    rule,
    facts,
  }));
}

/** The practitioner's line, with its provenance stamped on. */
export function asIssueLine(verdict: RuleVerdict): string {
  return annotate(verdict.rule.practitioner(verdict.facts), verdict.rule.source);
}

/**
 * The owner's version, or `null` when the rule is not their problem.
 *
 * `section` comes from the caller because where a finding is filed is the
 * report's business, not the rule's.
 */
export function asFinding<S extends string>(
  verdict: RuleVerdict,
  section: S
): {
  id: RuleId;
  severity: Severity;
  title: string;
  why: string;
  section: S;
  value?: string;
  target?: string;
} | null {
  const { rule, facts } = verdict;
  const copy = typeof rule.reader === "function" ? rule.reader(facts) : rule.reader;
  if (!copy) return null;

  const value = rule.value?.(facts);
  return {
    id: rule.id,
    severity: copy.severity,
    title: copy.title,
    why: copy.why,
    section,
    ...(value !== undefined ? { value } : {}),
    ...(copy.target !== undefined ? { target: copy.target } : {}),
  };
}

/** Every rule id, for tests that assert nothing states a rule twice. */
export const ALL_RULE_IDS: readonly RuleId[] = RULES.map((r) => r.id);

/**
 * Would this verdict be a guess on a page we could not read?
 *
 * Callers that know the page's content arrived by JavaScript drop these rather
 * than report them, because on such a page the rule answered a question about
 * the bytes we were served and not about the page Google indexes.
 */
export function needsRenderedContent(verdict: RuleVerdict): boolean {
  return verdict.rule.needsRenderedContent === true;
}
