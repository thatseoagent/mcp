import { z } from "zod";
import { type ToolMetadata, type InferSchema } from "xmcp";
import { defineGoogleTool } from "../lib/define-tool";
import { refreshable } from "../lib/with-cache";
import { toolText } from "../lib/tool-result";
import { persistenceStatus } from "../lib/db/runtime";
import { NoDatabaseError, registerSite, rememberGoogleProperty } from "../lib/sites";
import { accessFor } from "../lib/google/property-access";
import { resolveWindow } from "../lib/google/gsc-dates";
import { classifyAiReferrer } from "../lib/google/ai-referrers";
import { readReport } from "../lib/google/ga4-report";
import { recordReadings, rollUpMonths, movementOf, type Reading } from "../lib/metric-history";
import { failRefresh, finishRefresh, startRefresh } from "../lib/site-refresh";
import { InvalidInputError } from "../lib/invalid-input-error";
import { analyzeSecurityHeaders } from "../lib/analyzers/security-analyzer";
import type { GoogleReader } from "../lib/google/reader";

export const schema = {
  ...refreshable,
  domain: z
    .string()
    .describe("The Site to audit, e.g. `example.com`. Registered automatically if it is new."),
  ga4PropertyId: z
    .string()
    .optional()
    .describe(
      "The GA4 property for this Site, e.g. `properties/123456789`. Analytics has no " +
        "identifier carrying a domain, so it cannot be inferred — run " +
        "sync_gsc_properties to see the candidates.",
    ),
  days: z.number().int().optional().describe("How many days the report covers. Default 28."),
};

export const metadata: ToolMetadata = {
  name: "run_site_audit",
  description:
    "The entry point. Audits a Site and produces the Full Report: its public surface, " +
    "Search Console and Analytics together, with every number recorded so the next run " +
    "can be compared against it. Refuses rather than degrading — without the Google " +
    "login, or without access to this Site's property, it says what to fix instead of " +
    "returning a smaller report. The credential-free Tools cover that case.",
  annotations: {
    title: "Run a full site audit",
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: false,
    openWorldHint: true,
  },
};

/** Completes the sentence "Could not …" for every failure this Tool can return. */
const FAILURE_CONTEXT = "run the full audit for this Site";

/**
 * The refusal an Operator without Property Access reads.
 *
 * ADR-0003, and the sentence matters as much as the refusal: this Tool *could*
 * return the public-surface analysis and call it a report, and the reason it
 * must not is that the Operator usually does have the access — so a degraded
 * result is far more likely to be a misconfiguration nobody surfaced than a
 * deliberate choice, and it arrives looking complete.
 *
 * An {@link InvalidInputError} because the Operator supplied the domain and is
 * the party who can fix the situation, which also makes the message safe to
 * publish through the Tool failure seam.
 */
function refuse(domain: string, why: string): InvalidInputError {
  return new InvalidInputError(
    `No Full Report for ${domain}: ${why}\n\n` +
      `This Tool does not fall back to a smaller report. The public-surface analysis it ` +
      `would contain is available on its own from the Tools that need no credentials — ` +
      `seo_analyze_page, crawl_site, seo_geo_score, seo_eeat_score, seo_security_headers, ` +
      `seo_crawlability_audit and seo_llms_txt — and calling one of those is an explicit ` +
      `choice rather than a report that quietly left half its subject out.`,
  );
}

/** `value` rounded to a sane precision for storage, or `null` if it is not a number. */
function measured(value: number | undefined): number | null {
  return typeof value === "number" && Number.isFinite(value) ? Math.round(value * 100) / 100 : null;
}

