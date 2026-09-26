import { z } from "zod";
import { type ToolMetadata, type InferSchema } from "xmcp";
import { defineGoogleTool } from "../lib/define-tool";
import { toolText } from "../lib/tool-result";
import { fetchRows, gscWindowSchema } from "../lib/google/gsc-tool-shape";
import { DEFAULT_QUICK_WINS, keyOf } from "../lib/google/gsc-analysis";
import type { GoogleReader, SearchAnalyticsRow } from "../lib/google/reader";
import { busiest, readPages } from "../lib/google/busiest-pages";
import { visibleTexts } from "../lib/visible-text";
import { coverage, tokeniserFor, words, SUPPORTED_TOKEN_LANGUAGES, type Coverage } from "../lib/query-tokens";
import { getLanguageName } from "../lib/language-validator";
import { capped, withheld } from "../lib/render-list";
import { basisSection, notCheckedSection, type NotChecked } from "../lib/render-basis";

/** Pages compared when the caller does not say. */
const DEFAULT_PAGES = 10;

/** The most pages one call reads: each is a request to the Operator's site. */
const MAX_PAGES = 25;

/** How many of a page's queries count as its "top" ones. */
const TOP_QUERIES = 3;

/** How many seen-often, clicked-rarely misses to print before counting the rest. */
const MAX_MISSES_SHOWN = 25;

export const schema = {
  ...gscWindowSchema,
  pages: z
    .number()
    .int()
    .optional()
    .describe(
      `How many of the site's pages to compare, taken by clicks. Default ${DEFAULT_PAGES}, ` +
        `at most ${MAX_PAGES}; a larger number is clamped.`,
    ),
};

export const metadata: ToolMetadata = {
  name: "site_title_query_fit",
  description:
    "Whether each of the site's busiest pages says, in its <title> and H1, the words of the " +
    "queries it is actually found for. Flags pages whose title carries none of their top " +
    "three queries, and queries seen often and clicked rarely where the title misses them — " +
    "usually a title to rewrite rather than a ranking to chase. Reads English and Spanish " +
    "pages and says so for any other language. Needs the Google login; without it this Tool " +
    "says so.",
  annotations: {
    title: "Check titles against the queries they rank for",
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: true,
  },
};

/** Completes the sentence "Could not …" for every failure this Tool can return. */
const FAILURE_CONTEXT = "compare this site's titles with the queries its pages rank for";

/** A query's fit to one piece of text, in words a reader can act on. */
function fitOf(result: Coverage): "all" | "some" | "none" {
  if (result.missing.length === 0) return "all";
  return result.found.length > 0 ? "some" : "none";
}

function describeFit(label: string, result: Coverage): string {
  const fit = fitOf(result);
  if (fit === "all") return `${label}: carries every word`;
  if (fit === "none") return `${label}: carries none of ${result.missing.join(", ")}`;
  return `${label}: missing ${result.missing.join(", ")}`;
}

/**
 * Seen often, clicked rarely, on the first page — where a title is the lever.
 *
 * Every number is ours, and borrowed from `gsc_detect_quick_wins` so the two
 * Tools agree about what "often" and "rarely" mean. Positions past the first
 * page are left out: a better title does nothing for a result nobody scrolls to.
 */
function underclicked(row: SearchAnalyticsRow): boolean {
  return (
    row.impressions >= DEFAULT_QUICK_WINS.minImpressions &&
    row.ctr * 100 <= DEFAULT_QUICK_WINS.maxCtr &&
    row.position <= DEFAULT_QUICK_WINS.positionMax
  );
}

const percent = (ctr: number): string => `${(ctr * 100).toFixed(1)}%`;

