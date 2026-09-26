import { z } from "zod";
import { type ToolMetadata, type InferSchema } from "xmcp";
import {
  DATA_START,
  lookupArticle,
  readPageviews,
  type ArticleLookup,
  type PageviewPoint,
} from "../lib/wikimedia-pageviews";
import { InvalidInputError } from "../lib/invalid-input-error";
import { defineCachedTool } from "../lib/define-tool";
import { refreshable } from "../lib/with-cache";
import { toolText } from "../lib/tool-result";
import { capped } from "../lib/render-list";

/** A Wikipedia edition's subdomain: `en`, `es`, `pt`, `zh-yue`, `simple`. */
const EDITION = /^[a-z]{2,3}(?:-[a-z]{2,8})*$|^simple$/;

export const schema = {
  ...refreshable,
  brand: z
    .string()
    .min(1)
    .max(200)
    .optional()
    .describe(
      "The brand's name, looked up as an exact Wikipedia title in `language`, then in English. " +
        "Give this or article",
    ),
  article: z
    .string()
    .min(1)
    .max(255)
    .optional()
    .describe(
      "The exact article title, when it differs from the brand's name (\"Acme (company)\"). " +
        "Wins over brand",
    ),
  language: z
    .string()
    .regex(EDITION)
    .optional()
    .describe("The Wikipedia edition to read, as its language code (en, es, de). Default: en"),
  months: z
    .number()
    .int()
    .min(1)
    .max(120)
    .optional()
    .describe("How many complete months to report, ending last month. Default: 12"),
  granularity: z
    .enum(["monthly", "daily"])
    .optional()
    .describe(
      "monthly: one figure per month, with year-over-year. daily: one per day over the same span, " +
        "to date a spike. Default: monthly",
    ),
};

export const metadata: ToolMetadata = {
  name: "brand_pageviews",
  description:
    "How many people read a brand's Wikipedia article over time, from Wikimedia's pageview " +
    "data: the trend over the window, the peak months or days, and year-over-year. A proxy for " +
    "brand interest while Google Trends has no open API — it counts readers of an encyclopedia " +
    "article, not searches. Finds the article from the brand's name or takes an exact title; " +
    "no article is reported as such. Needs no credentials and no database.",
  annotations: {
    title: "Read brand interest from Wikipedia pageviews",
    readOnlyHint: true,
    destructiveHint: false,
    // Past months do not change; a new one lands on the first of the month.
    idempotentHint: true,
    openWorldHint: true,
  },
};

/** Completes the sentence "Could not …" for every failure this Tool can return. */
const FAILURE_CONTEXT = "read Wikipedia pageviews for this brand";

/** Said before any number. */
const HOW_TO_READ = [
  "Readers of a Wikipedia article are a proxy for interest in the brand, not a measure of",
  "search demand: Google Trends' API is an application-only alpha, and this is the closest",
  "public series. It moves with news, controversies and anything else sharing the name.",
  "Counted: human readers on every device (Wikimedia's agent=user). Views that reached the",
  "article through a redirect, such as a former name, are counted under the redirect's own",
  "title and are not included.",
];

/** Within this much either way, a change is called flat rather than a direction. */
const FLAT_BAND = 0.1;

// ── Dates, in UTC throughout ────────────────────────────────────────────────

function ymd(date: Date): string {
  return date.toISOString().slice(0, 10).replace(/-/g, "");
}

/** `YYYY-MM` for the month `offset` months from `date`'s. */
function monthKey(date: Date, offset = 0): string {
  const d = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + offset, 1));
  return d.toISOString().slice(0, 7);
}

function monthsBetween(first: string, last: string): string[] {
  const [y, m] = first.split("-").map(Number) as [number, number];
  const start = new Date(Date.UTC(y, m - 1, 1));
  const keys: string[] = [];
  for (let i = 0; ; i++) {
    const key = monthKey(start, i);
    if (key > last) break;
    keys.push(key);
  }
  return keys;
}

function clampToDataStart(yyyymmdd: string): string {
  return yyyymmdd < DATA_START ? DATA_START : yyyymmdd;
}

// ── Arithmetic that cannot print NaN ────────────────────────────────────────

function sum(values: number[]): number {
  return values.reduce((total, v) => total + v, 0);
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length === 0) return 0;
  return sorted.length % 2 ? (sorted[mid] as number) : ((sorted[mid - 1] as number) + (sorted[mid] as number)) / 2;
}

function count(n: number): string {
  return Math.round(n).toLocaleString("en-US");
}

/** "+12% (up)", or a sentence when there is no base to divide by. */
function change(before: number, after: number): string {
  if (before === 0) return after === 0 ? "no views in either" : "from zero, so no percentage";
  const ratio = after / before - 1;
  const pct = `${ratio >= 0 ? "+" : ""}${Math.round(ratio * 100)}%`;
  const direction = Math.abs(ratio) <= FLAT_BAND ? "about flat" : ratio > 0 ? "up" : "down";
  return `${pct} (${direction})`;
}