export async function handler(
  { domain, ga4PropertyId, days }: InferSchema<typeof schema>,
  google: GoogleReader,
) {
  const status = persistenceStatus();
  if (!status.available) {
    // History is the reason this Tool exists. Producing a report that is not
    // recorded would be a different Tool wearing this one's name.
    throw new NoDatabaseError(status.reason ?? "persistence is unavailable");
  }

  const site = registerSite(domain);

  // Property Access first, and asked of Google rather than read from the Site.
  const properties = await google.searchConsole.listProperties();
  const access = accessFor(site.domain, properties);
  rememberGoogleProperty(site.domain, { gscSiteUrl: access.siteUrl });

  if (access.state !== "granted") {
    throw refuse(site.domain, access.explanation);
  }

  const window = resolveWindow({ days: days ?? 28 });
  const refresh = startRefresh(site.id);

  try {
    const lines: string[] = ["=== FULL REPORT ==="];
    lines.push(`Site: ${site.domain}`);
    lines.push(`Search Console property: ${access.siteUrl}`);
    lines.push(`Window: ${window.startDate} to ${window.endDate}`);
    for (const note of window.notes) {
      lines.push("");
      lines.push(`Note: ${note}`);
    }

    const readings: Reading[] = [];

    // ── Search Console ─────────────────────────────────────────────────────
    const totals = await google.searchConsole.searchAnalytics({
      siteUrl: access.siteUrl!,
      startDate: window.startDate,
      endDate: window.endDate,
      rowLimit: 1,
    });
    const site_ = totals[0];

    lines.push("");
    lines.push("=== SEARCH CONSOLE ===");
    if (!site_) {
      // A window with no data is a real answer. Recorded as `null` rather than
      // zero: the section ran and Google reported nothing, which is not the same
      // as a site with no clicks.
      lines.push("No search data in this window.");
      for (const metric of ["gsc.clicks", "gsc.impressions", "gsc.ctr", "gsc.position"]) {
        readings.push({ metric, value: null });
      }
    } else {
      lines.push(`Clicks: ${site_.clicks}`);
      lines.push(`Impressions: ${site_.impressions}`);
      lines.push(`CTR: ${(site_.ctr * 100).toFixed(2)}%`);
      lines.push(`Average position: ${site_.position.toFixed(1)}`);
      readings.push(
        { metric: "gsc.clicks", value: measured(site_.clicks) },
        { metric: "gsc.impressions", value: measured(site_.impressions) },
        { metric: "gsc.ctr", value: measured(site_.ctr * 100) },
        { metric: "gsc.position", value: measured(site_.position) },
      );
    }

    const topQueries = await google.searchConsole.searchAnalytics({
      siteUrl: access.siteUrl!,
      startDate: window.startDate,
      endDate: window.endDate,
      dimensions: ["query"],
      rowLimit: 10,
    });
    if (topQueries.length > 0) {
      lines.push("");
      lines.push("Top queries — clicks / impressions / position");
      for (const row of topQueries) {
        lines.push(
          `  ${row.keys?.[0] ?? "(all)"} — ${row.clicks} / ${row.impressions} / ${row.position.toFixed(1)}`,
        );
      }
    }

    // ── Analytics ──────────────────────────────────────────────────────────
    lines.push("");
    lines.push("=== ANALYTICS ===");
    const property = ga4PropertyId ?? site.ga4PropertyId;
    if (!property) {
      // Named as not-run rather than as zero, and with the step that fixes it.
      // GA4 has no identifier carrying a domain, so this genuinely cannot be
      // inferred — which is a different thing from being unavailable.
      lines.push("Not run: no GA4 property is linked to this Site.");
      lines.push("GA4 identifies a property by a number, not by a domain, so it cannot be");
      lines.push("guessed. Run sync_gsc_properties to see the candidates, then pass");
      lines.push("`ga4PropertyId` here. Nothing below is missing because of this — the");
      lines.push("Analytics figures simply were not measured on this run.");
    } else {
      const sessions = await google.analytics.runReport({
        property,
        dateRanges: [{ startDate: `${days ?? 28}daysAgo`, endDate: "yesterday" }],
        dimensions: ["sessionSource", "sessionMedium"],
        metrics: ["sessions"],
        limit: 10_000,
      });
      const table = readReport(sessions);

      const total = table.totals[0] ?? 0;
      const ai = table.rows
        .filter((row) => classifyAiReferrer((row.dimensions[0] ?? "").toLowerCase(), row.dimensions[1] ?? ""))
        .reduce((sum, row) => sum + (row.metrics[0] ?? 0), 0);

      lines.push(`Property: ${property}`);
      lines.push(`Sessions: ${Math.round(total)}`);
      lines.push(`From AI assistants: ${Math.round(ai)}`);
      for (const caveat of table.caveats) lines.push(`Note: ${caveat}`);

      readings.push(
        { metric: "ga4.sessions", value: measured(total) },
        { metric: "ga4.aiSessions", value: measured(ai) },
      );
      rememberGoogleProperty(site.domain, { ga4PropertyId: property });
    }

    // ── Public surface ─────────────────────────────────────────────────────
    lines.push("");
    lines.push("=== PUBLIC SURFACE ===");
    const security = await analyzeSecurityHeaders(`https://${site.domain}/`);
    if (security.success) {
      lines.push(`Security headers: ${security.data.grade} (${security.data.score}/${security.data.maxScore})`);
      readings.push({
        metric: "security.score",
        value: measured((security.data.score / security.data.maxScore) * 100),
        grade: security.data.grade,
      });
    } else {
      // The section ran and could not answer. `null`, not zero — a site that was
      // briefly unreachable did not lose its headers.
      lines.push("Security headers: could not be read on this run.");
      readings.push({ metric: "security.score", value: null });
    }

    // ── History ────────────────────────────────────────────────────────────
    const stored = recordReadings(site.id, refresh?.id ?? null, readings);
    rollUpMonths(site.id);

    lines.push("");
    lines.push("=== AGAINST LAST TIME ===");
    const movements = readings
      .map((reading) => movementOf(site.id, reading.metric))
      .filter((movement): movement is NonNullable<typeof movement> => movement !== null)
      .filter((movement) => movement.change !== null);

    if (movements.length === 0) {
      lines.push("Nothing to compare against yet: this is the first run that recorded these");
      lines.push(`numbers. ${stored} reading(s) were stored, and the next run will show movement.`);
    } else {
      for (const movement of movements) {
        const direction = movement.improved ? "better" : movement.improved === false ? "worse" : "flat";
        const sign = (movement.change ?? 0) >= 0 ? "+" : "";
        lines.push(
          `  ${movement.metric.label}: ${movement.latest} (${sign}${(movement.change ?? 0).toFixed(2)}, ${direction})`,
        );
      }
      lines.push("");
      lines.push("seo_metric_trend shows the whole series for any of these.");
    }

    const report = lines.join("\n");
    if (refresh) finishRefresh(refresh.id, report);
    return toolText(report);
  } catch (error) {
    // A refresh left `pending` forever is how an Operator ends up unable to tell
    // a run that is still going from one that died halfway.
    if (refresh) failRefresh(refresh.id);
    throw error;
  }
}

export default defineGoogleTool(
  FAILURE_CONTEXT,
  {
    toolName: "run_site_audit",
    domainOf: (args) => args.domain ?? null,
    // Short, because this Tool writes history: a cached answer would mean a run
    // the Operator asked for that recorded nothing, and a gap in the series they
    // cannot see.
    ttlMs: 60_000,
  },
  handler,
);