export async function handler(args: InferSchema<typeof schema>, google: GoogleReader) {
  const fetched = await fetchRows(google.searchConsole, args, {
    dimensions: ["page", "query"],
    title: "TITLES AGAINST THE QUERIES THEY RANK FOR",
  });
  // Rolled up by page, so each page carries its query rows. By impressions rather
  // than clicks: a page Google shows often and nobody clicks is the one whose
  // title most needs reading against its queries, and ranking by clicks left
  // exactly that page out — on a small site, every page with none.
  const ranked = busiest(fetched, { by: "impressions", count: args.pages, max: MAX_PAGES, default: DEFAULT_PAGES });
  const chosen = ranked.pages;

  const lines = [...fetched.header];
  lines.push("");

  if (ranked.reported === 0) {
    lines.push("No page and query rows in this window, so there are no queries to compare titles with.");
    lines.push(...fetched.footer);
    return toolText(lines.join("\n"));
  }

  const read = await readPages(chosen.map((entry) => entry.url));

  lines.push(`Pages compared: ${chosen.length} of ${ranked.reported} with queries, taken by impressions.`);

  const missesTop: string[] = [];
  const underclickedMisses: string[] = [];
  const notChecked: NotChecked[] = [];

  chosen.forEach((entry, index) => {
    const site = read[index];
    lines.push("");
    lines.push(
      `${entry.url} — ${Math.round(entry.clicks)} clicks, ` +
        `${Math.round(entry.impressions)} impressions, ${entry.rows.length} queries`,
    );

    if (!site.ok) {
      lines.push("  Not checked — the reason is under NOT CHECKED below.");
      notChecked.push({ subject: entry.url, reason: site.reason });
      return;
    }

    const tokeniser = tokeniserFor(site.page.language);
    if (tokeniser.outcome === "unsupported") {
      const reason =
        `the page declares ${tokeniser.languageName} (${tokeniser.language}), and ` +
        `this Tool can only tell significant words from filler in ` +
        `${SUPPORTED_TOKEN_LANGUAGES.map((code) => getLanguageName(code)).join(" and ")}.`;
      lines.push("  Not checked — the reason is under NOT CHECKED below.");
      notChecked.push({ subject: entry.url, reason });
      return;
    }

    const title = site.page.$("title").first().text().replace(/\s+/g, " ").trim();
    const h1s = visibleTexts(site.page.$, "h1");
    const titleWords = words(title);
    const h1Words = h1s.flatMap((h1) => words(h1));

    lines.push(`  Title: ${title ? `"${title}"` : "(none)"}`);
    lines.push(`  H1: ${h1s.length > 0 ? h1s.map((h1) => `"${h1}"`).join(", ") : "(none)"}`);
    if (tokeniser.outcome === "everyLanguage") {
      lines.push("  The page declares no language, so English and Spanish filler words were both ignored.");
    }

    const byImpressions = [...entry.rows].sort((a, b) => b.impressions - a.impressions);
    let anyTopCovered = false;
    for (const row of byImpressions.slice(0, TOP_QUERIES)) {
      const queryWords = tokeniser.significant(keyOf(row, 1));
      const inTitle = coverage(queryWords, titleWords);
      const inH1 = coverage(queryWords, h1Words);
      if (fitOf(inTitle) === "all") anyTopCovered = true;
      lines.push(
        `  "${keyOf(row, 1)}" — ${row.impressions} impressions, CTR ${percent(row.ctr)}, ` +
          `position ${row.position.toFixed(1)}`,
      );
      lines.push(`    ${describeFit("Title", inTitle)}; ${describeFit("H1", inH1)}`);
    }
    lines.push(...withheld(byImpressions.length, TOP_QUERIES, { noun: "queries", indent: "  " }));

    if (!anyTopCovered) missesTop.push(entry.url);

    for (const row of byImpressions.filter(underclicked)) {
      const inTitle = coverage(tokeniser.significant(keyOf(row, 1)), titleWords);
      if (fitOf(inTitle) === "all") continue;
      underclickedMisses.push(
        `${entry.url} — "${keyOf(row, 1)}", ${row.impressions} impressions, CTR ${percent(row.ctr)}, ` +
          `position ${row.position.toFixed(1)}; title missing ${inTitle.missing.join(", ")}`,
      );
    }
  });

  if (ranked.eligible > chosen.length) {
    lines.push("");
    lines.push(...withheld(ranked.eligible, chosen.length, { noun: "pages with queries were not compared", indent: "" }));
  }

  lines.push("");
  lines.push(`=== TITLE CARRIES NONE OF ITS TOP ${TOP_QUERIES} QUERIES (${missesTop.length}) ===`);
  if (missesTop.length === 0) {
    lines.push(`Every page compared carries all the words of at least one of its top ${TOP_QUERIES} queries.`);
  } else {
    lines.push("Google is finding these pages for queries their titles do not say. Either the title");
    lines.push("should say what the page is found for, or the page is being found for the wrong thing.");
    for (const url of missesTop) lines.push(`  ${url}`);
  }

  lines.push("");
  lines.push(`=== SEEN OFTEN, CLICKED RARELY, TITLE MISSES THE QUERY (${underclickedMisses.length}) ===`);
  if (underclickedMisses.length === 0) {
    lines.push("None among the pages compared.");
  } else {
    lines.push(...capped(underclickedMisses, MAX_MISSES_SHOWN, { noun: "queries" }));
  }
  lines.push(
    `Our thresholds, shared with gsc_detect_quick_wins: at least ${DEFAULT_QUICK_WINS.minImpressions} ` +
      `impressions, CTR at or below ${DEFAULT_QUICK_WINS.maxCtr}%, position ${DEFAULT_QUICK_WINS.positionMax} or better.`,
  );

  lines.push(
    ...notCheckedSection(notChecked, {
      noun: "pages",
      // Every page compared can be one, and each was said beside it above too.
      cap: chosen.length,
      note: "These are counted in neither list above.",
    }),
  );

  lines.push(
    ...basisSection(fetched.basis, {
      read: [],
      limits: [
        "A query's words are case- and accent-folded, filler words are dropped, and a title " +
          "\"carries\" a word when it has it or its plural. Word order is ignored. This is our " +
          "reading, not how Google matches queries to pages, and Google may show a different title " +
          "from the one the page declares.",
      ],
    }),
  );
  return toolText(lines.join("\n"));
}

export default defineGoogleTool(
  FAILURE_CONTEXT,
  { toolName: "site_title_query_fit", domainOf: (args) => args.siteUrl ?? null },
  handler,
);