/** The first half against the second, which a single noisy month cannot swing alone. */
function trendLine(points: PageviewPoint[], unit: string): string {
  if (points.length < 4) {
    return `Trend: not computed — ${points.length} ${unit}(s) with data, and it needs at least 4.`;
  }
  const half = Math.floor(points.length / 2);
  const first = points.slice(0, half).map((p) => p.views);
  const second = points.slice(points.length - half).map((p) => p.views);
  const before = sum(first) / first.length;
  const after = sum(second) / second.length;
  return (
    `Trend: ${change(before, after)} — the average ${unit} in the second half of the window ` +
    `(${count(after)}) against the first (${count(before)}).`
  );
}

function peakLines(points: PageviewPoint[], howMany: number, unit: string): string[] {
  const base = median(points.map((p) => p.views));
  const top = [...points].sort((a, b) => b.views - a.views).slice(0, howMany);
  const lines = [`Peak ${unit}s:`];
  for (const point of top) {
    const times = base > 0 ? ` — ${(point.views / base).toFixed(1)}× the median ${unit}` : "";
    lines.push(`  ${point.period}: ${count(point.views)}${times}`);
  }
  if (base > 0 && top[0] && top[0].views >= 2 * base) {
    lines.push(
      `  A ${unit} at twice the median or more is usually news or an event, not a change in`,
      "  standing (inference). Look at what happened then before reading it as growth.",
    );
  }
  return lines;
}

// ── Rendering ────────────────────────────────────────────────────────────────

function header(article: Extract<ArticleLookup, { kind: "article" }>, source: string): string[] {
  return [
    "=== BRAND INTEREST (Wikipedia pageviews) ===",
    "",
    `Article: ${article.title} (${article.language}.wikipedia.org) — ${article.url}`,
    ...(article.description ? [`Described as: ${article.description}`] : []),
    `Found by: ${source}`,
  ];
}

function renderMonthly(
  points: PageviewPoint[],
  windowFirst: string,
  windowLast: string,
): string[] {
  const byMonth = new Map(points.map((p) => [p.period, p.views]));
  const months = monthsBetween(windowFirst, windowLast);
  const inWindow = points.filter((p) => p.period >= windowFirst && p.period <= windowLast);
  const missing = months.filter((m) => !byMonth.has(m));

  const lines = [
    `Window: ${windowFirst} … ${windowLast} (${months.length} complete month${months.length === 1 ? "" : "s"}; ` +
      "the current month is partial and left out)",
    "",
    ...HOW_TO_READ,
    "",
  ];

  if (inWindow.length === 0) {
    lines.push(
      "Wikimedia recorded no human views of this article in the window. The article exists, so",
      "this is an answer: nobody (or too few to count) read it in these months.",
    );
    return lines;
  }

  const total = sum(inWindow.map((p) => p.views));
  lines.push(
    "=== SUMMARY ===",
    "",
    `Total views: ${count(total)}; average ${count(total / inWindow.length)} a month`,
    trendLine(inWindow, "month"),
    ...peakLines(inWindow, 3, "month"),
    "",
    ...yearOverYear(byMonth, windowLast),
  );
  if (missing.length > 0) {
    lines.push(
      "",
      `${missing.length} month(s) in the window came back with no figure (${missing.join(", ")}). ` +
        "They are left out of every figure above rather than counted as zero.",
    );
  }

  lines.push("", "=== BY MONTH ===", "");
  for (const month of months) {
    const views = byMonth.get(month);
    lines.push(`${month}  ${views === undefined ? "—" : count(views)}`);
  }
  return lines;
}

/**
 * Two comparisons, each only when every month it needs came back.
 *
 * A missing month is usually the article not existing yet, and a year that
 * covers eight months compared with a year that covers twelve is a growth figure
 * made of the gap.
 */
function yearOverYear(byMonth: Map<string, number>, lastMonth: string): string[] {
  const [y, m] = lastMonth.split("-").map(Number) as [number, number];
  const last = new Date(Date.UTC(y, m - 1, 1));
  const lines = ["Year over year:"];

  const latest = byMonth.get(lastMonth);
  const yearAgoKey = monthKey(last, -12);
  const yearAgo = byMonth.get(yearAgoKey);
  lines.push(
    latest !== undefined && yearAgo !== undefined
      ? `  ${lastMonth} against ${yearAgoKey}: ${count(latest)} vs ${count(yearAgo)}, ${change(yearAgo, latest)}`
      : `  ${lastMonth} against ${yearAgoKey}: not available — no figure for ${latest === undefined ? lastMonth : yearAgoKey}.`,
  );

  const recent = Array.from({ length: 12 }, (_, i) => byMonth.get(monthKey(last, -i)));
  const prior = Array.from({ length: 12 }, (_, i) => byMonth.get(monthKey(last, -12 - i)));
  const complete = (values: Array<number | undefined>): values is number[] =>
    values.every((v) => v !== undefined);
  lines.push(
    complete(recent) && complete(prior)
      ? `  Last 12 months against the 12 before: ${count(sum(recent))} vs ${count(sum(prior))}, ` +
          change(sum(prior), sum(recent))
      : "  Last 12 months against the 12 before: not available — the series does not cover all 24 " +
          "months (the article may be newer than that).",
  );
  return lines;
}

