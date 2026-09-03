import { z } from "zod";
import { type ToolMetadata, type InferSchema } from "xmcp";
import { defineGoogleTool } from "../lib/define-tool";
import { refreshable } from "../lib/with-cache";
import { toolText } from "../lib/tool-result";
import { withPropertyFallback } from "../lib/google/property";
import { resolveWindow } from "../lib/google/gsc-dates";
import type { GoogleReader, SearchAnalyticsRow } from "../lib/google/reader";

export const schema = {
  ...refreshable,
  siteUrl: z
    .string()
    .describe(
      "The Search Console property, or just the domain. `example.com`, " +
        "`sc-domain:example.com` and `https://example.com/` are all accepted; a bare " +
        "domain is matched against the properties this account can read.",
    ),
  dimensions: z
    .array(z.enum(["query", "page", "country", "device", "date", "searchAppearance"]))
    .optional()
    .describe(
      "How to break the numbers down. Omit for site totals. Combining two, such as " +
        "['page','query'], answers which queries land on which page.",
    ),
  startDate: z.string().optional().describe("YYYY-MM-DD. Defaults to `days` before the end date."),
  endDate: z
    .string()
    .optional()
    .describe("YYYY-MM-DD. Defaults to 3 days ago, because Search Console data lags."),
  days: z.number().int().optional().describe("Window length when no dates are given. Default 28."),
  type: z
    .enum(["web", "image", "video", "news", "discover", "googleNews"])
    .optional()
    .describe("Which search surface. Default `web`."),
  rowLimit: z.number().int().optional().describe("How many rows to return. Default 25, max 25000."),
};

export const metadata: ToolMetadata = {
  name: "gsc_search_analytics",
  description:
    "Read clicks, impressions, CTR and average position from Search Console, broken " +
    "down by query, page, country, device, date or search appearance. This is the " +
    "raw performance read the analysis Tools are built on. Needs the Google login; " +
    "without it this Tool says so.",
  annotations: {
    title: "Read Search Console performance",
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: true,
  },
};

/** Completes the sentence "Could not …" for every failure this Tool can return. */
const FAILURE_CONTEXT = "read Search Console performance for this site";

/** How many rows to return when the caller does not say. */
const DEFAULT_ROW_LIMIT = 25;

/** Google's ceiling for one Search Analytics request. */
const MAX_ROW_LIMIT = 25_000;

/**
 * A percentage, at the precision the number can carry.
 *
 * CTR arrives as a fraction. Printing it raw makes a reader do arithmetic to
 * compare it with anything else in their own reporting.
 */
function percent(value: number): string {
  return `${(value * 100).toFixed(2)}%`;
}

/**
 * Position, to one decimal.
 *
 * Google's average position is a mean over impressions and is not an integer;
 * rounding it to one would present 8.4 and 8.6 as the same rank.
 */
function position(value: number): string {
  return value.toFixed(1);
}

function renderRows(rows: readonly SearchAnalyticsRow[], dimensions: readonly string[]): string[] {
  const lines: string[] = [];
  const header = dimensions.length > 0 ? dimensions.join(" / ") : "(site total)";
  lines.push(`${header} — clicks / impressions / CTR / avg position`);

  for (const row of rows) {
    // `keys` is absent for an unfiltered query, which is a real answer rather
    // than a missing field: it is the site's total.
    const label = row.keys?.join(" / ") ?? "(all)";
    lines.push(
      `  ${label} — ${row.clicks} / ${row.impressions} / ${percent(row.ctr)} / ${position(row.position)}`,
    );
  }

  return lines;
}

export async function handler(
  { siteUrl, dimensions, startDate, endDate, days, type, rowLimit }: InferSchema<typeof schema>,
  google: GoogleReader,
) {
  const window = resolveWindow({ startDate, endDate, days });
  const wanted = dimensions ?? [];
  const limit = Math.min(MAX_ROW_LIMIT, Math.max(1, rowLimit ?? DEFAULT_ROW_LIMIT));

  const { result: rows, siteUrl: property } = await withPropertyFallback(
    google.searchConsole,
    siteUrl,
    (resolved) =>
      google.searchConsole.searchAnalytics({
        siteUrl: resolved,
        startDate: window.startDate,
        endDate: window.endDate,
        dimensions: wanted.length > 0 ? [...wanted] : undefined,
        type,
        rowLimit: limit,
      }),
  );

  const lines: string[] = ["=== SEARCH CONSOLE PERFORMANCE ==="];
  lines.push(`Property: ${property}`);
  lines.push(`Window: ${window.startDate} to ${window.endDate}`);
  lines.push(`Surface: ${type ?? "web"}`);
  for (const note of window.notes) {
    lines.push("");
    lines.push(`Note: ${note}`);
  }

  lines.push("");
  if (rows.length === 0) {
    // An empty result is an answer about the window, not about the site. Said
    // that way so nobody concludes their property is broken.
    lines.push("No rows for this window.");
    lines.push("");
    lines.push("That is a fact about the window rather than about the property: a site with no");
    lines.push("impressions in these dates returns nothing, and so does a window that ends");
    lines.push("inside Search Console's two-to-three-day lag. Widen the range before concluding");
    lines.push("anything, and use gsc_list_properties to confirm this is the property you meant.");
    return toolText(lines.join("\n"));
  }

  lines.push(`Rows: ${rows.length}${rows.length === limit ? ` (the limit asked for)` : ""}`);
  if (rows.length === limit) {
    // Google returns exactly the limit when there is more, so a full page is
    // indistinguishable from a complete answer unless it is said out loud.
    lines.push(
      "A full page came back, so there are probably more rows. Raise `rowLimit` to see them.",
    );
  }

  // Totals before the breakdown. A reader scanning twenty-five query rows cannot
  // add them up, and the sum of a *truncated* list is not the site's total
  // either — so this is labelled as the rows shown, not as the property's.
  const clicks = rows.reduce((total, row) => total + row.clicks, 0);
  const impressions = rows.reduce((total, row) => total + row.impressions, 0);
  lines.push(
    `Across the rows shown: ${clicks} clicks, ${impressions} impressions` +
      (impressions > 0 ? `, ${percent(clicks / impressions)} CTR` : ""),
  );

  lines.push("");
  lines.push(...renderRows(rows, wanted));

  return toolText(lines.join("\n"));
}

export default defineGoogleTool(
  FAILURE_CONTEXT,
  { toolName: "gsc_search_analytics", domainOf: (args) => args.siteUrl ?? null },
  handler,
);
