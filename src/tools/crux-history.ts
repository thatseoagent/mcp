import { z } from "zod";
import { type ToolMetadata, type InferSchema } from "xmcp";
import {
  readCruxHistory,
  CRUX_KEY_REQUIREMENT,
  type CruxHistory,
  type CruxSeries,
  type FormFactor,
} from "../lib/crux-history";
import {
  formatVital,
  rateVital,
  vitalLabel,
  type VitalKey,
} from "../lib/analyzers/vital-thresholds";
import { defineCachedTool } from "../lib/define-tool";
import { domainFromUrl, refreshable } from "../lib/with-cache";
import { toolText } from "../lib/tool-result";

export const schema = {
  ...refreshable,
  url: z.string().url().describe("A page URL, or any URL on the site when scope is origin"),
  scope: z
    .enum(["page", "origin"])
    .optional()
    .describe(
      "page: this URL alone. origin: every page on its origin combined, which CrUX has " +
        "data for far more often. Default: page",
    ),
  device: z
    .enum(["phone", "desktop", "tablet"])
    .optional()
    .describe("One device class. Default: all devices combined"),
};

export const metadata: ToolMetadata = {
  name: "crux_history",
  description:
    "Core Web Vitals from real Chrome users over the last 25 weekly collection periods, " +
    "for a page or a whole origin, from Google's Chrome UX Report History API. The Tool to " +
    "answer \"did the performance fix move anything?\" — pagespeed_insights reports only " +
    "the current 28-day reading. Each reading is rated against Google's thresholds and " +
    "the output says when the rating last changed. " +
    `Needs ${CRUX_KEY_REQUIREMENT.variable} with the Chrome UX Report API enabled; without ` +
    "it this Tool returns an error saying so.",
  annotations: {
    title: "Read Core Web Vitals history",
    readOnlyHint: true,
    destructiveHint: false,
    // CrUX publishes a new period once a week, so two calls in the same week
    // are one answer fetched twice.
    idempotentHint: true,
    openWorldHint: true,
  },
};

/** Completes the sentence "Could not …" for every failure this Tool can return. */
const FAILURE_CONTEXT = "read the Core Web Vitals history for this URL";

const FORM_FACTORS: Record<"phone" | "desktop" | "tablet", FormFactor> = {
  phone: "PHONE",
  desktop: "DESKTOP",
  tablet: "TABLET",
};

/** Google's three, in the order Google lists them. */
const RANKING_VITALS: VitalKey[] = ["lcp", "inp", "cls"];

/**
 * Said before any number, because the series invites one misreading above all:
 * treating 25 overlapping windows as 25 independent weekly measurements.
 */
const HOW_TO_READ = [
  "Each reading is the 75th percentile of real Chrome visits over a 28-day window.",
  "The windows end a week apart, so neighbouring readings share three of their four",
  "weeks: a change made on one day arrives over about four readings, not as a step,",
  "and a single-reading wobble is mostly noise. Read the direction, not the week.",
];

/** First and last readings that exist, with their positions in the series. */
function ends(values: Array<number | null>): { first: number; last: number } | null {
  const first = values.findIndex((v) => v !== null);
  if (first === -1) return null;
  let last = values.length - 1;
  while (values[last] === null) last--;
  return { first, last };
}

/**
 * The most recent period whose rating differs from the reading before it.
 *
 * The one sentence an Operator most wants from a series — "it went good in the
 * window ending the 14th" — and the one a list of numbers makes them work out.
 */
function lastRatingChange(
  key: VitalKey,
  p75s: Array<number | null>,
  periodEnds: string[],
): string | null {
  let later: number | null = null;
  for (let i = p75s.length - 1; i >= 0; i--) {
    const value = p75s[i];
    if (value === null) continue;
    if (later !== null) {
      const before = rateVital(key, value);
      const after = rateVital(key, p75s[later] as number);
      if (before !== after) {
        return `${before} → ${after} in the window ending ${periodEnds[later] ?? "unknown"}`;
      }
    }
    later = i;
  }
  return null;
}

/** CrUX's CLS is the raw score here, unlike PSI's ×100 integer. */
function show(key: VitalKey, value: number): string {
  return `${formatVital(key, value)} (${rateVital(key, value)})`;
}

function percent(share: number | null | undefined): string {
  return share === null || share === undefined ? "n/a" : `${Math.round(share * 100)}%`;
}

