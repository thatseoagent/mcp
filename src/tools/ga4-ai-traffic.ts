import { z } from "zod";
import { type ToolMetadata, type InferSchema } from "xmcp";
import { defineGoogleTool } from "../lib/define-tool";
import { DEFAULT_DAYS, ga4PropertySchema, ga4Window } from "../lib/google/ga4-tool-shape";
import { toolText } from "../lib/tool-result";
import { readReport } from "../lib/google/ga4-report";
import {
  AI_REFERRER_HOSTS,
  classifyAiReferrer,
  isAiReferrer,
} from "../lib/google/ai-referrers";
import type { GoogleReader } from "../lib/google/reader";
import { withheld } from "../lib/render-list";

export const schema = {
  ...ga4PropertySchema,
  days: z
    .number()
    .int()
    .min(7)
    .max(90)
    .optional()
    .describe("Lookback window in days. Default 28. Compared against the window before it."),
};

export const metadata: ToolMetadata = {
  name: "ga4_ai_traffic",
  description:
    "How much traffic arrives from AI assistants — ChatGPT, Perplexity, Claude, " +
    "Gemini, Copilot and the rest — which sources send it, which pages they land on, " +
    "and whether it is growing. No other Tool here answers this. Needs the Google " +
    "login; without it this Tool says so.",
  annotations: {
    title: "Read AI assistant traffic",
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: true,
  },
};

/** Completes the sentence "Could not …" for every failure this Tool can return. */
const FAILURE_CONTEXT = "read AI assistant traffic for this Analytics property";

/**
 * How many rows to ask GA4 for.
 *
 * High, because the filtering happens here rather than in the query: GA4 has no
 * dimension filter for "is an AI assistant" that covers both Google's own
 * classification and our supplementary host list, so the rows are read and
 * sorted through. A truncated read would silently drop AI sources sitting below
 * the cut.
 */
const ROW_LIMIT = 10_000;

/** How many landing pages to print. */
const MAX_PAGES = 15;

function percent(value: number): string {
  return `${value.toFixed(2)}%`;
}

/** `+31%`, `-12%`, or a note that there is nothing to compare against. */
function describeChange(now: number, before: number): string {
  if (before === 0) {
    return now > 0 ? "new — nothing in the previous window" : "nothing in either window";
  }
  const change = ((now - before) / before) * 100;
  const sign = change >= 0 ? "+" : "";
  return `${sign}${change.toFixed(0)}% against the previous window (${before})`;
}

