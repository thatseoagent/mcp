/**
 * How old the page's content is, and what that is allowed to change.
 *
 * There are two date questions about a page and the codebase only answered one.
 * `isUndatedPage(pageKind)` in `page-identity` asks *"should this page have a
 * date at all"* — a pricing page with no `datePublished` is not a failure. This
 * module asks the other one: *"this page has a date, and it is three years
 * old"*. They are composed here, never merged: an undated **kind** has no age,
 * so `readContentAge` returns `unknown` for one rather than inventing a number.
 *
 * The point is severity. The same rule should not carry the same urgency on a
 * post published this morning and on one from 2022. New content has no excuse
 * for missing a field its own schema declares; erroring every post in a legacy
 * archive that predates the practice produces noise, not signal, and under
 * ADR-0031 that noise arrives in an email every cycle, forever.
 *
 * Three limits, and they are the load-bearing part:
 *
 * 1. **Age never touches a defect.** `agedSeverity` only ever moves `warning`
 *    down to `opportunity`. A missing title, a broken canonical, a noindex, a
 *    failing security header were wrong the day they shipped, and no amount of
 *    time makes them less wrong.
 *
 *    Only `critical` is safe *structurally*, by the first line of `agedSeverity`.
 *    The defects that sit at `warning` — a missing meta description, a D-graded
 *    security header — are held by a convention instead: `report-findings` calls
 *    `agedSeverity` at three sites and nowhere else, and
 *    `"leaves the defects at their severity on a legacy page"` in
 *    `tests/lib/utils/report-findings.test.ts` fails if a fourth appears on one
 *    of them. Said plainly because an overstated guarantee is worse than a
 *    stated convention: nothing in the type system stops the wrapping.
 * 2. **An unknown age is not a legacy one.** Every date source we have is
 *    frequently absent, and a downgrade on ignorance is a way to hide findings.
 *    `unknown` stays its own tier — it is not silently relabelled `new` — and
 *    `agedSeverity` simply declines to move it, which is the direction that
 *    keeps a finding visible.
 * 3. **The drop is never silent.** `legacyNote` gives the reader the sentence
 *    that explains the tier, so a dropped severity is an argument they can
 *    disagree with rather than a rank that quietly changed.
 */

import { flattenJsonLd } from "./json-ld-graph";
import { ARTICLE_TYPES, isUndatedPage, type PageKind } from "./page-identity";
import type { Severity } from "./seo-rules";

/**
 * New, legacy, or we do not know — and the third is not a shade of the second.
 *
 * Deliberately three values. A boolean would have to pick a side for the
 * undated case, and both sides are wrong: "legacy" hides findings on every page
 * that simply forgot to state a date, and "new" would be a claim we never
 * established. Naming the ignorance keeps the copy honest and lets
 * `agedSeverity` treat it as the safe direction on purpose rather than by
 * accident.
 */
export type AgeTier = "new" | "legacy" | "unknown";

/**
 * Past this, a page is legacy content: 18 months.
 *
 * Written down because the number is ours and has to be arguable. seodraft uses
 * 12 months for its `stale-post` rule, and we do not, for one reason: our own
 * freshness check already stops awarding any points at 180 days
 * (`geo-analyzer.scoreFreshness`). A 12-month threshold would sit six months
 * past the point where that check has already gone red, so nearly every page it
 * flags would arrive pre-downgraded and the tier would carry no information —
 * it would just be the freshness rule switching itself off.
 *
 * 18 months is one full annual review cycle plus six months of grace. A page
 * that has gone that long without being revisited is not a page someone forgot
 * last quarter; it is archive. 548 = 365 + 183.
 */
export const LEGACY_AFTER_DAYS = 548;

export interface ContentAge {
  tier: AgeTier;
  /** Days since publication, or `null` when nothing dated the page. */
  ageDays: number | null;
  /** Where the date came from, or why there is none. Rendered to the reader. */
  evidence: string;
}

/** The safe default: no age established, so nothing gets downgraded. */
export const UNDATED: ContentAge = {
  tier: "unknown",
  ageDays: null,
  evidence: "No publication date was found on this page",
};

/** A parsed date, or `null` for anything `Date` could not make sense of. */
function parseDate(value: unknown): number | null {
  if (typeof value !== "string" || !value.trim()) return null;
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? null : ms;
}

/**
 * The publication date and how we came by it.
 *
 * `datePublished` only. Never `dateModified`, for two reasons that point the
 * same way: a 2022 post refreshed last week is still a 2022 post, and the rule
 * most often downgraded here is *about* `dateModified` — sourcing the tier from
 * it would let a finding decide its own severity.
 */