function renderVital(series: CruxSeries, periodEnds: string[]): string[] {
  const { label } = vitalLabel(series.key);
  const span = ends(series.p75s);
  if (!span) return [`${label}: no reading in any period — too few samples for CrUX to report.`];

  const first = series.p75s[span.first] as number;
  const last = series.p75s[span.last] as number;
  const lines = [
    `${label}: ${show(series.key, first)} → ${show(series.key, last)}, ` +
      `from the window ending ${periodEnds[span.first] ?? "unknown"} to the one ending ${periodEnds[span.last] ?? "unknown"}`,
    `  Visits in "good": ${percent(series.goodShares[span.first])} → ${percent(series.goodShares[span.last])}`,
  ];

  const change = lastRatingChange(series.key, series.p75s, periodEnds);
  lines.push(`  Last rating change: ${change ?? "none — the same rating in every period with a reading"}`);

  const gaps = series.p75s.filter((v) => v === null).length;
  if (gaps > 0) {
    lines.push(`  ${gaps} of ${series.p75s.length} periods had too few samples to report a reading.`);
  }
  return lines;
}

/**
 * Whether the latest period passes, by Google's rule: every one of the three at
 * "good". A vital with no latest reading makes it unassessable rather than a
 * pass, because a missing INP is not a fast one.
 */
function renderAssessment(history: CruxHistory): string[] {
  const latest = RANKING_VITALS.map((key) => {
    const series = history.series.find((s) => s.key === key);
    const value = series?.p75s.at(-1) ?? null;
    return { key, value };
  });

  const missing = latest.filter((v) => v.value === null).map((v) => vitalLabel(v.key).label);
  if (missing.length > 0) {
    return [
      `Latest period: cannot be assessed — no reading for ${missing.join(", ")}. This is the`,
      "absence of a measurement, not a failing one.",
    ];
  }
  const failing = latest.filter((v) => rateVital(v.key, v.value as number) !== "good");
  if (failing.length === 0) {
    return ["Latest period: passes — LCP, INP and CLS are all good at the 75th percentile."];
  }
  return [
    `Latest period: does not pass — ${failing.map((v) => vitalLabel(v.key).label).join(", ")} ` +
      "not good at the 75th percentile. Google's bar is all three.",
  ];
}

/** Every period, one line each, so the shape is visible without a chart. */
function renderTable(history: CruxHistory): string[] {
  const columns = RANKING_VITALS.map((key) => history.series.find((s) => s.key === key));
  const lines = [`Window ending  ${RANKING_VITALS.map((k) => vitalLabel(k).label.padEnd(8)).join(" ")}`];
  history.periodEnds.forEach((end, i) => {
    const cells = columns.map((series, c) => {
      const value = series?.p75s[i] ?? null;
      return (value === null ? "—" : formatVital(RANKING_VITALS[c] as VitalKey, value)).padEnd(8);
    });
    lines.push(`${end.padEnd(13)}  ${cells.join(" ")}`);
  });
  return lines;
}

export default defineCachedTool(
  FAILURE_CONTEXT,
  { toolName: "crux_history", domainOf: domainFromUrl },
  async ({ url, scope, device }: InferSchema<typeof schema>) => {
    const result = await readCruxHistory({
      url,
      scope: scope ?? "page",
      formFactor: device ? FORM_FACTORS[device] : undefined,
    });

    const devices = result.kind === "history" ? result.history.formFactor : result.formFactor;
    const header = [
      "=== CORE WEB VITALS HISTORY (Chrome UX Report) ===",
      "",
      `Subject: ${result.kind === "history" ? result.history.subject : result.subject} (${result.kind === "history" ? result.history.scope : result.scope})`,
      `Devices: ${devices === "ALL" ? "all combined" : devices.toLowerCase()}`,
    ];

    if (result.kind === "no-data") {
      const lines = [
        ...header,
        "",
        "CrUX has no field data for this: it reports only once enough Chrome users have",
        "visited. This is the absence of a reading, not a finding about the site.",
      ];
      if (result.scope === "page") {
        lines.push("Try scope: origin — CrUX often has data for a whole origin when it has none");
        lines.push("for a single page.");
      }
      return toolText(lines.join("\n"));
    }

    const { history } = result;
    const lines = [
      ...header,
      `Periods: ${history.periodEnds.length}, windows ending ${history.periodEnds[0] ?? "unknown"} … ${history.periodEnds.at(-1) ?? "unknown"}`,
      "",
      ...HOW_TO_READ,
      "",
      "=== CORE WEB VITALS (what Google ranks on) ===",
      "",
      ...renderAssessment(history),
    ];

    for (const key of RANKING_VITALS) {
      const series = history.series.find((s) => s.key === key);
      lines.push("");
      lines.push(
        ...(series ? renderVital(series, history.periodEnds) : [`${vitalLabel(key).label}: not reported for this subject.`]),
      );
    }

    const diagnostics = history.series.filter((s) => !vitalLabel(s.key).rankingSignal);
    if (diagnostics.length > 0) {
      lines.push("");
      lines.push("=== DIAGNOSTICS (not ranking signals — these explain a slow LCP) ===");
      for (const series of diagnostics) {
        lines.push("");
        lines.push(...renderVital(series, history.periodEnds));
      }
    }

    lines.push("");
    lines.push("=== BY PERIOD (p75) ===");
    lines.push("");
    lines.push(...renderTable(history));

    return toolText(lines.join("\n"));
  },
);
