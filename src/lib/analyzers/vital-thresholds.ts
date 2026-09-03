/**
 * Google's "good" threshold for each Core Web Vital, and how to say it.
 *
 * These numbers were written out three times in three formats — the summary's
 * target ("under 2.5s"), the row's inline hint ("≤ 2.5s") and the help dialog's
 * prose ("Good: under 2.5s") — so the report could tell a reader three slightly
 * different stories about one limit, and moving a threshold meant finding all
 * three. Google revises these; CLS and FID/INP have both changed since 2020.
 *
 * The limit is the single fact. Every phrasing is derived from it.
 */

export type VitalKey = "lcp" | "cls" | "inp" | "fcp" | "ttfb";

export interface VitalThreshold {
  /** Short display name, as Google and every practitioner writes it. */
  label: string;
  /** What it measures, in two words, for a reader meeting the acronym. */
  means: string;
  /** Full name, for the help dialog. */
  name: string;
  /** The "good" ceiling, in the metric's own unit. */
  limit: number;
  /**
   * The floor above which CrUX calls a reading "poor", in the same unit.
   *
   * CrUX buckets every metric as good / needs-improvement / poor, and the
   * PageSpeed tool labels those three buckets in its text output. Those labels
   * used to hard-code "<2.5s" and ">4s" beside the very percentages they
   * describe, which is the same duplication the good ceiling had.
   */
  poorAbove: number;
  unit: "ms" | "score";
  /**
   * One of Google's three ranking-signal vitals, as opposed to a diagnostic.
   * A finding is only raised for these; FCP and TTFB explain a slow LCP rather
   * than costing rankings themselves.
   */
  rankingSignal: boolean;
  /** Plain-language failure, for a finding title. */
  failure: string;
}

const THRESHOLDS: Record<VitalKey, VitalThreshold> = {
  lcp: {
    label: "LCP", means: "main content", name: "Largest Contentful Paint",
    limit: 2500, poorAbove: 4000, unit: "ms", rankingSignal: true,
    failure: "the main content takes too long to appear",
  },
  cls: {
    label: "CLS", means: "page stability", name: "Cumulative Layout Shift",
    limit: 0.1, poorAbove: 0.25, unit: "score", rankingSignal: true,
    failure: "the page moves around while it loads",
  },
  inp: {
    label: "INP", means: "tap response", name: "Interaction to Next Paint",
    limit: 200, poorAbove: 500, unit: "ms", rankingSignal: true,
    failure: "the page is slow to respond to taps and clicks",
  },
  fcp: {
    label: "FCP", means: "first paint", name: "First Contentful Paint",
    limit: 1800, poorAbove: 3000, unit: "ms", rankingSignal: false,
    failure: "the first pixel takes too long to draw",
  },
  ttfb: {
    label: "TTFB", means: "server speed", name: "Time to First Byte",
    limit: 800, poorAbove: 1800, unit: "ms", rankingSignal: false,
    failure: "the server is slow to respond",
  },
};

export const VITAL_KEYS = Object.keys(THRESHOLDS) as VitalKey[];

export function vitalThreshold(key: VitalKey): VitalThreshold {
  return THRESHOLDS[key];
}

/** The vitals Google uses directly as ranking signals, in reporting order. */
export const RANKING_VITALS = VITAL_KEYS.filter((k) => THRESHOLDS[k].rankingSignal);

/**
 * A measurement in the unit a reader thinks in: milliseconds below a second,
 * seconds above it, and layout shift as the bare three-decimal score it is.
 */
export function formatVitalValue(value: number, unit: "ms" | "score"): string {
  if (unit === "score") return value.toFixed(3);
  return value >= 1000 ? `${(value / 1000).toFixed(1)}s` : `${Math.round(value)}ms`;
}

/** "≤ 2.5s" — the inline hint beside a reading. */
export function goodBelow(key: VitalKey): string {
  const t = THRESHOLDS[key];
  return `≤ ${formatVitalValue(t.limit, t.unit)}`;
}

/** "> 4s" — the label CrUX's third distribution bucket needs. */
export function poorAbove(key: VitalKey): string {
  const t = THRESHOLDS[key];
  return `> ${formatVitalValue(t.poorAbove, t.unit)}`;
}

/** "< 2.5s" — the label CrUX's first distribution bucket needs. */
export function goodUnder(key: VitalKey): string {
  const t = THRESHOLDS[key];
  return `< ${formatVitalValue(t.limit, t.unit)}`;
}

/** "under 2.5s" — the prose form, for a finding's target and the help dialog. */
export function targetPhrase(key: VitalKey): string {
  const t = THRESHOLDS[key];
  return `under ${formatVitalValue(t.limit, t.unit)}`;
}