export async function handler(
  { propertyId, days }: InferSchema<typeof schema>,
  google: GoogleReader,
) {
  const span = days ?? DEFAULT_DAYS;
  const window = ga4Window({ propertyId, days: span }, {
    title: `AI ASSISTANT TRAFFIC (last ${span} days)`,
  });
  const range = window.dateRange;

  // GA4's relative dates, not dates computed here — `ga4-tool-shape.ts` carries
  // the timezone reasoning for the current window, and this is the comparison.
  // The arithmetic is the trap: both ends are inclusive, so running the current
  // period from `days` ago to *today* while the comparison ran exactly `days`
  // made the current window a day longer and inflated every delta.
  const previous = { startDate: `${span * 2}daysAgo`, endDate: `${span + 1}daysAgo` };

  // Three reports at three grains, because sessions add up across rows and users
  // do not. The same person reaching two landing pages from ChatGPT is one user
  // and two rows, so a user count summed out of a source × landingPage report
  // overstates it. GA4 deduplicates within whatever grain it is asked for, so
  // each figure is read at the grain it is reported at.
  const [sourceReport, landingReport, previousReport] = await Promise.all([
    google.analytics.runReport({
      property: window.property,
      dateRanges: [range],
      dimensions: ["sessionSource", "sessionMedium"],
      metrics: ["sessions", "totalUsers"],
      limit: ROW_LIMIT,
    }),
    google.analytics.runReport({
      property: window.property,
      dateRanges: [range],
      dimensions: ["sessionSource", "sessionMedium", "landingPage"],
      metrics: ["sessions"],
      limit: ROW_LIMIT,
    }),
    google.analytics.runReport({
      property: window.property,
      dateRanges: [previous],
      dimensions: ["sessionSource", "sessionMedium"],
      metrics: ["sessions"],
      limit: ROW_LIMIT,
    }),
  ]);

  const sources = readReport(sourceReport);
  const landings = readReport(landingReport);
  const before = readReport(previousReport);

  const bySource = new Map<string, { sessions: number; users: number; verdict: string }>();
  let aiSessions = 0;
  let fromOurList = 0;

  for (const row of sources.rows) {
    const source = (row.dimensions[0] ?? "").toLowerCase();
    const medium = row.dimensions[1] ?? "";
    const verdict = classifyAiReferrer(source, medium);
    if (!verdict) continue;

    const sessions = row.metrics[0] ?? 0;
    const users = row.metrics[1] ?? 0;
    aiSessions += sessions;
    if (verdict === "host-list") fromOurList += sessions;

    const existing = bySource.get(source) ?? { sessions: 0, users: 0, verdict };
    bySource.set(source, {
      sessions: existing.sessions + sessions,
      users: existing.users + users,
      verdict,
    });
  }

  const beforeBySource = new Map<string, number>();
  let beforeTotal = 0;
  for (const row of before.rows) {
    const source = (row.dimensions[0] ?? "").toLowerCase();
    if (!isAiReferrer(source, row.dimensions[1] ?? "")) continue;
    const sessions = row.metrics[0] ?? 0;
    beforeTotal += sessions;
    beforeBySource.set(source, (beforeBySource.get(source) ?? 0) + sessions);
  }

  const byPage = new Map<string, number>();
  for (const row of landings.rows) {
    if (!isAiReferrer((row.dimensions[0] ?? "").toLowerCase(), row.dimensions[1] ?? "")) continue;
    const page = row.dimensions[2] || "/";
    byPage.set(page, (byPage.get(page) ?? 0) + (row.metrics[0] ?? 0));
  }

  const lines: string[] = [...window.header];

  // Sampling, thresholding and truncation all apply to the figures below, so
  // they are stated before any of them rather than in a footnote.
  const caveats = [...new Set([...sources.caveats, ...landings.caveats])];
  for (const caveat of caveats) {
    lines.push("");
    lines.push(`Note: ${caveat}`);
  }

  if (bySource.size === 0) {
    lines.push("");
    lines.push("No AI assistant traffic in this window.");
    lines.push("");
    lines.push('GA4 classified nothing as its "AI Assistant" channel, and no referral arrived');
    lines.push("from a host on the supplementary list this Tool keeps.");
    lines.push("");
    lines.push("That is a measurement, not a verdict on the site. It can mean AI engines are");
    lines.push("not citing you yet; it can also mean they cite you and readers arrive without a");
    lines.push("referrer, which is common — an assistant that summarises your page rather than");
    lines.push("linking to it sends no visit at all. seo_geo_score and ai_visibility_score look");
    lines.push("at whether the content is set up to be cited, which is the half this cannot see.");
    return toolText(lines.join("\n"));
  }

  // The denominator comes from GA4's own totals, not from adding up rows: `limit`
  // truncates, and a share computed over whatever survived it is a fraction of
  // the wrong number.
  const siteSessions = sources.totals[0] ?? 0;

  lines.push("");
  lines.push("=== SUMMARY ===");
  lines.push(`AI sessions: ${Math.round(aiSessions)}`);
  lines.push(
    siteSessions > 0
      ? `Share of all sessions: ${percent((aiSessions / siteSessions) * 100)} of ${Math.round(siteSessions)}`
      : "Share of all sessions: not available — GA4 reported no site total for this window",
  );
  lines.push(`Change: ${describeChange(aiSessions, beforeTotal)}`);

  if (fromOurList > 0) {
    // Google's answer and ours are not the same claim, and a report that mixed
    // them owes the reader the difference.
    lines.push("");
    lines.push(
      `Of those, ${Math.round(fromOurList)} session(s) were counted by this Tool's own host list ` +
        `rather than by Google's classification. Google moves recognised assistants into its ` +
        `"AI Assistant" channel; the list covers engines it has not recognised yet.`,
    );
  }

  lines.push("");
  lines.push(`=== BY SOURCE (${bySource.size}) ===`);
  const ranked = [...bySource.entries()].sort((a, b) => b[1].sessions - a[1].sessions);
  for (const [source, stats] of ranked) {
    lines.push(
      `  ${source} — ${Math.round(stats.sessions)} sessions, ${Math.round(stats.users)} users` +
        ` — ${describeChange(stats.sessions, beforeBySource.get(source) ?? 0)}`,
    );
    if (stats.verdict === "host-list") {
      lines.push("    (counted by this Tool's host list, not by Google's own classification)");
    }
  }

  if (byPage.size > 0) {
    lines.push("");
    lines.push(`=== LANDING PAGES (${byPage.size}) ===`);
    lines.push("Where AI assistants are sending people. These are the pages being cited.");
    const pages = [...byPage.entries()].sort((a, b) => b[1] - a[1]);
    for (const [page, sessions] of pages.slice(0, MAX_PAGES)) {
      lines.push(`  ${page} — ${Math.round(sessions)} sessions`);
    }
    if (pages.length > MAX_PAGES) {
      lines.push(...withheld(pages.length, MAX_PAGES));
    }
  }

  lines.push("");
  lines.push("=== WHAT THIS DOES NOT SEE ===");
  lines.push("Only visits that arrived with a referrer. An assistant that answers from your");
  lines.push("page without linking to it sends no visit, so this number is a floor on how");
  lines.push("often you are being read, not a count of it.");
  lines.push("");
  lines.push(`Hosts on the supplementary list: ${AI_REFERRER_HOSTS.join(", ")}.`);

  return toolText(lines.join("\n"));
}

export default defineGoogleTool(
  FAILURE_CONTEXT,
  { toolName: "ga4_ai_traffic", domainOf: () => null },
  handler,
);