function findPublishedAt(
  schemas: readonly unknown[],
  html: string
): { at: number; evidence: string } | null {
  // `flattenJsonLd`, not a loop over `schemas`. `extractJsonLd` returns
  // *payloads*, and Yoast, Rank Math and most WordPress SEO plugins ship one
  // `@graph` wrapper holding every node — so a top-level scan reads the wrapper,
  // which declares no `datePublished`, and every such page came back `unknown`.
  // That fails in the safe direction and is still the feature being inert on a
  // large share of the sites we audit.
  const nodes = flattenJsonLd(schemas as unknown);

  // An article's own date first. A `@graph` also carries `WebPage`, `WebSite`
  // and `Person` nodes, and the one that dates *this content* is the article.
  const isArticle = (n: Record<string, unknown>) => {
    const t = n["@type"];
    const types = Array.isArray(t) ? t.map(String) : [String(t)];
    return types.some((x) => ARTICLE_TYPES.includes(x));
  };
  // Typed nodes first, article-typed before the rest; then the raw payloads.
  // `flattenJsonLd` returns only nodes that declare a `@type`, which is its
  // documented rule and the right one — an `@graph` wrapper is not a node. The
  // last pass keeps a typeless top-level object with a date readable rather than
  // narrowing what we used to accept.
  const candidates = [
    ...nodes.filter(isArticle),
    ...nodes.filter((n) => !isArticle(n)),
    ...schemas.filter((s): s is Record<string, unknown> => typeof s === "object" && s !== null),
  ];
  for (const node of candidates) {
    const at = parseDate(node.datePublished);
    if (at !== null) return { at, evidence: "datePublished in the page's JSON-LD" };
  }

  const meta = html.match(
    /<meta[^>]+property=["']article:published_time["'][^>]*content=["']([^"']+)["']/i
  ) ?? html.match(
    /<meta[^>]+content=["']([^"']+)["'][^>]*property=["']article:published_time["']/i
  );
  const fromMeta = parseDate(meta?.[1]);
  if (fromMeta !== null) return { at: fromMeta, evidence: "the article:published_time meta tag" };

  // A visible byline date, but only one that says which date it is. A bare
  // `<time datetime>` is as likely to be an event date or a comment timestamp.
  const timeEl = html.match(
    /<time[^>]*(?:itemprop=["']datePublished["']|\bpubdate\b)[^>]*datetime=["']([^"']+)["']/i
  ) ?? html.match(
    /<time[^>]*datetime=["']([^"']+)["'][^>]*(?:itemprop=["']datePublished["']|\bpubdate\b)/i
  );
  const fromTime = parseDate(timeEl?.[1]);
  if (fromTime !== null) return { at: fromTime, evidence: "a visible <time> element marked as the publication date" };

  return null;
}

/**
 * Rounded to whole years or months, for a sentence a reader can hear.
 *
 * Exported because the report says this out loud too. `evidence` stays exact —
 * "Published 1673 days ago" is the right precision for the MCP text output,
 * which an agent reads — but a client opening a shared report met that number
 * and had to divide. Two audiences, one measurement, and the rounding lives
 * here rather than in a component.
 */
function spellAge(ageDays: number): string {
  if (ageDays >= 365) {
    const years = Math.round(ageDays / 365);
    return years === 1 ? "about a year" : `about ${years} years`;
  }
  const months = Math.max(1, Math.round(ageDays / 30));
  return months === 1 ? "about a month" : `about ${months} months`;
}

/**
 * How old this page's content is.
 *
 * `pageKind` first: a homepage, a pricing page or a collection is not published
 * on a date, so it has no age to read even when some node in its JSON-LD
 * happens to carry one. That is `isUndatedPage`'s question, asked here so the
 * two are composed in one place instead of each analyzer deciding again.
 */
export function readContentAge(
  schemas: readonly unknown[],
  html: string,
  pageKind: PageKind,
  now: number = Date.now()
): ContentAge {
  if (isUndatedPage(pageKind)) {
    return {
      tier: "unknown",
      ageDays: null,
      evidence: `A ${pageKind} page is not published on a date, so it has no content age`,
    };
  }

  const found = findPublishedAt(schemas, html);
  if (!found) return UNDATED;

  // A future date is not an age. Floored at zero rather than reported negative:
  // whatever it is, it is certainly not legacy.
  const ageDays = Math.max(0, Math.floor((now - found.at) / 86_400_000));
  return {
    tier: ageDays >= LEGACY_AFTER_DAYS ? "legacy" : "new",
    ageDays,
    evidence: `Published ${ageDays} days ago, per ${found.evidence}`,
  };
}

/**
 * The severity this finding carries once the page's age is taken into account.
 *
 * One transition, in one direction: `warning` → `opportunity`, on legacy content
 * only. `critical` is untouchable — age is an excuse for not having adopted a
 * newer standard, and it is never an excuse for a defect. Nothing is ever
 * upgraded, so a caller cannot use this to make a finding louder.
 */
export function agedSeverity(base: Severity, age: ContentAge | undefined): Severity {
  if (base !== "warning") return base;
  return age?.tier === "legacy" ? "opportunity" : base;
}

/**
 * The sentence that explains a downgrade, or `""` when there was none.
 *
 * Appended to a finding's `why` rather than replacing it: the reader still needs
 * to know what is missing, and then why it is being reported quietly. A tier
 * that moved without saying so is indistinguishable from a rule we changed our
 * minds about.
 */
export function legacyNote(age: ContentAge | undefined): string {
  if (age?.tier !== "legacy" || age.ageDays === null) return "";
  return `This page was published ${spellAge(age.ageDays)} ago, so it predates the practice rather than ignoring it — a refresh here is an opportunity, not a repair.`;
}
