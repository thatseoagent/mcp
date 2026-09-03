import { z } from "zod";
import { type ToolMetadata, type InferSchema } from "xmcp";
import {
  runPageSpeedInsights,
  PAGESPEED_KEY_REQUIREMENT,
  type CrUXMetric,
  type LabData,
  type PageSpeedInsightsResult,
} from "../lib/pagespeed";
import { goodUnder, poorAbove } from "../lib/analyzers/vital-thresholds";
import { defineCachedTool } from "../lib/define-tool";
import { domainFromUrl, refreshable } from "../lib/with-cache";
import { toolText } from "../lib/tool-result";

export const schema = {
  ...refreshable,
  url: z.string().url().describe("The URL to analyze"),
  strategy: z
    .enum(["mobile", "desktop"])
    .optional()
    .describe("Device strategy. Default: mobile"),
  categories: z
    .array(z.enum(["performance", "accessibility", "best-practices", "seo"]))
    .optional()
    .describe("Categories to analyze. Default: all four"),
};

export const metadata: ToolMetadata = {
  name: "pagespeed_insights",
  description:
    "Run Google's PageSpeed Insights on a URL and report both halves of what it " +
    "returns: field data (what real Chrome users experienced over the last 28 days, " +
    "which is what Google ranks on) and lab data (one throttled Lighthouse run, which " +
    "is a diagnostic). " +
    `Needs ${PAGESPEED_KEY_REQUIREMENT.variable} configured; without it this Tool returns an ` +
    "error saying so and every other Tool on this server is unaffected.",
  annotations: {
    title: "Run PageSpeed Insights",
    readOnlyHint: true,
    destructiveHint: false,
    // Not idempotent: Lighthouse is re-run per call and CrUX moves daily, so two
    // calls a week apart are two different measurements rather than one answer
    // fetched twice.
    idempotentHint: false,
    openWorldHint: true,
  },
};

/** Completes the sentence "Could not …" for every failure this Tool can return. */
const FAILURE_CONTEXT = "run PageSpeed Insights for this URL";

/** How many failed audits to print before saying how many were withheld. */
const MAX_AUDITS_SHOWN = 10;

/**
 * How CrUX's three distribution buckets are ordered, so the meaning lives in a
 * name rather than in a literal `0` beside the word "Good".
 */
const BUCKETS = [
  { index: 0, label: "Good", bound: goodUnder },
  { index: 1, label: "Needs improvement", bound: null },
  { index: 2, label: "Poor", bound: poorAbove },
] as const;

/**
 * A vital's three buckets, each with the share of visits that landed in it.
 *
 * One function for LCP and CLS, which carried the same three lines each. The
 * threshold in the label comes from `vital-thresholds.ts` rather than a literal,
 * so a bucket can never be labelled with a bound the check does not use.
 */
function renderDistribution(key: "lcp" | "cls", metric: CrUXMetric): string[] {
  return BUCKETS.map(({ index, label, bound }) => {
    // Absent buckets read as 0, not as NaN: CrUX omits a bucket nobody landed in.
    const proportion = metric.distributions?.[index]?.proportion ?? 0;
    const qualifier = bound ? ` (${bound(key)})` : "";
    return `    ${label}${qualifier}: ${(proportion * 100).toFixed(1)}%`;
  });
}

/**
 * What real users experienced, or an honest account of why we cannot say.
 *
 * Absent field data is the common case, not an error: CrUX reports on a URL only
 * once it has enough Chrome traffic. It is stated as "we have no reading" rather
 * than left to be inferred from a missing section, because a silent gap between
 * two headings reads as a pass.
 */
