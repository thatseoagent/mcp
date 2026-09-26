import { z } from "zod";
import { type ToolMetadata, type InferSchema } from "xmcp";
import {
  runPageSpeedInsights,
  readFieldData,
  chooseFieldData,
  PAGESPEED_KEY_REQUIREMENT,
  type AgenticBrowsing,
  type FieldSource,
  type LabData,
  type ThirdParties,
} from "../lib/pagespeed";
import {
  assessVitals,
  describeAssessment,
  describeDiagnostics,
  RANKING_VITALS,
  type FieldVital,
} from "../lib/crux-record";
import {
  formatVital,
  goodUnder,
  poorAbove,
  rateVital,
  vitalLabel,
  vitalName,
} from "../lib/analyzers/vital-thresholds";
import { requireConfig } from "../lib/required-config";
import { defineCachedTool } from "../lib/define-tool";
import { domainFromUrl, refreshable } from "../lib/with-cache";
import { toolText } from "../lib/tool-result";
import { withheld } from "../lib/render-list";

export const schema = {
  ...refreshable,
  url: z.string().url().describe("The URL to analyze"),
  strategy: z
    .enum(["mobile", "desktop"])
    .optional()
    .describe("Device strategy. Default: mobile"),
  categories: z
    .array(z.enum(["performance", "accessibility", "best-practices", "seo", "agentic-browsing"]))
    .optional()
    .describe(
      "Lighthouse categories to run. Default: performance, accessibility, best-practices, seo. " +
        "agentic-browsing (Lighthouse 13.3: how an AI agent reads the page) is opt-in; PSI may " +
        "not accept it yet, and if it refuses, the report says so and runs the rest without it.",
    ),
};

export const metadata: ToolMetadata = {
  name: "pagespeed_insights",
  description:
    "Is this page fast for real users, and what does a lab run say is slowing it? Reports " +
    "two separate readings: field data (what real Chrome users experienced over the last " +
    "28 days, which is what Google ranks on) from the Chrome UX Report API — the page's " +
    "own record, or its origin's when the page has none, saying which — and lab data " +
    "(one throttled Lighthouse run, a diagnostic) from PageSpeed Insights, with the " +
    "third-party vendors the page loaded. " +
    `Needs ${PAGESPEED_KEY_REQUIREMENT.variable} with the PageSpeed Insights API enabled, and ` +
    "the Chrome UX Report API enabled on the same project for the field data; without the " +
    "key this Tool returns an error saying so, and without the second API it says where " +
    "its field data came from instead.",
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
  { share: "good", label: "Good", bound: goodUnder },
  { share: "needsImprovement", label: "Needs improvement", bound: null },
  { share: "poor", label: "Poor", bound: poorAbove },
] as const;

/** Where to enable the API the field data now comes from. */
const ENABLE_CRUX_URL = "https://console.cloud.google.com/apis/library/chromeuxreport.googleapis.com";

/**
 * A vital's three buckets, each with the share of visits that landed in it.
 *
 * The threshold in the label comes from `vital-thresholds.ts` rather than a
 * literal, so a bucket can never be labelled with a bound the check does not use.
 */
function renderDistribution(vital: FieldVital): string[] {
  if (!vital.shares) return [];
  const shares = vital.shares;
  return BUCKETS.map(({ share, label, bound }) => {
    const proportion = shares[share];
    const qualifier = bound ? ` (${bound(vital.key)})` : "";
    return `    ${label}${qualifier}: ${proportion === null ? "not reported" : `${(proportion * 100).toFixed(1)}%`}`;
  });
}

/** "LCP (Largest Contentful Paint): 5.2s (poor)". */
function vitalLine(vital: FieldVital): string {
  const { label } = vitalLabel(vital.key);
  const reading = vital.p75 === null
    ? "no reading — too few samples"
    : `${formatVital(vital.key, vital.p75)} (${rateVital(vital.key, vital.p75)})`;
  return `  ${label} (${vitalName(vital.key)}): ${reading}`;
}

