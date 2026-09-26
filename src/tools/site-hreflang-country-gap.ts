import { z } from "zod";
import { type ToolMetadata, type InferSchema } from "xmcp";
import { defineGoogleTool } from "../lib/define-tool";
import { toolText } from "../lib/tool-result";
import { fetchRows, gscWindowSchema } from "../lib/google/gsc-tool-shape";
import { keyOf } from "../lib/google/gsc-analysis";
import type { GoogleReader } from "../lib/google/reader";
import { validateHreflangOfPage } from "../lib/analyzers/hreflang-analyzer";
import { declaredLanguage } from "../lib/analyzers/page-language";
import { parseLanguageCode, getLanguageName } from "../lib/language-validator";
import { readPages, type PageRead } from "../lib/google/busiest-pages";
import { logError } from "../lib/log";
import { propertyRoot } from "../lib/url-match";
import { COUNTRY_LANGUAGES, countryByAlpha2, countryName } from "../lib/country-languages";
import { capped } from "../lib/render-list";
import { basisSection, notCheckedSection } from "../lib/render-basis";

export const schema = {
  ...gscWindowSchema,
  url: z
    .string()
    .url()
    .optional()
    .describe(
      "A page whose hreflang alternates to read as well as the homepage's — a section root such " +
        "as https://example.com/blog/, when that is where the alternates are declared.",
    ),
};

export const metadata: ToolMetadata = {
  name: "site_hreflang_country_gap",
  description:
    "Which countries the site is seen in without a version in their language, and which " +
    "hreflang alternates aim at countries where it is barely seen. Crosses Search Console " +
    "impressions by country with the hreflang alternates the homepage (and optionally one " +
    "more page) declares, through our own approximate country-to-language table. Needs the " +
    "Google login; without it this Tool says so.",
  annotations: {
    title: "Find countries without a local version",
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: true,
  },
};

/** Completes the sentence "Could not …" for every failure this Tool can return. */
const FAILURE_CONTEXT = "compare this site's countries with its hreflang alternates";

/**
 * A country is "meaningful" at 1% of the property's impressions and at least 100
 * of them. Both ours: the share keeps a large site's long tail out, the floor
 * keeps a small site's handful of stray impressions from reading as a market.
 */
const MEANINGFUL_SHARE = 0.01;
const MEANINGFUL_MIN = 100;

/** Below this, an alternate's audience has "about no" impressions. Ours. */
const NEGLIGIBLE = 10;

/** How many rows any one list prints before it says how many it withheld. */
const MAX_SHOWN = 25;

/** One alternate, reduced to what the country comparison needs. */
interface Alternate {
  code: string;
  language: string;
  /** Alpha-2, when the alternate names a region. */
  region?: string;
  /** Where we read it: an hreflang annotation, or the page's own `lang`. */
  source: "hreflang" | "lang";
}

type AlternatesRead =
  | { ok: true; url: string; alternates: Alternate[]; tagCount: number }
  | { ok: false; url: string; reason: string };

/**
 * One page's alternates, or why it was not checked.
 *
 * From the read already made: the analyzer is handed the parsed page and its
 * headers rather than a URL, so the page is fetched once and every "not
 * checked" reason is the page reader's. With bidirectional and accessibility
 * checks off it makes no request of its own, which leaves only a malformed
 * annotation to fail on.
 *
 * The page's own `<html lang>` counts as an alternate for itself: a Spanish
 * homepage with no hreflang at all still serves Spain, and reporting Spain as a
 * gap would be the wrong conclusion from a missing tag.
 */
async function readAlternates(site: PageRead): Promise<AlternatesRead> {
  const url = site.url;
  if (!site.ok) return { ok: false, url, reason: site.reason };

  const result = await validateHreflangOfPage(site.page, site.headers, {
    checkBidirectional: false,
    checkAccessibility: false,
  });
  if (!result.success) {
    logError(`read the hreflang annotations of ${url}`, result.error);
    return { ok: false, url, reason: "its hreflang annotations could not be read." };
  }

  const alternates: Alternate[] = [];
  for (const tag of result.data.hreflangTags) {
    const parsed = parseLanguageCode(tag.lang.replace(/_/g, "-"));
    if (!parsed || parsed.language === "x-default") continue;
    const region = parsed.region && /^[A-Z]{2}$/.test(parsed.region) ? parsed.region : undefined;
    alternates.push({ code: tag.lang, language: parsed.language, region, source: "hreflang" });
  }

  const own = declaredLanguage(site.page.html);
  const parsedOwn = own ? parseLanguageCode(own.replace(/_/g, "-")) : null;
  if (parsedOwn && parsedOwn.language !== "x-default") {
    const region = parsedOwn.region && /^[A-Z]{2}$/.test(parsedOwn.region) ? parsedOwn.region : undefined;
    alternates.push({ code: own!, language: parsedOwn.language, region, source: "lang" });
  }

  return { ok: true, url, alternates, tagCount: result.data.hreflangTags.length };
}