function renderFieldData(fieldData: PageSpeedInsightsResult["fieldData"]): string[] {
  if (!fieldData) {
    return [
      "=== FIELD DATA ===",
      "",
      "No field data for this URL: CrUX reports on a URL only once enough Chrome users",
      "have visited it. This is not a finding about the page — it is the absence of a",
      "reading. The lab data below is a diagnostic and does not substitute for it.",
    ];
  }

  const lines = [
    "=== FIELD DATA (real user experience, last 28 days) ===",
    "",
    `Overall category: ${fieldData.overallCategory ?? "not reported"}`,
    "",
    "Core Web Vitals:",
  ];

  const lcp = fieldData.metrics.LARGEST_CONTENTFUL_PAINT_MS;
  if (lcp) {
    lines.push(`  LCP (Largest Contentful Paint): ${lcp.percentile}ms — ${lcp.category}`);
    lines.push(...renderDistribution("lcp", lcp));
  }

  // INP replaced FID as the responsiveness ranking signal; a response may carry
  // either. Preferring INP and falling back keeps one line where the API has two.
  const inp = fieldData.metrics.INTERACTION_TO_NEXT_PAINT;
  const fid = fieldData.metrics.FIRST_INPUT_DELAY_MS;
  if (inp) {
    lines.push(`  INP (Interaction to Next Paint): ${inp.percentile}ms — ${inp.category}`);
  } else if (fid) {
    lines.push(`  FID (First Input Delay): ${fid.percentile}ms — ${fid.category}`);
    lines.push("    FID is retired. Google ranks on INP, which CrUX has not reported here.");
  }

  const cls = fieldData.metrics.CUMULATIVE_LAYOUT_SHIFT_SCORE;
  if (cls) {
    // CrUX reports CLS multiplied by 100 so it can be an integer; the score
    // everyone quotes, and every threshold in `vital-thresholds`, is the raw one.
    lines.push(
      `  CLS (Cumulative Layout Shift): ${(cls.percentile / 100).toFixed(3)} — ${cls.category}`,
    );
    lines.push(...renderDistribution("cls", cls));
  }

  const diagnostics: string[] = [];
  const fcp = fieldData.metrics.FIRST_CONTENTFUL_PAINT_MS;
  if (fcp) diagnostics.push(`  FCP (First Contentful Paint): ${fcp.percentile}ms — ${fcp.category}`);
  const ttfb = fieldData.metrics.EXPERIMENTAL_TIME_TO_FIRST_BYTE;
  if (ttfb) diagnostics.push(`  TTFB (Time to First Byte): ${ttfb.percentile}ms — ${ttfb.category}`);

  if (diagnostics.length > 0) {
    lines.push("");
    // Named as diagnostics rather than listed alongside the vitals: neither is a
    // ranking signal, and both exist to explain a slow LCP rather than to be
    // optimised for their own sake.
    lines.push("Diagnostics (not ranking signals — these explain a slow LCP):");
    lines.push(...diagnostics);
  }

  return lines;
}

/** One throttled Lighthouse run, labelled as such throughout. */
function renderLabData(labData: LabData): string[] {
  const lines = ["=== LAB DATA (one throttled Lighthouse run) ===", "", "Category scores:"];

  const scores: Array<[string, number | null]> = [
    ["Performance", labData.performance],
    ["Accessibility", labData.accessibility],
    ["Best practices", labData.bestPractices],
    ["SEO", labData.seo],
  ];
  for (const [label, score] of scores) {
    // A category the caller did not ask for is absent, not zero. Printing 0/100
    // for it would report a failing score for a question nobody asked.
    if (score !== null) lines.push(`  ${label}: ${(score * 100).toFixed(0)}/100`);
  }

  if (labData.metrics) {
    lines.push("");
    lines.push("Key metrics:");
    lines.push(`  First Contentful Paint: ${labData.metrics.firstContentfulPaint}`);
    lines.push(`  Largest Contentful Paint: ${labData.metrics.largestContentfulPaint}`);
    lines.push(`  Total Blocking Time: ${labData.metrics.totalBlockingTime}`);
    lines.push(`  Cumulative Layout Shift: ${labData.metrics.cumulativeLayoutShift}`);
    lines.push(`  Speed Index: ${labData.metrics.speedIndex}`);
    lines.push(`  Time to Interactive: ${labData.metrics.interactive}`);
  }

  if (labData.failedAudits.length > 0) {
    lines.push("");
    lines.push(`Audits that did not pass (${labData.failedAudits.length}):`);
    for (const audit of labData.failedAudits.slice(0, MAX_AUDITS_SHOWN)) {
      const score = audit.score !== null ? ` (${(audit.score * 100).toFixed(0)}/100)` : "";
      lines.push(`  - ${audit.title}${score}`);
      if (audit.displayValue) lines.push(`    ${audit.displayValue}`);
    }
    if (labData.failedAudits.length > MAX_AUDITS_SHOWN) {
      lines.push(`  ... and ${labData.failedAudits.length - MAX_AUDITS_SHOWN} more`);
    }
  }

  return lines;
}