/** The sentence naming where the field data came from. Always printed. */
function sourceLines(field: Exclude<FieldSource, { source: "none" }>, device: string): string[] {
  if (field.source === "crux-api") {
    const { record } = field;
    if (record.scope === "page") {
      return [`Source: Chrome UX Report API — this page's own record (${device}).`];
    }
    return [
      `Source: Chrome UX Report API — the origin's record (${record.subject}, ${device}).`,
      "CrUX has no record for this page alone, so these are every page on the origin",
      "combined, not this page's own figures.",
    ];
  }
  const lines = [
    "Source: PageSpeed Insights' copy of the Chrome UX Report. The Chrome UX Report API",
    `refused this key (HTTP ${field.cruxStatus}) — most often because that API is not enabled on`,
    "the key's Google Cloud project, or the key is restricted to other APIs.",
    "Both are the same CrUX dataset, so the reading is the same one. But Google has",
    "announced PageSpeed Insights will stop including it, after which this section will",
    `have no field data to show until the Chrome UX Report API is enabled: ${ENABLE_CRUX_URL}`,
  ];
  if (field.data.scope === "origin") {
    lines.push("PSI had no record for this page alone and gave the origin's, so these are every page");
    lines.push("on the origin combined, not this page's own figures.");
  }
  return lines;
}

/**
 * What real users experienced, or an honest account of why we cannot say.
 *
 * Absent field data is the common case, not an error: CrUX reports on a URL only
 * once it has enough Chrome traffic. It is stated as "we have no reading" rather
 * than left to be inferred from a missing section, because a silent gap between
 * two headings reads as a pass.
 */
function renderFieldData(field: FieldSource, device: string): string[] {
  if (field.source === "none") {
    if (field.cruxRefused === null) {
      return [
        "=== FIELD DATA ===",
        "",
        `No field data: the Chrome UX Report has no record for this page or for its origin (${device}).`,
        "CrUX reports only once enough Chrome users have visited. This is not a finding about",
        "the page — it is the absence of a reading. The lab data below is a diagnostic and does",
        "not substitute for it.",
      ];
    }
    return [
      "=== FIELD DATA ===",
      "",
      "No field data. The Chrome UX Report API, which is where it now comes from, refused",
      `this key (HTTP ${field.cruxRefused}) — most often because that API is not enabled on the`,
      "key's Google Cloud project, or the key is restricted to other APIs.",
      "PageSpeed Insights' own copy of CrUX had none for this URL either. While PSI still",
      "includes that copy, its having none means CrUX has none; once Google withdraws it, as",
      "it has announced it will, this can no longer tell the two apart. Enable the Chrome UX",
      `Report API to read it directly: ${ENABLE_CRUX_URL}`,
    ];
  }

  const vitals = field.source === "crux-api" ? field.record.vitals : field.data.vitals;
  const window = field.source === "crux-api"
    ? `28-day window ${field.record.periodStart} to ${field.record.periodEnd}`
    : "last 28 days";
  const lines = [
    `=== FIELD DATA (real Chrome users, ${window}) ===`,
    "",
    ...sourceLines(field, device),
    "",
    `Core Web Vitals assessment: ${describeAssessment(assessVitals(vitals))}`,
  ];

  for (const key of RANKING_VITALS) {
    const vital = vitals.find((v) => v.key === key) ?? { key, p75: null, shares: null };
    lines.push(vitalLine(vital));
    if (vital.p75 !== null) lines.push(...renderDistribution(vital));
  }

  const rated = vitals.filter((v) => !vitalLabel(v.key).rankingSignal && v.p75 !== null);
  const diagnostics = field.source === "crux-api" ? describeDiagnostics(field.record.diagnostics) : [];
  if (rated.length > 0 || diagnostics.length > 0) {
    lines.push("");
    // Named as diagnostics rather than listed alongside the vitals: none is a
    // ranking signal, and each exists to explain a slow LCP rather than to be
    // optimised for its own sake. The unrated ones only the CrUX API serves.
    lines.push("Diagnostics (not ranking signals — these explain a slow LCP):");
    for (const vital of rated) lines.push(vitalLine(vital));
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
      lines.push(...withheld(labData.failedAudits.length, MAX_AUDITS_SHOWN));
    }
  }

  return lines;
}