const share = (part: number, total: number): string =>
  total > 0 ? `${((part / total) * 100).toFixed(1)}%` : "0.0%";

export async function handler(args: InferSchema<typeof schema>, google: GoogleReader) {
  const fetched = await fetchRows(google.searchConsole, args, {
    dimensions: ["country"],
    title: "COUNTRIES AGAINST HREFLANG ALTERNATES",
  });

  const byCountry = new Map<string, number>();
  for (const row of fetched.rows) {
    const code = keyOf(row).toLowerCase();
    byCountry.set(code, (byCountry.get(code) ?? 0) + row.impressions);
  }
  const total = [...byCountry.values()].reduce((sum, value) => sum + value, 0);

  const lines = [...fetched.header];
  lines.push("");

  if (total === 0) {
    lines.push("No impressions by country in this window, so there are no countries to compare alternates with.");
    lines.push("No page was read.");
    lines.push(...fetched.footer);
    return toolText(lines.join("\n"));
  }

  const home = propertyRoot(fetched.property);
  const targets = [...new Set([home, ...(args.url ? [args.url] : [])])];
  const pages: AlternatesRead[] = [];
  for (const site of await readPages(targets)) pages.push(await readAlternates(site));
  const read = pages.filter((page): page is Extract<AlternatesRead, { ok: true }> => page.ok);
  const alternates = read.flatMap((page) => page.alternates);

  // The pages this answer's alternates came from, for the basis section, and
  // the ones that could not be read, for NOT CHECKED. Printed at the end.
  const pagesRead = read.map((page) => `Page read: ${page.url} — ${page.tagCount} hreflang annotation(s)`);
  const pagesNotRead = pages.flatMap((page) => (page.ok ? [] : [{ subject: page.url, reason: page.reason }]));

  const meaningful = [...byCountry.entries()]
    .filter(([, impressions]) => impressions >= MEANINGFUL_MIN && impressions / total >= MEANINGFUL_SHARE)
    .sort((a, b) => b[1] - a[1]);

  lines.push(`=== COUNTRIES WITH MEANINGFUL IMPRESSIONS (${meaningful.length}) ===`);
  lines.push(
    `At least ${MEANINGFUL_MIN} impressions and ${MEANINGFUL_SHARE * 100}% of the property's ` +
      `${total} — our thresholds.`,
  );

  const gaps: string[] = [];
  const aimedElsewhere: string[] = [];
  const unmapped: string[] = [];

  for (const [code, impressions] of meaningful) {
    const country = COUNTRY_LANGUAGES[code];
    const name = countryName(code);
    const named = name === code.toUpperCase() ? name : `${name} (${code.toUpperCase()})`;
    const label = `${named} — ${impressions} impressions, ${share(impressions, total)}`;
    if (!country) {
      lines.push(`  ${label}: not in our country-to-language table, not checked`);
      unmapped.push(code.toUpperCase());
      continue;
    }
    if (read.length === 0) {
      lines.push(`  ${label}: not checked, no page could be read`);
      continue;
    }

    const inLanguage = alternates.filter((alt) => country.languages.includes(alt.language));
    const forHere = inLanguage.filter((alt) => !alt.region || alt.region === country.alpha2);
    const languages = country.languages.map((language) => getLanguageName(language)).join(", ");
    const multilingual = country.languages.length > 1 ? ` (we list ${languages})` : "";

    if (forHere.length > 0) {
      lines.push(`  ${label}: served by ${[...new Set(forHere.map((alt) => alt.code))].join(", ")}${multilingual}`);
    } else if (inLanguage.length > 0) {
      lines.push(
        `  ${label}: only alternates aimed at other countries, ${[...new Set(inLanguage.map((alt) => alt.code))].join(", ")}`,
      );
      aimedElsewhere.push(`${countryName(code)} — ${[...new Set(inLanguage.map((alt) => alt.code))].join(", ")}`);
    } else {
      lines.push(`  ${label}: no alternate in ${languages}`);
      gaps.push(`${countryName(code)} — ${impressions} impressions; no alternate in ${languages}`);
    }
  }

  // ── Alternates nobody is seeing ───────────────────────────────────────────
  const quiet: string[] = [];
  const uncompared: string[] = [];
  const hreflangOnly = alternates.filter((alt) => alt.source === "hreflang");
  for (const code of [...new Set(hreflangOnly.map((alt) => alt.code))]) {
    const alt = hreflangOnly.find((candidate) => candidate.code === code)!;
    if (alt.region) {
      const match = countryByAlpha2(alt.region);
      if (!match) {
        uncompared.push(code);
        continue;
      }
      const seen = byCountry.get(match.alpha3) ?? 0;
      if (seen < NEGLIGIBLE) quiet.push(`${code} — aimed at ${countryName(alt.region)}, ${seen} impressions there`);
    } else {
      const countries = Object.entries(COUNTRY_LANGUAGES).filter(([, country]) => country.languages.includes(alt.language));
      if (countries.length === 0) {
        uncompared.push(code);
        continue;
      }
      const seen = countries.reduce((sum, [alpha3]) => sum + (byCountry.get(alpha3) ?? 0), 0);
      if (seen < NEGLIGIBLE) {
        quiet.push(`${code} — ${getLanguageName(alt.language)}; ${seen} impressions across the countries we list for it`);
      }
    }
  }

  const list = (heading: string, rows: string[], empty: string, explain: string[] = []) => {
    lines.push("");
    lines.push(`=== ${heading} (${rows.length}) ===`);
    if (rows.length === 0) {
      lines.push(empty);
      return;
    }
    lines.push(...explain);
    lines.push(...capped(rows, MAX_SHOWN));
  };

  if (read.length === 0) {
    lines.push("");
    lines.push("Not checked: no page could be read, so no alternates were compared in either direction.");
  } else {
    list(
      "COUNTRIES WITHOUT AN ALTERNATE IN THEIR LANGUAGE",
      gaps,
      "Every meaningful country in our table has an alternate, or the page itself, in one of its languages.",
      [
        "Searchers here see the site in a language that is not theirs. Whether a version is worth",
        "building is a business question; this says where the demand already shows.",
      ],
    );
    if (aimedElsewhere.length > 0) {
      list("IN THEIR LANGUAGE, BUT AIMED AT ANOTHER COUNTRY", aimedElsewhere, "", [
        "An alternate exists in the language, but its region names another country. Google may",
        "still show it; a language-only alternate (es rather than es-ES) would cover both.",
      ]);
    }
    list(
      "ALTERNATES WITH ABOUT NO IMPRESSIONS",
      quiet,
      "Every alternate declared aims at a country or language the site is seen in.",
      [
        `Fewer than ${NEGLIGIBLE} impressions (our threshold) where the alternate is aimed. Either`,
        "the version is new, or Google is not showing it there — gsc_country_opportunity has the",
        "per-country numbers.",
      ],
    );
    if (uncompared.length > 0) {
      lines.push(`Not compared: ${uncompared.join(", ")} — not in our country-to-language table.`);
    }
  }

  lines.push(...notCheckedSection(pagesNotRead));
  lines.push(
    ...basisSection(fetched.basis, {
      read: pagesRead,
      limits: [
        "Search Console reports where a searcher was, not what language they searched in, and our " +
          "table pairs each country with its main language — plus the others in wide everyday use in " +
          "the few countries that have several. It is an approximation: minority and regional " +
          "languages are left out, and a country outside the table is reported as not checked rather " +
          "than guessed at.",
        ...(unmapped.length > 0 ? [`Countries not in the table: ${unmapped.join(", ")}.`] : []),
        "Only the pages listed above were read; alternates declared elsewhere on the site are not seen here.",
      ],
    }),
  );
  return toolText(lines.join("\n"));
}

export default defineGoogleTool(
  FAILURE_CONTEXT,
  { toolName: "site_hreflang_country_gap", domainOf: (args) => args.siteUrl ?? null },
  handler,
);
