import { z } from "zod";
import { type ToolMetadata, type InferSchema } from "xmcp";
import { defineGoogleTool } from "../lib/define-tool";
import { DEFAULT_DAYS, ga4PropertySchema, ga4Window } from "../lib/google/ga4-tool-shape";
import {
  aiReferred,
  organicLandings,
  REFERRER_ONLY_CAVEAT,
} from "../lib/google/traffic-segments";
import type { GoogleReader } from "../lib/google/reader";
import { readPages } from "../lib/google/busiest-pages";
import { readLandingSignals, SIGNALS, type LandingSignals, type SignalKey } from "../lib/landing-signals";
import { landingUrl, siteOrigin, urlKey } from "../lib/url-match";
import { domainFromUrl } from "../lib/with-cache";
import { toolText } from "../lib/tool-result";
import { capped } from "../lib/render-list";
import { basisSection, notCheckedSection } from "../lib/render-basis";

export const schema = {
  ...ga4PropertySchema,
  site: z
    .string()
    .describe(
      "The site this GA4 property measures: `example.com` or `https://www.example.com`. " +
        "GA4 reports landing pages as paths, and they are fetched from this origin.",
    ),
  days: z
    .number()
    .int()
    .min(7)
    .max(90)
    .optional()
    .describe("Lookback window in days. Default 28."),
  pages: z
    .number()
    .int()
    .min(3)
    .max(15)
    .optional()
    .describe(
      "How many pages in each group: the top AI landing pages, and as many organic-only " +
        "pages to compare them with. Default 8.",
    ),
};

export const metadata: ToolMetadata = {
  name: "site_ai_landing_signals",
  description:
    "What do the pages AI assistants send people to have in common? Takes the top AI-referred " +
    "landing pages from GA4 and the busiest Google organic-search pages that got no AI referrals, " +
    "fetches both, and sets the Content Signals and GEO signals side by side — stated figures, " +
    "question headings, summary blocks, lists, definitions, structured data, dates, word count. " +
    "A directional comparison over a small sample, not a measurement of what AI systems prefer. " +
    "Needs the Google login; without it this Tool says so.",
  annotations: {
    title: "Compare AI landing pages with organic-only pages",
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: true,
  },
};

/** Completes the sentence "Could not …" for every failure this Tool can return. */
const FAILURE_CONTEXT = "compare the pages AI assistants send people to with the rest of the site";

const DEFAULT_PAGES = 8;

/**
 * How many Google organic landing pages to read before picking the comparison set.
 *
 * Enough that, after dropping every page with any AI referral, there are still
 * `pages` left on any site worth comparing. `organicLandings` orders by sessions
 * in the query, so the ones kept are the busiest.
 */
const ORGANIC_ROW_LIMIT = 1_000;

/**
 * The fewest checked pages in a group before a difference is read out.
 *
 * Below this a single page is a third of the group, and "67% against 33%" is one
 * page against another. The prevalence is still printed; the difference is not
 * called one.
 */
const MIN_GROUP_FOR_DIFFERENCE = 3;

/**
 * The gap, in percentage points, at which a difference is listed.
 *
 * This Tool's own line for "worth a look", not a significance test — on two
 * groups of eight nothing short of a large gap is distinguishable from chance,
 * and the output says so beside the list.
 */
const NOTABLE_GAP_POINTS = 25;

/** How many rows of either group's page list to print. */
const MAX_LISTED = 15;

type Group = "ai" | "comparison";

type Checked =
  | { path: string; group: Group; sessions: number; ok: true; reading: LandingSignals }
  | { path: string; group: Group; sessions: number; ok: false; reason: string };

/** A page on the site, as GA4's landing rows name it. */
interface Landing {
  /** As GA4 wrote it, on the page's busiest row. */
  path: string;
  /** Where it is fetched from. */
  url: string;
  sessions: number;
}

/**
 * GA4 landing pages as pages on the site.
 *
 * One page per `urlKey`, so `/guide` and `/guide/` — two GA4 rows — are one page
 * in one group, rather than a page that is somehow in both. The rows arrive
 * busiest first, so the spelling kept is the busiest row's. Sessions GA4 could
 * not place never reach here: `traffic-segments.ts` counts them apart.
 */