/** How many third-party vendors to print before saying how many were withheld. */
const MAX_VENDORS_SHOWN = 10;

function kib(bytes: number): string {
  return `${Math.round(bytes / 1024)} KiB`;
}

/**
 * Who else the page loads from, by vendor.
 *
 * By vendor rather than by URL because that is the unit an Operator can act on:
 * "drop the second chat widget" is a decision, forty script URLs are not. One
 * run on one load, so a vendor loaded on scroll or after consent may be absent,
 * and the output says so rather than implying the list is the site's whole
 * third-party footprint.
 */
function renderThirdParties(thirdParties: ThirdParties | null): string[] {
  const lines = ["=== THIRD PARTIES (this Lighthouse run) ===", ""];
  if (!thirdParties) {
    lines.push("Not checked: this response carried no entity attribution (lighthouseResult.entities).");
    return lines;
  }
  if (thirdParties.firstParty) lines.push(`First party: ${thirdParties.firstParty}`);
  const { vendors } = thirdParties;
  if (vendors.length === 0) {
    lines.push("No third-party origins were loaded in this run.");
    return lines;
  }
  const origins = vendors.reduce((sum, v) => sum + v.origins, 0);
  lines.push(
    `${vendors.length} third-party vendor(s) across ${origins} origin(s)` +
      (thirdParties.insightRead ? ", largest transfer first:" : ":"),
  );
  for (const vendor of vendors.slice(0, MAX_VENDORS_SHOWN)) {
    const parts = [`${vendor.origins} origin(s)`];
    if (vendor.transferSize !== null) parts.push(kib(vendor.transferSize));
    if (vendor.mainThreadTime !== null) parts.push(`${Math.round(vendor.mainThreadTime)}ms main thread`);
    const category = vendor.category ? ` (${vendor.category})` : "";
    lines.push(`  - ${vendor.name}${category} — ${parts.join(", ")}`);
  }
  lines.push(...withheld(vendors.length, MAX_VENDORS_SHOWN, { noun: "vendors" }));
  if (!thirdParties.insightRead) {
    lines.push("Transfer size and main-thread time: not checked — the third-parties-insight audit");
    lines.push("was not in this response.");
  }
  lines.push("One lab load: a vendor loaded on scroll, on interaction or after consent may not appear.");
  return lines;
}

