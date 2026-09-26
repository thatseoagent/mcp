import { z } from "zod";
import { type ToolMetadata, type InferSchema } from "xmcp";
import { defineGoogleTool } from "../lib/define-tool";
import { notCheckedSection } from "../lib/render-basis";
import { toolText } from "../lib/tool-result";
import { fetchRows, gscWindowSchema } from "../lib/google/gsc-tool-shape";
import type { GoogleReader } from "../lib/google/reader";
import { busiest } from "../lib/google/busiest-pages";
import { requireConfig } from "../lib/required-config";
import {
  assessVitals,
  describeAssessment,
  describeVital,
  largestLcpSubpart,
  readCruxRecord,
  CRUX_KEY_REQUIREMENT,
  RANKING_VITALS,
  type CruxRecord,
  type FormFactor,
} from "../lib/crux-record";
import { excessOverGood } from "../lib/analyzers/vital-thresholds";

/** The most pages one call measures: each is up to two CrUX requests. */
const MAX_PAGES = 25;

export const schema = {
  ...gscWindowSchema,
  pages: z
    .number()
    .int()
    .min(1)
    .max(MAX_PAGES)
    .optional()
    .describe(`How many of the busiest pages, by Search Console clicks, to measure. Default 10, at most ${MAX_PAGES}.`),
  device: z
    .enum(["phone", "desktop"])
    .optional()
    .describe("Which device class's field data to read. Default: phone, which is what Google indexes."),
};

export const metadata: ToolMetadata = {
  name: "site_vitals_by_traffic",
  description:
    "Which slow pages cost the most search traffic? Takes the site's busiest pages from " +
    "Search Console by clicks, reads each one's Core Web Vitals from real Chrome users " +
    "(Chrome UX Report API, 28-day window), and ranks the slow ones by clicks × how far " +
    "LCP, INP and CLS are above Google's \"good\" ceilings. Pages CrUX has no record for " +
    "fall back to their origin's figures and say so; pages with no data at all are listed " +
    "as not measured, not as fast. Needs the Google login and " +
    `${CRUX_KEY_REQUIREMENT.variable} with the Chrome UX Report API enabled; without either ` +
    "this Tool returns an error saying so.",
  annotations: {
    title: "Rank Core Web Vitals by traffic",
    readOnlyHint: true,
    destructiveHint: false,
    // Search Console settles over days and CrUX recomputes daily, so two calls a
    // day apart are two readings; two in the same hour are one.
    idempotentHint: true,
    openWorldHint: true,
  },
};

/** Completes the sentence "Could not …" for every failure this Tool can return. */
const FAILURE_CONTEXT = "rank this site's pages by Core Web Vitals and traffic";

const DEFAULT_PAGES = 10;

/**
 * How many CrUX requests are in flight at once.
 *
 * Small, because the quota is 150 a minute per project and shared with every
 * other CrUX read on this server: three at a time finishes twenty-five pages in
 * a few seconds and leaves room for anything else in the same turn.
 * `callApi` holds CrUX to the minute's allowance underneath; this keeps
 * one call from spending it in a burst.
 */
const CRUX_CONCURRENCY = 3;

const FORM_FACTORS: Record<"phone" | "desktop", FormFactor> = { phone: "PHONE", desktop: "DESKTOP" };

/** What CrUX said about one page. */
type Measured =
  | { kind: "page"; record: CruxRecord }
  | { kind: "origin"; origin: string; record: CruxRecord }
  | { kind: "none"; reason: string };

interface PageRow {
  page: string;
  clicks: number;
  measured: Measured;
}

