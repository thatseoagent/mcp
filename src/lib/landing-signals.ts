/**
 * The page signals `site_ai_landing_signals` compares, read off one page.
 *
 * ── Detection borrowed, scoring left behind ──
 *
 * Every predicate here is somebody else's. The Content Signals come from
 * `analyzers/content-signals.ts`, which `CONTEXT.md` names as the one place they
 * are detected; structured data from `json-ld-graph.ts`; the word count from
 * `text-analyzer.ts`, through the same `mainContent()` `seo_geo_score` counts.
 * What is deliberately not borrowed is `geo-analyzer`'s scoring: its points,
 * its page-kind exemptions and its thresholds answer "how well is this page set
 * up to be cited?", and the question here is only "is this present?" — asked of
 * two groups of pages so the answers can be set side by side.
 *
 * That is also why a homepage is not excused from anything. `geo-analyzer` marks
 * a homepage N/A for statistics and definitions because it should not be
 * *charged* for lacking them; nothing is charged here, and a homepage that AI
 * assistants send people to either has the signal or does not.
 *
 * ── Three answers, not two ──
 *
 * A signal is `true`, `false` or `null`. `null` means the question could not be
 * asked of this page — a definition in a language `answer-patterns` cannot read,
 * or the age of a page that states no date — and a caller must take it out of
 * that signal's denominator rather than count it as a no. It is the same third
 * state `scored-checks.ts` keeps, for the same reason.
 */
import type { ParsedPage } from "./analyzers/parsed-page";
import {
  arrivedInStaticHtml,
  countQuestionHeadings,
  definesSomething,
  hasSummarySection,
  isListicle,
  listicleShape,
  statesAStatistic,
} from "./analyzers/content-signals";
import { flattenJsonLd } from "./analyzers/json-ld-graph";
import { countWords } from "./text-analyzer";

export type SignalKey =
  | "structuredData"
  | "questionHeadings"
  | "statedFigure"
  | "summaryBlock"
  | "listicle"
  | "definition"
  | "dated"
  | "recent"
  | "staticCopy";

/**
 * Each signal, how it is labelled, and what a `null` for it means.
 *
 * In the order a reader should meet them: the Content Signals first, then the
 * structural and freshness ones.
 */
export const SIGNALS: ReadonlyArray<{
  key: SignalKey;
  label: string;
  /** For the per-page line, where the full label would not fit. */
  short: string;
  unanswered?: string;
}> = [
  { key: "statedFigure", label: "States a figure (%, $, N out of M, millions)", short: "figure" },
  { key: "questionHeadings", label: "Question-phrased H2/H3", short: "question heading" },
  { key: "summaryBlock", label: "Marked-up summary / TL;DR block", short: "summary block" },
  {
    key: "listicle",
    label: "List formatting (numbered heading, 3+ item list, table)",
    short: "list formatting",
  },
  {
    key: "definition",
    label: "Definitional phrasing (X is a…, refers to)",
    short: "definition",
    unanswered: "pages in a language we cannot read definitions in",
  },
  { key: "structuredData", label: "Structured data (JSON-LD)", short: "JSON-LD" },
  { key: "dated", label: "Machine-readable date (JSON-LD or article:* meta)", short: "dated" },
  {
    key: "recent",
    label: "Dated within the last 12 months",
    short: "dated in last 12 months",
    unanswered: "pages that state no date",
  },
  { key: "staticCopy", label: "Copy arrives in the HTML (not JavaScript-only)", short: "static copy" },
];

/**
 * How recent a date has to be to count as recent: a year.
 *
 * Ours, and written down so it can be argued with. `geo-analyzer`'s freshness
 * check stops awarding points at 180 days, which is a claim about what a scorer
 * should reward; this is a coarser question — has anyone touched the page in
 * the last annual cycle? — and a tighter line would split two groups of eight
 * pages on noise.
 */
const RECENT_DAYS = 365;

export interface LandingSignals {
  signals: Record<SignalKey, boolean | null>;
  wordCount: number;
  /** Days since the most recent date the page states, or `null`. */
  ageDays: number | null;
}

function parseDate(value: unknown): number | null {
  if (typeof value !== "string" || !value.trim()) return null;
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? null : ms;
}

/**
 * The most recent date the page states about itself, in ms.
 *
 * Modified or published, whichever is later: the question is whether the page
 * has been touched, not how old the content is — which is `content-age.ts`'s
 * question, and why it reads `datePublished` alone. `flattenJsonLd` so a Yoast
 * `@graph` is read into, which is the mistake `content-age.ts` records making.
 */
function latestStatedDate(page: ParsedPage): number | null {
  const found: number[] = [];
  for (const node of flattenJsonLd(page.schemas as unknown)) {
    for (const field of ["dateModified", "datePublished"]) {
      const at = parseDate(node[field]);
      if (at !== null) found.push(at);
    }
  }
  // Both attribute orders, the way `content-age.ts` reads the same tags.
  const meta =
    /<meta[^>]+property=["']article:(?:modified|published)_time["'][^>]*content=["']([^"']+)["']/gi;
  const metaReversed =
    /<meta[^>]+content=["']([^"']+)["'][^>]*property=["']article:(?:modified|published)_time["']/gi;
  for (const pattern of [meta, metaReversed]) {
    for (const match of page.html.matchAll(pattern)) {
      const at = parseDate(match[1]);
      if (at !== null) found.push(at);
    }
  }
  return found.length > 0 ? Math.max(...found) : null;
}

/** Every signal this Tool compares, for one readable page. */
export function readLandingSignals(page: ParsedPage, now: number = Date.now()): LandingSignals {
  const text = page.readable.mainContent();
  const defines = definesSomething(text, page.language);
  const latest = latestStatedDate(page);
  // A future date is not an age; floored at zero, as `content-age.ts` does.
  const ageDays = latest === null ? null : Math.max(0, Math.floor((now - latest) / 86_400_000));

  return {
    signals: {
      structuredData: page.schemas.length > 0,
      questionHeadings: countQuestionHeadings(page.readable) > 0,
      statedFigure: statesAStatistic(text),
      summaryBlock: hasSummarySection(page.html),
      listicle: isListicle(listicleShape(page.html)),
      definition: defines.outcome === "answered" ? defines.defines : null,
      dated: latest !== null,
      recent: ageDays === null ? null : ageDays <= RECENT_DAYS,
      staticCopy: arrivedInStaticHtml(page.readable),
    },
    wordCount: countWords(text),
    ageDays,
  };
}