/**
 * What to do next, and which measurement each piece of advice comes from.
 *
 * The two halves are never averaged into one verdict. A page with a 98 lab score
 * and SLOW field data is slow for its users, and advice derived from the average
 * would tell its owner the opposite of the truth.
 */
function renderRecommendations(result: PageSpeedInsightsResult): string[] {
  const lines = ["=== RECOMMENDATIONS ==="];

  if (result.fieldData) {
    lines.push("");
    if (result.fieldData.overallCategory === "SLOW") {
      lines.push("Field data says real users are having a SLOW experience. This is the half");
      lines.push("Google ranks on, so it comes first:");
      lines.push("  1. Work on whichever vital above has the largest 'Poor' share.");
      lines.push("  2. Ship the change, then wait: CrUX is a 28-day trailing window, so the");
      lines.push("     number here will not move for weeks even if the fix is immediate.");
    } else if (result.fieldData.overallCategory === "AVERAGE") {
      lines.push("Field data says real users are having an AVERAGE experience:");
      lines.push("  1. Find the vital with the largest 'Needs improvement' share.");
      lines.push("  2. Google's bar is 75% of visits in 'Good', not an average.");
    } else if (result.fieldData.overallCategory === "FAST") {
      lines.push("Field data says real users are having a FAST experience. Nothing here needs");
      lines.push("fixing; the lab findings below are worth reading but are not costing anyone.");
    }
  }

  if (result.labData.performance !== null && result.labData.performance < 0.5) {
    lines.push("");
    lines.push("The lab performance score is below 50. Lab data is a diagnostic rather than a");
    lines.push("measurement of anyone's experience, so read the failed audits above as leads:");
    lines.push("  - The largest wins are usually LCP and Total Blocking Time.");
    lines.push("  - Image weight, unsplit JavaScript and origin latency are the usual causes.");
  }

  if (!result.fieldData) {
    lines.push("");
    lines.push("With no field data there is no reading of what your users experience. Try the");
    lines.push("site's origin (its homepage) — CrUX often has data for an origin when it has");
    lines.push("none for a page — and treat the lab score as a diagnostic until traffic grows.");
  }

  return lines;
}

export default defineCachedTool(
  FAILURE_CONTEXT,
  { toolName: "pagespeed_insights", domainOf: domainFromUrl },
  async ({ url, strategy, categories }: InferSchema<typeof schema>) => {
    // Every failure below this line — a missing key, a refused key, an exhausted
    // quota — travels as a thrown error that `defineTool` renders as a Tool
    // result. ADR-0003: a Tool that cannot do its whole job says what to
    // configure, and never returns a smaller result instead.
    const result = await runPageSpeedInsights({ url, strategy, categories });

    const lines = [
      "=== PAGESPEED INSIGHTS ===",
      "",
      `URL: ${result.url}`,
      `Strategy: ${result.strategy}`,
      "",
      ...renderFieldData(result.fieldData),
      "",
      ...renderLabData(result.labData),
      "",
      ...renderRecommendations(result),
    ];

    return toolText(lines.join("\n"));
  },
);