/** Run `work` over `items`, `limit` at a time, keeping the input order. */
async function inPool<T, R>(items: readonly T[], limit: number, work: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await work(items[index] as T);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

/**
 * The page's own record, else its origin's, else the reason there is neither.
 *
 * The origin read goes through the same single-flight cache as every other, so
 * ten pages of one origin that all lack a record cost one origin request.
 */
async function measure(page: string, formFactor: FormFactor): Promise<Measured> {
  let origin: string;
  try {
    const parsed = new URL(page);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") throw new Error("not http");
    origin = parsed.origin;
  } catch {
    return { kind: "none", reason: "Search Console's key for it is not a URL CrUX can look up" };
  }
  const own = await readCruxRecord({ url: page, scope: "page", formFactor });
  if (own.kind === "record") return { kind: "page", record: own.record };
  const whole = await readCruxRecord({ url: page, scope: "origin", formFactor });
  if (whole.kind === "record") return { kind: "origin", origin, record: whole.record };
  return { kind: "none", reason: "CrUX has no record for the page or for its origin" };
}

/**
 * How far from good a reading is: the three ranking vitals' excess over their
 * "good" ceilings, each as a fraction of the ceiling, summed.
 *
 * Summed rather than the worst one, so a page failing all three outranks a page
 * failing one by the same margin. A vital with no reading adds nothing — it is
 * not known to be over — which is why the missing ones are printed beside it.
 */
function distanceFromGood(record: CruxRecord): number {
  let total = 0;
  for (const key of RANKING_VITALS) {
    const p75 = record.vitals.find((v) => v.key === key)?.p75 ?? null;
    if (p75 !== null) total += excessOverGood(key, p75);
  }
  return total;
}

function vitalsLine(record: CruxRecord): string {
  return RANKING_VITALS.map((key) =>
    describeVital(key, record.vitals.find((v) => v.key === key)?.p75 ?? null),
  ).join(", ");
}

function clicks(n: number): string {
  return `${Math.round(n).toLocaleString("en-US")} click${Math.round(n) === 1 ? "" : "s"}`;
}

export async function handler(args: InferSchema<typeof schema>, google: GoogleReader) {
  // Before any read: the Search Console half is no use without the CrUX half,
  // and an Operator missing the key should hear so before we spend their quota.
  requireConfig(CRUX_KEY_REQUIREMENT);

  const device = args.device ?? "phone";
  const formFactor = FORM_FACTORS[device];
  const fetched = await fetchRows(google.searchConsole, args, {
    dimensions: ["page"],
    title: "CORE WEB VITALS BY TRAFFIC",
  });
  const { header, footer } = fetched;
  // By clicks, because the weight is clicks × distance from good: a page with
  // none weighs nothing however slow it is, and `busiest` leaves it out.
  const chosen = busiest(fetched, { by: "clicks", count: args.pages, max: MAX_PAGES, default: DEFAULT_PAGES });

  const lines = [...header, `Devices: ${device} (Chrome UX Report)`, ""];

  if (chosen.pages.length === 0) {
    lines.push("No page earned a click in this window, so there is no traffic to rank by and");
    lines.push("CrUX was not asked about any page.");
    lines.push(...footer);
    return toolText(lines.join("\n"));
  }

  const measured: PageRow[] = await inPool(chosen.pages, CRUX_CONCURRENCY, async (page) => ({
    page: page.url,
    clicks: page.clicks,
    measured: await measure(page.url, formFactor),
  }));

  lines.push(
    `Pages measured: the top ${chosen.pages.length} of ${chosen.eligible} page(s) with clicks in this window.`,
  );
  const periodEnd = measured.find((m) => m.measured.kind !== "none");
  if (periodEnd && periodEnd.measured.kind !== "none") {
    lines.push(
      `CrUX window: ${periodEnd.measured.record.periodStart} to ${periodEnd.measured.record.periodEnd}. ` +
        "Close to the Search Console window, not the same one.",
    );
  }
  lines.push("");
  lines.push("How the ranking works: clicks × how far LCP, INP and CLS are above Google's \"good\"");
  lines.push("ceilings (each as a fraction of its ceiling, summed; a page good on all three weighs 0).");
  lines.push("It orders the work. It is not an estimate of clicks lost — neither source measures that.");

  const ownRecord = measured.filter(
    (m): m is PageRow & { measured: { kind: "page"; record: CruxRecord } } => m.measured.kind === "page",
  );
  const ranked = ownRecord
    .map((m) => ({ ...m, distance: distanceFromGood(m.measured.record) }))
    .filter((m) => m.distance > 0)
    .map((m) => ({ ...m, weight: m.clicks * m.distance }))
    .sort((a, b) => b.weight - a.weight);
  const rankedPages = new Set(ranked.map((m) => m.page));
  const passing = ownRecord.filter(
    (m) => !rankedPages.has(m.page) && assessVitals(m.measured.record.vitals).verdict === "passes",
  );
  const unassessed = ownRecord.filter(
    (m) => !rankedPages.has(m.page) && assessVitals(m.measured.record.vitals).verdict !== "passes",
  );

  lines.push("");
  lines.push("=== SLOW PAGES, COSTLIEST FIRST (each page's own CrUX record) ===");
  if (ranked.length === 0) {
    lines.push("");
    lines.push("None: no page with its own record is above a \"good\" ceiling.");
  }
  ranked.forEach((m, i) => {
    lines.push("");
    lines.push(
      `${i + 1}. ${m.page} — ${clicks(m.clicks)}, weight ${Math.round(m.weight).toLocaleString("en-US")} ` +
        `(clicks × ${m.distance.toFixed(2)} over good)`,
    );
    lines.push(`   ${vitalsLine(m.measured.record)}`);
    const largest = largestLcpSubpart(m.measured.record.diagnostics.lcpSubparts);
    const lcp = m.measured.record.vitals.find((v) => v.key === "lcp")?.p75 ?? null;
    if (largest && lcp !== null && excessOverGood("lcp", lcp) > 0) {
      lines.push(
        `   Largest part of its image LCP: ${largest.label.toLowerCase()} (pagespeed_insights has the detail).`,
      );
    }
  });

  if (passing.length > 0) {
    lines.push("");
    lines.push("=== PASSING (LCP, INP and CLS all good) ===");
    for (const m of passing) lines.push(`- ${m.page} — ${clicks(m.clicks)}`);
  }

  if (unassessed.length > 0) {
    lines.push("");
    lines.push("=== CANNOT BE ASSESSED (a vital has no reading, and none of the rest is over) ===");
    for (const m of unassessed) {
      lines.push(`- ${m.page} — ${clicks(m.clicks)}: ${vitalsLine(m.measured.record)}`);
    }
  }

  const byOrigin = new Map<string, { record: CruxRecord; pages: PageRow[] }>();
  for (const m of measured) {
    if (m.measured.kind !== "origin") continue;
    const group = byOrigin.get(m.measured.origin) ?? { record: m.measured.record, pages: [] };
    group.pages.push(m);
    byOrigin.set(m.measured.origin, group);
  }
  if (byOrigin.size > 0) {
    lines.push("");
    lines.push("=== MEASURED ONLY AS PART OF THEIR ORIGIN ===");
    lines.push("CrUX has no record for these pages alone. The figures are their origin's — every page");
    lines.push("on it combined — so they say how the site does, not how these pages do, and these");
    lines.push("pages are not ranked above for that reason.");
    for (const [origin, group] of byOrigin) {
      lines.push("");
      lines.push(`${origin}: ${vitalsLine(group.record)}`);
      lines.push(`  Origin assessment: ${describeAssessment(assessVitals(group.record.vitals))}`);
      for (const m of group.pages) lines.push(`  - ${m.page} — ${clicks(m.clicks)}`);
    }
  }

  const unmeasured = measured.flatMap((m) =>
    m.measured.kind === "none" ? [{ subject: `${m.page} (${clicks(m.clicks)})`, reason: m.measured.reason }] : [],
  );
  lines.push(
    ...notCheckedSection(unmeasured, {
      noun: "pages",
      // Every page asked about can be one, and each is a page with traffic.
      cap: measured.length,
      note:
        "No field data for these, so how fast they are is not checked — this is the absence of " +
        "a reading, not a fast page. CrUX reports only once enough Chrome users have visited.",
    }),
  );

  lines.push(...footer);
  return toolText(lines.join("\n"));
}

export default defineGoogleTool(
  FAILURE_CONTEXT,
  { toolName: "site_vitals_by_traffic", domainOf: (args) => args.siteUrl ?? null },
  handler,
);