function landingPages(
  rows: Iterable<{ page: string; sessions: number }>,
  origin: string,
): Map<string, Landing> {
  const pages = new Map<string, Landing>();
  for (const { page, sessions } of rows) {
    const url = landingUrl(origin, page);
    const key = url === null ? null : urlKey(url);
    if (url === null || key === null) continue;
    const known = pages.get(key);
    if (known) known.sessions += sessions;
    else pages.set(key, { path: page, url, sessions });
  }
  return pages;
}

function percentOf(count: number, total: number): number {
  return total === 0 ? 0 : Math.round((count / total) * 100);
}

/**
 * `5 of 7 (71%)`, or why there is no fraction.
 *
 * Two different empties. A group with no page read was not checked at all; a
 * group whose pages were read but could not be asked this one question — none of
 * them states a date, so none has an age — is `n/a`, and saying "not checked"
 * there would send the reader looking for a fetch that did not fail.
 */
function describeShare(count: number, total: number, groupRead: number): string {
  if (groupRead === 0) return "not checked";
  if (total === 0) return "n/a";
  return `${count} of ${total} (${percentOf(count, total)}%)`;
}

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? Math.round((sorted[middle - 1] + sorted[middle]) / 2)
    : sorted[middle];
}

export async function handler(
  { propertyId, site, days, pages }: InferSchema<typeof schema>,
  google: GoogleReader,
) {
  const span = days ?? DEFAULT_DAYS;
  const perGroup = pages ?? DEFAULT_PAGES;
  const origin = siteOrigin(site);
  const window = ga4Window({ propertyId, days: span }, {
    title: `AI LANDING PAGES AGAINST ORGANIC-ONLY PAGES (last ${span} days)`,
  });

  // Both reads before any page is fetched. A refusal from Google is the whole
  // answer; fetching sixteen pages and then failing would have spent a stranger's
  // bandwidth on a report nobody gets.
  const [ai, organic] = await Promise.all([
    aiReferred(google, window, { byLanding: true }),
    organicLandings(google, window, { limit: ORGANIC_ROW_LIMIT }),
  ]);

  const aiLandings = ai.landings ?? { pages: [], unattributed: 0 };
  const aiByPage = landingPages(aiLandings.pages, origin);
  const aiUnattributed = aiLandings.unattributed;
  const organicByPage = landingPages(
    organic.pages.map((row) => ({ page: row.landingPage, sessions: row.sessions })),
    origin,
  );

  const lines: string[] = [...window.header];
  lines.push(`Site: ${origin} (GA4 reports landing pages as paths; they were fetched from here)`);

  // Both reads' caveats, which `basisSection` prints once each: the two reads
  // are of one property and often draw the same sentence from Google.
  const basis = basisSection({ read: [], caveats: [...ai.caveats, ...organic.caveats] });

  if (aiByPage.size === 0) {
    lines.push("");
    lines.push("No AI-referred landing pages in this window, so there is nothing to compare.");
    lines.push("");
    lines.push('GA4 put no session with a landing page in its "AI Assistant" channel, and no');
    lines.push("referral arrived from a host on the supplementary list ga4_ai_traffic keeps.");
    if (aiUnattributed > 0) {
      lines.push(
        `${Math.round(aiUnattributed)} AI-referred session(s) had no landing page GA4 could name.`,
      );
    }
    lines.push("No page was fetched.");
    lines.push("");
    lines.push("That is a measurement of referred visits, not a verdict on the site.");
    lines.push(...REFERRER_ONLY_CAVEAT);
    lines.push(...basis);
    return toolText(lines.join("\n"));
  }

  const aiRanked = [...aiByPage.values()].sort((a, b) => b.sessions - a.sessions);
  const aiPicked = aiRanked.slice(0, perGroup);
  const comparisonPool = [...organicByPage.entries()]
    .filter(([key]) => !aiByPage.has(key))
    .map(([, page]) => page)
    .sort((a, b) => b.sessions - a.sessions);
  const comparisonPicked = comparisonPool.slice(0, perGroup);

  // Through the shared page reader, a few at a time: a robots refusal or an
  // unreachable page is that page's "not checked", and our own pacing budget
  // is the whole answer and travels to the seam. It was an unbounded
  // `Promise.all` over up to thirty pages of somebody else's site.
  const picked = [
    ...aiPicked.map((page) => ({ ...page, group: "ai" as const })),
    ...comparisonPicked.map((page) => ({ ...page, group: "comparison" as const })),
  ];
  const pagesRead = await readPages(picked.map((entry) => entry.url));
  const results: Checked[] = picked.map(({ path, sessions, group }, index) => {
    const site = pagesRead[index];
    return site.ok
      ? { path, sessions, group, ok: true, reading: readLandingSignals(site.page) }
      : { path, sessions, group, ok: false, reason: site.reason };
  });
  const read = (group: Group) =>
    results.filter((r): r is Extract<Checked, { ok: true }> => r.ok && r.group === group);
  const aiRead = read("ai");
  const comparisonRead = read("comparison");
  const notChecked = results.filter((r): r is Extract<Checked, { ok: false }> => !r.ok);

  lines.push("");
  lines.push("=== THE TWO GROUPS ===");
  lines.push(
    `AI landing pages: the top ${aiPicked.length} by AI-referred sessions, of ${aiRanked.length} ` +
      "that received any.",
  );
  lines.push(
    ...capped(
      aiPicked.map(({ path, sessions }) => `${path} — ${Math.round(sessions)} AI-referred sessions`),
      MAX_LISTED,
      { noun: "pages" },
    ),
  );
  if (aiUnattributed > 0) {
    lines.push(
      `  (${Math.round(aiUnattributed)} AI-referred session(s) had no landing page GA4 could name ` +
        "and are in no group.)",
    );
  }

  lines.push("");
  if (comparisonPicked.length === 0) {
    lines.push(
      "Comparison: none. No page had Google organic sessions without also having an " +
        "AI-referred one, so there is nothing to set the AI pages against.",
    );
  } else {
    lines.push(
      `Comparison: the ${comparisonPicked.length} pages with the most Google organic sessions ` +
        "and no AI-referred session in the window.",
    );
    lines.push(
      ...capped(
        comparisonPicked.map(({ path, sessions }) => `${path} — ${Math.round(sessions)} Google organic sessions`),
        MAX_LISTED,
        { noun: "pages" },
      ),
    );
  }

  lines.push(
    ...notCheckedSection(
      notChecked.map((page) => ({
        subject: `${page.path} (${page.group === "ai" ? "AI group" : "comparison group"})`,
        reason: page.reason,
      })),
      {
        noun: "pages",
        // Listed in full, as they always were: at most every page picked, and
        // each is a hole in a denominator the reader should be able to name.
        cap: picked.length,
        note:
          "These are left out of every figure below: a page that could not be read is neither " +
          "a yes nor a no, so it is in no denominator.",
      },
    ),
  );

  lines.push("");
  lines.push("=== SIGNALS, SIDE BY SIDE ===");
  lines.push(`Pages read: ${aiRead.length} AI landing, ${comparisonRead.length} comparison.`);
  lines.push("Signal — AI landing pages | comparison pages");

  const tally = (group: Array<Extract<Checked, { ok: true }>>, key: SignalKey) => {
    const answered = group.filter((r) => r.reading.signals[key] !== null);
    return {
      yes: answered.filter((r) => r.reading.signals[key] === true).length,
      of: answered.length,
    };
  };

  const gaps: Array<{ label: string; gap: number; ai: string; comparison: string }> = [];
  const excusedNotes: string[] = [];
  for (const signal of SIGNALS) {
    const inAi = tally(aiRead, signal.key);
    const inComparison = tally(comparisonRead, signal.key);
    const aiShare = describeShare(inAi.yes, inAi.of, aiRead.length);
    const comparisonShare = describeShare(inComparison.yes, inComparison.of, comparisonRead.length);
    lines.push(`  ${signal.label} — ${aiShare} | ${comparisonShare}`);

    const unanswered =
      aiRead.length - inAi.of + (comparisonRead.length - inComparison.of);
    if (signal.unanswered && unanswered > 0) {
      excusedNotes.push(
        `  ${signal.label}: ${unanswered} page(s) left out — ${signal.unanswered}` +
          " (n/a where that is every page in the group).",
      );
    }

    if (inAi.of >= MIN_GROUP_FOR_DIFFERENCE && inComparison.of >= MIN_GROUP_FOR_DIFFERENCE) {
      gaps.push({
        label: signal.label,
        gap: percentOf(inAi.yes, inAi.of) - percentOf(inComparison.yes, inComparison.of),
        ai: aiShare,
        comparison: comparisonShare,
      });
    }
  }

  const aiWords = median(aiRead.map((r) => r.reading.wordCount));
  const comparisonWords = median(comparisonRead.map((r) => r.reading.wordCount));
  lines.push(
    `  Median word count — ${aiWords ?? "not checked"} | ${comparisonWords ?? "not checked"}`,
  );
  if (excusedNotes.length > 0) {
    lines.push("");
    lines.push("Denominators differ where a question could not be asked of a page:");
    lines.push(...excusedNotes);
  }

  lines.push("");
  lines.push("=== DIFFERENCES ===");
  if (
    aiRead.length < MIN_GROUP_FOR_DIFFERENCE ||
    comparisonRead.length < MIN_GROUP_FOR_DIFFERENCE
  ) {
    lines.push(
      `Not read: a difference needs at least ${MIN_GROUP_FOR_DIFFERENCE} checked pages in each ` +
        `group, and there are ${aiRead.length} and ${comparisonRead.length}. The side-by-side ` +
        "figures above still stand as what those pages carry.",
    );
  } else {
    const notable = gaps
      .filter((g) => Math.abs(g.gap) >= NOTABLE_GAP_POINTS)
      .sort((a, b) => Math.abs(b.gap) - Math.abs(a.gap));
    if (notable.length === 0) {
      lines.push(
        `No signal differs by ${NOTABLE_GAP_POINTS} points or more between the groups. On this ` +
          "sample, what AI assistants send people to does not stand apart on any of them.",
      );
    } else {
      for (const g of notable) {
        const direction = g.gap > 0 ? "More common on AI landing pages" : "Less common on AI landing pages";
        const sign = g.gap > 0 ? "+" : "";
        lines.push(`  ${direction}: ${g.label} (${sign}${g.gap} points; ${g.ai} against ${g.comparison})`);
      }
      lines.push("");
      lines.push(
        `${NOTABLE_GAP_POINTS} points is this Tool's own line for "worth a look", not a test of ` +
          "significance. On groups this small a gap of one or two pages is well within chance.",
      );
    }
  }

  lines.push("");
  lines.push("=== PER PAGE ===");
  const perPage = [...aiRead, ...comparisonRead].map((result) => {
    const present = SIGNALS.filter((s) => result.reading.signals[s.key] === true).map((s) => s.short);
    const age = result.reading.ageDays === null ? "undated" : `dated ${result.reading.ageDays} days ago`;
    const label = result.group === "ai" ? "AI" : "comparison";
    return (
      `[${label}] ${result.path} — ${result.reading.wordCount} words, ${age}; ` +
      `signals: ${present.length > 0 ? present.join(", ") : "none of these"}`
    );
  });
  lines.push(...capped(perPage, MAX_LISTED * 2, { noun: "pages" }));

  lines.push("");
  lines.push("=== HOW TO READ THIS ===");
  lines.push("Correlation over a small sample, and directional only. A signal that is more common");
  lines.push("on AI landing pages is not shown to be why they were cited: the two groups also");
  lines.push("differ in topic, age and links, none of which this compares. Nothing here was scored.");
  lines.push("The comparison pages had no AI-referred session in this window, which is not the");
  lines.push("same as never being cited. They are Google organic search pages only — source google,");
  lines.push("medium organic, the slice Search Console can confirm — so a page only Bing or");
  lines.push("DuckDuckGo sends people to is in neither group.");
  lines.push(...REFERRER_ONLY_CAVEAT);
  lines.push(...basis);

  return toolText(lines.join("\n"));
}

export default defineGoogleTool(
  FAILURE_CONTEXT,
  { toolName: "site_ai_landing_signals", domainOf: ({ site }) => domainFromUrl({ url: site }) },
  handler,
);
