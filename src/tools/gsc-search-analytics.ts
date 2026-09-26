import { z } from "zod";
import { type ToolMetadata, type InferSchema } from "xmcp";
import { defineGoogleTool } from "../lib/define-tool";
import { refreshable } from "../lib/with-cache";
import { toolText } from "../lib/tool-result";
import { withPropertyFallback } from "../lib/google/property";
import { resolveWindow } from "../lib/google/gsc-dates";
import type { GoogleReader, SearchAnalyticsResult, SearchAnalyticsRow } from "../lib/google/reader";

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
        "['page','query'], answers which queries land on which page. There is no `hour` " +
        "here on purpose: an hourly read needs Google's hourly data state, a window of at " +
        "most ten days and a same-hour baseline to be read safely, and " +
        "gsc_hourly_performance does all three.",
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
  freshData: z
    .boolean()
    .optional()
    .describe(
      "Include the days Google is still collecting (its `all` data state), and end the " +
        "default window today rather than three days back. Default false: finished days only. " +
        "Fresh numbers for the last two or three days will still rise, and the answer says " +
        "which days those are when Google reports it — it does when the rows are grouped by `date`.",
    ),
};

export const metadata: ToolMetadata = {
  name: "gsc_search_analytics",
  description:
    "Read clicks, impressions, CTR and average position from Search Console, broken " +
    "down by query, page, country, device, date or search appearance. This is the " +
    "raw performance read the analysis Tools are built on; `freshData` adds the days " +
    "Google is still collecting. Needs the Google login; " +
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

/**
 * What Google said about which days are partial, as lines for the header.
 *
 * Google only names the first incomplete day when the rows are grouped by
 * `date`. Without that dimension its silence says nothing, and reading it as
 * "every day here is final" would be the false all-clear this is for.
 */
function partialDays(firstIncompleteDate: string | undefined, endDate: string, byDate: boolean): string[] {
  if (firstIncompleteDate) {
    return [
      `Partial: ${firstIncompleteDate} to ${endDate} — Google is still collecting these days, so ` +
        `their numbers will still rise. Do not compare them with finished days yet.`,
    ];
  }
  if (byDate) {
    return ["Partial: none — Google reported no incomplete day in this window."];
  }
  return [
    "Partial: not stated — Google only names the first incomplete day when the rows are grouped " +
      "by `date`. These are not, so the totals may include days still being collected; add " +
      "`date` to the dimensions to see which.",
  ];
}

function renderRows(
  rows: readonly SearchAnalyticsRow[],
  dimensions: readonly string[],
  firstIncompleteDate?: string,
): string[] {
  const lines: string[] = [];
  const dateIndex = dimensions.indexOf("date");
  const header = dimensions.length > 0 ? dimensions.join(" / ") : "(site total)";
  lines.push(`${header} — clicks / impressions / CTR / avg position`);

  for (const row of rows) {
    // `keys` is absent for an unfiltered query, which is a real answer rather
    // than a missing field: it is the site's total.
    const label = row.keys?.join(" / ") ?? "(all)";
    const date = dateIndex >= 0 ? row.keys?.[dateIndex] : undefined;
    const partial = firstIncompleteDate && date && date >= firstIncompleteDate ? " — partial" : "";
    lines.push(
      `  ${label} — ${row.clicks} / ${row.impressions} / ${percent(row.ctr)} / ${position(row.position)}${partial}`,
    );
  }

  return lines;
}

export async function handler(
  { siteUrl, dimensions, startDate, endDate, days, type, rowLimit, freshData }: InferSchema<typeof schema>,
  google: GoogleReader,
) {
  const fresh = freshData === true;
  const window = resolveWindow({ startDate, endDate, days, fresh });
  const wanted = dimensions ?? [];
  const limit = Math.min(MAX_ROW_LIMIT, Math.max(1, rowLimit ?? DEFAULT_ROW_LIMIT));

  const query = (resolved: string) => ({
    siteUrl: resolved,
    startDate: window.startDate,
    endDate: window.endDate,
    dimensions: wanted.length > 0 ? [...wanted] : undefined,
    type,
    rowLimit: limit,
  });

  // Two paths rather than one with an optional field, so a read that did not ask
  // for fresh data sends exactly the request it always sent. A fresh read goes
  // through the method that keeps Google's statement of which days are partial:
  // dropping it would hand over numbers that are still rising with nothing to
  // say so.
  const { result, siteUrl: property } = await withPropertyFallback(
    google.searchConsole,
    siteUrl,
    async (resolved): Promise<SearchAnalyticsResult> =>
      fresh
        ? google.searchConsole.searchAnalyticsWithMetadata({ ...query(resolved), dataState: "all" })
        : { rows: await google.searchConsole.searchAnalytics(query(resolved)) },
  );
  const { rows, firstIncompleteDate } = result;

  const lines: string[] = ["=== SEARCH CONSOLE PERFORMANCE ==="];
  lines.push(`Property: ${property}`);
  lines.push(`Window: ${window.startDate} to ${window.endDate}`);
  lines.push(`Surface: ${type ?? "web"}`);
  if (fresh) {
    lines.push("Data: fresh — includes days Google is still collecting");
    lines.push(...partialDays(firstIncompleteDate, window.endDate, wanted.includes("date")));
  }
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
  lines.push(...renderRows(rows, wanted, fresh ? firstIncompleteDate : undefined));

  return toolText(lines.join("\n"));
}

export default defineGoogleTool(
  FAILURE_CONTEXT,
  { toolName: "gsc_search_analytics", domainOf: (args) => args.siteUrl ?? null },
  handler,
);
