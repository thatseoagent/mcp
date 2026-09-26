import { z } from "zod";
import { type ToolMetadata, type InferSchema } from "xmcp";
import { defineGoogleTool } from "../lib/define-tool";
import { refreshable } from "../lib/with-cache";
import { toolText } from "../lib/tool-result";
import { fetchRows } from "../lib/google/gsc-tool-shape";
import { HOURLY_RETENTION_DAYS, hourlyWindow } from "../lib/google/gsc-dates";
import { hourlyReadings, type HourReading } from "../lib/google/gsc-analysis";
import type { GoogleReader } from "../lib/google/reader";

export const schema = {
  ...refreshable,
  siteUrl: z
    .string()
    .describe(
      "The Search Console property, or just the domain. `example.com`, " +
        "`sc-domain:example.com` and `https://example.com/` are all accepted.",
    ),
  days: z
    .number()
    .int()
    .min(1)
    .max(HOURLY_RETENTION_DAYS)
    .optional()
    .describe(
      "How many Pacific days to read, today included. Default 3, at most 10 — Google keeps " +
        "the hourly breakdown for ten days. More days make a steadier same-hour baseline; 8 " +
        "or more also reaches the same weekday a week earlier.",
    ),
  page: z
    .string()
    .optional()
    .describe(
      "One page's URL, exactly as Search Console records it, to read only that page. Omit " +
        "for the whole property.",
    ),
  query: z
    .string()
    .optional()
    .describe("One search query, matched exactly, to read only that query. Omit for every query."),
};

export const metadata: ToolMetadata = {
  name: "gsc_hourly_performance",
  description:
    "Clicks and impressions hour by hour over the last few days, in Pacific Time, for the " +
    "whole property or one page or query — the read for \"did the deploy or the publish at " +
    "14:00 change anything today?\". Each hour is compared with the same hour on the previous " +
    "days, and hours Google is still collecting are marked. Needs the Google login; without " +
    "it this Tool says so.",
  annotations: {
    title: "Read Search Console hour by hour",
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: false,
    openWorldHint: true,
  },
};

/** Completes the sentence "Could not …" for every failure this Tool can return. */
const FAILURE_CONTEXT = "read this site's hourly Search Console performance";

const DEFAULT_DAYS = 3;

/**
 * The difference from the baseline worth printing as a percentage.
 *
 * Below this many baseline clicks an hour, "+50%" is one click becoming two and
 * reads as a finding it is not. Ours, not Google's.
 */
const MIN_BASELINE_FOR_PERCENT = 10;

/** `+14%`, `-30%`, or the raw difference when the baseline is too small for a ratio. */
function againstBaseline(reading: HourReading): string {
  if (reading.baselineClicks === null) return "no earlier day to compare";
  const baseline = reading.baselineClicks;
  const days = `${reading.baselineDays} earlier day(s)`;
  if (baseline < MIN_BASELINE_FOR_PERCENT) {
    const difference = reading.clicks - baseline;
    const sign = difference >= 0 ? "+" : "";
    return `same hour on ${days}: ${baseline.toFixed(1)} clicks (${sign}${difference.toFixed(1)})`;
  }
  const change = ((reading.clicks - baseline) / baseline) * 100;
  const sign = change >= 0 ? "+" : "";
  return `same hour on ${days}: ${baseline.toFixed(1)} clicks (${sign}${change.toFixed(0)}%)`;
}

function filtersFor(page?: string, query?: string): unknown[] | undefined {
  const filters = [
    ...(page ? [{ dimension: "page", operator: "equals", expression: page }] : []),
    ...(query ? [{ dimension: "query", operator: "equals", expression: query }] : []),
  ];
  return filters.length > 0 ? [{ groupType: "and", filters }] : undefined;
}