function renderDaily(points: PageviewPoint[], start: string, end: string): string[] {
  const iso = (d: string) => `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}`;
  const lines = [
    `Window: ${iso(start)} … ${iso(end)}, one figure per day`,
    "",
    ...HOW_TO_READ,
    "",
  ];
  if (points.length === 0) {
    lines.push(
      "Wikimedia recorded no human views of this article in the window. The article exists, so",
      "this is an answer: nobody (or too few to count) read it on these days.",
    );
    return lines;
  }
  const total = sum(points.map((p) => p.views));
  lines.push(
    "=== SUMMARY ===",
    "",
    `Total views: ${count(total)}; average ${count(total / points.length)} a day over ${points.length} day(s) with a figure`,
    trendLine(points, "day"),
    ...peakLines(points, 5, "day"),
    "",
    "=== LAST 14 DAYS ===",
    "",
    ...capped(
      points.slice(-14).map((p) => `${p.period}  ${count(p.views)}`),
      14,
      { indent: "" },
    ),
    "",
    "Year over year is reported with granularity monthly.",
  );
  return lines;
}

// ── The Tool ─────────────────────────────────────────────────────────────────

/**
 * The article, in the order that costs least: the edition asked for, then
 * English — the asymmetry `wikipedia-check.ts` argues for, since a brand
 * writing in Spanish may well have an English article and nothing else. An
 * explicit title is only looked up where it was given.
 */
async function resolve(
  brand: string | undefined,
  article: string | undefined,
  language: string,
): Promise<{ lookup: ArticleLookup; source: string; searched: string[] }> {
  if (article) {
    return {
      lookup: await lookupArticle(article, language),
      source: `the title given, "${article}"`,
      searched: [language],
    };
  }
  const name = brand as string;
  const editions = language === "en" ? ["en"] : [language, "en"];
  let lookup: ArticleLookup = { kind: "none", language };
  for (const edition of editions) {
    lookup = await lookupArticle(name, edition);
    if (lookup.kind !== "none") break;
  }
  return { lookup, source: `the brand name "${name}", as an exact title`, searched: editions };
}

export async function handler({
  brand,
  article,
  language,
  months,
  granularity,
}: InferSchema<typeof schema>) {
  if (!brand && !article) {
    throw new InvalidInputError("Give brand (the brand's name) or article (an exact Wikipedia title).");
  }
  const edition = language ?? "en";
  const { lookup, source, searched } = await resolve(brand, article, edition);

  if (lookup.kind === "none") {
    const asked = article ?? brand;
    return toolText(
      [
        "=== BRAND INTEREST (Wikipedia pageviews) ===",
        "",
        `No Wikipedia article is titled "${asked}" (searched ${searched.map((l) => `${l}.wikipedia.org`).join(" and ")}).`,
        "That is the answer for this name: there is no article whose readers could be counted.",
        "If the brand has an article under another title — \"Acme (company)\", a former name —",
        "pass it as article.",
      ].join("\n"),
    );
  }
  if (lookup.kind === "disambiguation") {
    throw new InvalidInputError(
      `"${lookup.title}" on ${lookup.language}.wikipedia.org is a disambiguation page (${lookup.url}): ` +
        "its readers are looking for several different things, so its views say nothing about one " +
        "brand. Pass the brand's own article title as article.",
    );
  }

  const span = months ?? 12;
  const now = new Date();
  const lines = header(lookup, source);
  lines.push("");

  if ((granularity ?? "monthly") === "monthly") {
    const windowLast = monthKey(now, -1);
    const windowFirst = monthKey(now, -span);
    // Year over year needs the twelve months before the window, and the last
    // twelve against the twelve before them needs 24 whatever the window.
    const fetchFirst = monthKey(now, -Math.max(span, 12) - 12);
    const lastDay = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 0));
    const series = await readPageviews(
      lookup,
      "monthly",
      clampToDataStart(`${fetchFirst.replace("-", "")}01`),
      ymd(lastDay),
    );
    lines.push(...renderMonthly(series.points, windowFirst, windowLast));
  } else {
    const end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - 1));
    const start = new Date(Date.UTC(end.getUTCFullYear(), end.getUTCMonth() - span, end.getUTCDate() + 1));
    const series = await readPageviews(lookup, "daily", clampToDataStart(ymd(start)), ymd(end));
    lines.push(...renderDaily(series.points, series.start, series.end));
  }

  return toolText(lines.join("\n"));
}

export default defineCachedTool(FAILURE_CONTEXT, { toolName: "brand_pageviews" }, handler);
