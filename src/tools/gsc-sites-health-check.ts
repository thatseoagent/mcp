import { z } from "zod";
import { type ToolMetadata, type InferSchema } from "xmcp";
import { defineGoogleTool } from "../lib/define-tool";
import { refreshable } from "../lib/with-cache";
import { toolText } from "../lib/tool-result";
import { resolveWindow } from "../lib/google/gsc-dates";
import { UpstreamApiError } from "../lib/upstream-api-error";
import type { GoogleReader, GscProperty } from "../lib/google/reader";

export const schema = {
  ...refreshable,
  days: z.number().int().optional().describe("How many days to total over. Default 28."),
};

export const metadata: ToolMetadata = {
  name: "gsc_sites_health_check",
  description:
    "Check every Search Console property this account holds at once: which can " +
    "actually return data, which are verified but silent, and what each one's clicks " +
    "and impressions were over the window. Use this to find out which properties are " +
    "worth looking at before running the per-site Tools. Needs the Google login; " +
    "without it this Tool says so.",
  annotations: {
    title: "Check every Search Console property",
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: true,
  },
};

/** Completes the sentence "Could not …" for every failure this Tool can return. */
const FAILURE_CONTEXT = "check the health of your Search Console properties";

/** How many properties to total. A consultancy account can hold a great many. */
const MAX_PROPERTIES = 40;

/** How many property queries run at once. */
const CONCURRENCY = 4;

type Health =
  | { property: GscProperty; state: "unverified" }
  | { property: GscProperty; state: "silent" }
  | { property: GscProperty; state: "active"; clicks: number; impressions: number }
  | { property: GscProperty; state: "unreadable"; reason: string };

async function checkOne(
  google: GoogleReader,
  property: GscProperty,
  window: { startDate: string; endDate: string },
): Promise<Health> {
  // Not asked at all. Google would answer 403, and spending a request to be told
  // something the property list already said is a request wasted on every run.
  if (property.permissionLevel === "siteUnverifiedUser") {
    return { property, state: "unverified" };
  }

  try {
    const rows = await google.searchConsole.searchAnalytics({
      siteUrl: property.siteUrl,
      startDate: window.startDate,
      endDate: window.endDate,
      // No dimensions: one row with the property's totals, which is the cheapest
      // question that distinguishes "has data" from "has none".
      rowLimit: 1,
    });

    if (rows.length === 0) return { property, state: "silent" };

    return {
      property,
      state: "active",
      clicks: rows[0].clicks,
      impressions: rows[0].impressions,
    };
  } catch (error) {
    // A property we could not ask about is deliberately its own state. Folding
    // it into "silent" would report a network failure as a site with no traffic,
    // which is the inversion this codebase keeps guarding against.
    return {
      property,
      state: "unreadable",
      reason:
        error instanceof UpstreamApiError
          ? error.message
          : "the query did not complete (its cause has been logged)",
    };
  }
}

export async function handler({ days }: InferSchema<typeof schema>, google: GoogleReader) {
  const window = resolveWindow({ days: days ?? 28 });
  const properties = await google.searchConsole.listProperties();

  const lines: string[] = ["=== SEARCH CONSOLE HEALTH CHECK ==="];

  if (properties.length === 0) {
    lines.push("");
    lines.push("This Google account can read no Search Console properties, so there is nothing");
    lines.push("to check. Add and verify a site at https://search.google.com/search-console, or");
    lines.push("re-run the login command if you expected a different account.");
    return toolText(lines.join("\n"));
  }

  const chosen = properties.slice(0, MAX_PROPERTIES);
  const results: Health[] = [];
  for (let start = 0; start < chosen.length; start += CONCURRENCY) {
    const batch = chosen.slice(start, start + CONCURRENCY);
    results.push(...(await Promise.all(batch.map((property) => checkOne(google, property, window)))));
  }

  lines.push(`Properties: ${properties.length}`);
  if (properties.length > MAX_PROPERTIES) {
    lines.push(`Only the first ${MAX_PROPERTIES} were queried.`);
  }
  lines.push(`Window: ${window.startDate} to ${window.endDate}`);
  for (const note of window.notes) {
    lines.push("");
    lines.push(`Note: ${note}`);
  }

  const active = results.filter((r): r is Extract<Health, { state: "active" }> => r.state === "active");
  const silent = results.filter((r) => r.state === "silent");
  const unverified = results.filter((r) => r.state === "unverified");
  const unreadable = results.filter((r) => r.state === "unreadable");

  lines.push("");
  lines.push("=== SUMMARY ===");
  lines.push(`With data in the window: ${active.length}`);
  lines.push(`Verified but no data in the window: ${silent.length}`);
  lines.push(`Unverified, so no data can be read: ${unverified.length}`);
  if (unreadable.length > 0) {
    lines.push(`Could not be queried on this run: ${unreadable.length}`);
  }

  if (active.length > 0) {
    lines.push("");
    lines.push(`=== WITH DATA (${active.length}) ===`);
    // Busiest first: a consultancy account holding thirty properties wants the
    // ones worth opening at the top.
    for (const result of [...active].sort((a, b) => b.clicks - a.clicks)) {
      lines.push(
        `  ${result.property.siteUrl} — ${result.clicks} clicks, ${result.impressions} impressions`,
      );
    }
  }

  if (silent.length > 0) {
    lines.push("");
    lines.push(`=== NO DATA IN THIS WINDOW (${silent.length}) ===`);
    lines.push("Verified and readable, and Google reported nothing for these dates. A new site,");
    lines.push("a seasonal one, or a property whose traffic really did stop — the window alone");
    lines.push("does not say which.");
    for (const result of silent) lines.push(`  ${result.property.siteUrl}`);
  }

  if (unverified.length > 0) {
    lines.push("");
    lines.push(`=== UNVERIFIED (${unverified.length}) ===`);
    lines.push("These were not queried: Google returns no data for an unverified property, so");
    lines.push("asking would spend a request to be told that. Verify them in Search Console.");
    for (const result of unverified) lines.push(`  ${result.property.siteUrl}`);
  }

  if (unreadable.length > 0) {
    lines.push("");
    lines.push(`=== NOT EVALUATED (${unreadable.length}) ===`);
    lines.push("Questions that did not get asked, not answers about these properties.");
    for (const result of unreadable) {
      if (result.state === "unreadable") lines.push(`  ${result.property.siteUrl} — ${result.reason}`);
    }
  }

  return toolText(lines.join("\n"));
}

export default defineGoogleTool(
  FAILURE_CONTEXT,
  { toolName: "gsc_sites_health_check", domainOf: () => null },
  handler,
);