export async function handler(
  { siteUrl, days, page, query }: InferSchema<typeof schema>,
  google: GoogleReader,
) {
  const window = hourlyWindow(days ?? DEFAULT_DAYS);

  // `hourly_all` is not optional: Google only groups by hour on that data
  // state, which is also its way of saying every hour in the answer may still
  // be partial. The filter narrows the rows without adding a dimension, so each
  // row stays one hour.
  const fetched = await fetchRows(
    google.searchConsole,
    { siteUrl, startDate: window.startDate, endDate: window.endDate },
    {
      dimensions: ["hour"],
      dataState: "hourly_all",
      dimensionFilterGroups: filtersFor(page, query),
      title: "SEARCH CONSOLE HOUR BY HOUR",
    },
  );

  const readings = hourlyReadings(fetched.rows, fetched.firstIncompleteHour);
  const skipped = fetched.rows.length - readings.length;

  const lines = [...fetched.header];
  lines.push("Times: Pacific Time (America/Los_Angeles), which is how Google reports every hour.");
  if (page) lines.push(`Page: ${page}`);
  if (query) lines.push(`Query: ${query}`);
  if (fetched.firstIncompleteHour) {
    lines.push(
      `Still being collected from: ${fetched.firstIncompleteHour}. Hours from then on are marked ` +
        `"partial" — their numbers will still rise.`,
    );
  }
  if (skipped > 0) {
    lines.push(`Left out: ${skipped} row(s) whose key was not an hour.`);
  }

  if (readings.length === 0) {
    lines.push("");
    lines.push(
      "No hourly rows in this window. That is a fact about these hours rather than the site: " +
        "a page or query with no impressions in them returns nothing, and so does one written " +
        "differently from how Search Console records it — a trailing slash or a query string " +
        "makes it a different page.",
    );
    lines.push(...fetched.footer);
    return toolText(lines.join("\n"));
  }

  // Day totals first, so the shape of the window is visible before the hours.
  const dates = [...new Set(readings.map((reading) => reading.date))];
  lines.push("");
  lines.push("=== BY DAY ===");
  for (const date of dates) {
    const hours = readings.filter((reading) => reading.date === date);
    const clicks = hours.reduce((sum, reading) => sum + reading.clicks, 0);
    const impressions = hours.reduce((sum, reading) => sum + reading.impressions, 0);
    const partial = hours.filter((reading) => reading.partial).length;
    lines.push(
      `  ${date} — ${Math.round(clicks)} clicks, ${Math.round(impressions)} impressions, ` +
        `${hours.length} hour(s) reported` +
        (partial > 0 ? `, ${partial} still being collected` : ""),
    );
  }

  // The latest day, hour by hour, against its own hours on the days before.
  const latest = dates[dates.length - 1];
  lines.push("");
  lines.push(`=== ${latest}, HOUR BY HOUR ===`);
  for (const reading of readings.filter((entry) => entry.date === latest)) {
    const weekAgo = reading.weekAgoClicks === null ? "" : `; a week earlier ${reading.weekAgoClicks}`;
    lines.push(
      `  ${reading.hour}:00 — ${reading.clicks} clicks, ${reading.impressions} impressions — ` +
        `${againstBaseline(reading)}${weekAgo}${reading.partial ? " — partial" : ""}`,
    );
  }

  lines.push("");
  lines.push("=== HOW TO READ THIS ===");
  lines.push("An hour is a small sample, so hourly numbers are noisy. Compare an hour with the same");
  lines.push("hour on earlier days — that is what the baseline is — and not with the hour before it:");
  lines.push("search traffic has a daily shape, and adjacent hours differ because of it.");
  lines.push(
    `Below ${MIN_BASELINE_FOR_PERCENT} clicks an hour the difference is printed in clicks rather ` +
      `than as a percentage (this Tool's threshold): one click becoming two would otherwise ` +
      `print as a doubling.`,
  );
  lines.push("A partial hour is left out of every baseline and is expected to look low: judge it once");
  lines.push("Google has finished counting it. A change that persists over several hours and holds");
  lines.push("against the baseline is worth acting on; one hour out of line is not.");

  lines.push(...fetched.footer);
  return toolText(lines.join("\n"));
}

export default defineGoogleTool(
  FAILURE_CONTEXT,
  {
    toolName: "gsc_hourly_performance",
    domainOf: (args) => args.siteUrl ?? null,
    // Fifteen minutes. The point of this read is data that is still arriving,
    // and an hour-old answer would hide the hour the Operator is asking about.
    ttlMs: 15 * 60_000,
  },
  handler,
);