/** The opt-in category, or the plain statement that PSI would not run it. */
function renderAgenticBrowsing(agentic: AgenticBrowsing): string[] {
  const lines = ["=== AGENTIC BROWSING (Lighthouse 13.3, opt-in) ===", ""];
  if (agentic.status === "refused") {
    lines.push(`PageSpeed Insights refused the agentic-browsing category (HTTP ${agentic.httpStatus}),`);
    lines.push("so it was not checked. The rest of this report was run without it and is unaffected.");
    return lines;
  }
  if (agentic.status === "absent") {
    lines.push("PageSpeed Insights accepted the request but returned no agentic-browsing category,");
    lines.push("so it was not checked.");
    return lines;
  }
  lines.push(
    agentic.score === null
      ? "Score: none — PSI returned the category without one."
      : `Score: ${(agentic.score * 100).toFixed(0)}/100`,
  );
  if (agentic.failedAudits.length > 0) {
    lines.push("");
    lines.push(`Audits that did not pass (${agentic.failedAudits.length}):`);
    for (const audit of agentic.failedAudits.slice(0, MAX_AUDITS_SHOWN)) {
      lines.push(`  - ${audit.title}`);
      if (audit.displayValue) lines.push(`    ${audit.displayValue}`);
    }
    lines.push(...withheld(agentic.failedAudits.length, MAX_AUDITS_SHOWN));
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
function renderRecommendations(field: FieldSource, labData: LabData): string[] {
  const lines = ["=== RECOMMENDATIONS ==="];

  if (field.source !== "none") {
    const vitals = field.source === "crux-api" ? field.record.vitals : field.data.vitals;
    const scope = field.source === "crux-api" ? field.record.scope : field.data.scope;
    const assessment = assessVitals(vitals);
    lines.push("");
    if (assessment.verdict === "fails") {
      const names = assessment.failing.map((k) => vitalLabel(k).label).join(", ");
      lines.push(`Field data says real users are not getting a good experience: ${names} fail at the`);
      lines.push("75th percentile. This is the half Google ranks on, so it comes first:");
      lines.push("  1. Work on whichever failing vital above has the largest 'Poor' share.");
      lines.push("  2. Ship the change, then wait: CrUX is a 28-day trailing window, so the");
      lines.push("     number here will not move for weeks even if the fix is immediate.");
      lines.push("     crux_history shows it moving week by week.");
      if (scope === "origin") {
        lines.push("  These are the origin's figures, so the pages dragging them down may be other than");
        lines.push("  this one.");
      }
    } else if (assessment.verdict === "passes") {
      lines.push("Field data says real users are getting a good experience on all three vitals.");
      lines.push("Nothing here needs fixing; the lab findings below are worth reading but are not");
      lines.push("costing anyone.");
    } else {
      lines.push("Field data is incomplete, so whether real users pass cannot be said. Read the");
      lines.push("vitals that do have a reading, and the lab data as a diagnostic.");
    }
  }

  if (labData.performance !== null && labData.performance < 0.5) {
    lines.push("");
    lines.push("The lab performance score is below 50. Lab data is a diagnostic rather than a");
    lines.push("measurement of anyone's experience, so read the failed audits above as leads:");
    lines.push("  - The largest wins are usually LCP and Total Blocking Time.");
    lines.push("  - Image weight, unsplit JavaScript and origin latency are the usual causes.");
  }

  if (field.source === "none") {
    lines.push("");
    if (field.cruxRefused === null) {
      lines.push("With no field data there is no reading of what your users experience, and CrUX");
      lines.push("has none for the origin either. Treat the lab score as a diagnostic until traffic");
      lines.push("grows.");
    } else {
      lines.push("Enable the Chrome UX Report API for this key's project; until then there is no");
      lines.push("reading of what your users experience.");
    }
  }

  return lines;
}

export async function handler({ url, strategy, categories }: InferSchema<typeof schema>) {
  // Every failure below this line — a missing key, a refused key, an exhausted
  // quota — travels as a thrown error that `defineTool` renders as a Tool
  // result. ADR-0003: a Tool that cannot do its whole job says what to
  // configure, and never returns a smaller result instead. The key is checked
  // here, once, so an unconfigured server refuses with the PageSpeed sentence
  // before either request is started.
  requireConfig(PAGESPEED_KEY_REQUIREMENT);
  const chosen = strategy ?? "mobile";

  // Together: the CrUX read takes well under a second and PSI tens of seconds,
  // so asking in sequence would add nothing but the wait.
  const [result, crux] = await Promise.all([
    runPageSpeedInsights({ url, strategy: chosen, categories }),
    readFieldData(url, chosen),
  ]);
  const field = chooseFieldData(crux, result);
  const device = chosen === "desktop" ? "desktop" : "phone";

  const lines = [
    "=== PAGESPEED INSIGHTS ===",
    "",
    `URL: ${result.url}`,
    `Strategy: ${result.strategy}`,
    "",
    ...renderFieldData(field, device),
    "",
    ...renderLabData(result.labData),
    "",
    ...renderThirdParties(result.thirdParties),
  ];
  if (result.agenticBrowsing) {
    lines.push("");
    lines.push(...renderAgenticBrowsing(result.agenticBrowsing));
  }
  lines.push("");
  lines.push(...renderRecommendations(field, result.labData));

  return toolText(lines.join("\n"));
}

export default defineCachedTool(
  FAILURE_CONTEXT,
  { toolName: "pagespeed_insights", domainOf: domainFromUrl },
  handler,
);
