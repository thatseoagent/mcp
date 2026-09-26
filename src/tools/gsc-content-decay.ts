import { z } from "zod";
import { type ToolMetadata, type InferSchema } from "xmcp";
import { defineGoogleTool } from "../lib/define-tool";
import { refreshable } from "../lib/with-cache";
import { toolText } from "../lib/tool-result";
import { DEFAULT_ROW_LIMIT, fetchRows, readAgain } from "../lib/google/gsc-tool-shape";
import { calendarMonths } from "../lib/google/gsc-dates";
import {
  DECAY_SPAN,
  DEFAULT_DECAY,
  SEASONAL_RATIO,
  decayingPages,
  monthlyClicksByPage,
  type DecayingPage,
} from "../lib/google/gsc-analysis";
import type { GoogleReader } from "../lib/google/reader";
import { withheld } from "../lib/render-list";

/** Google keeps sixteen months, so that is the longest horizon there is. */
const MAX_MONTHS = 16;
const DEFAULT_MONTHS = 12;

export const schema = {
  ...refreshable,
  siteUrl: z
    .string()
    .describe(
      "The Search Console property, or just the domain. `example.com`, " +
        "`sc-domain:example.com` and `https://example.com/` are all accepted.",
    ),
  months: z
    .number()
    .int()
    .min(DECAY_SPAN * 2)
    .max(MAX_MONTHS)
    .optional()
    .describe(
      `How many complete calendar months to read. Default ${DEFAULT_MONTHS}, at most ` +
        `${MAX_MONTHS} (Google's retention). 13 or more lets the recent months be compared ` +
        `with the same months a year earlier, which is how seasonality is told apart from decay.`,
    ),
  minPeakClicks: z
    .number()
    .min(0)
    .optional()
    .describe(
      `The clicks a month a page must have averaged at its peak for a fall to count. Default ` +
        `${DEFAULT_DECAY.minPeakClicks}.`,
    ),
  minDecline: z
    .number()
    .min(0)
    .max(100)
    .optional()
    .describe(
      `How far, in percent, the last three months must be below the peak. Default ` +
        `${DEFAULT_DECAY.minDecline}.`,
    ),
};

export const metadata: ToolMetadata = {
  name: "gsc_content_decay",
  description:
    "Which pages have been losing search clicks over the long run: each page's last three " +
    "months against its best three, month by month across up to sixteen months, with a " +
    "year-over-year check to tell a falling page from a seasonal one. The read for deciding " +
    "what to refresh. Needs the Google login; without it this Tool says so.",
  annotations: {
    title: "Find pages losing clicks over months",
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: true,
  },
};

/** Completes the sentence "Could not …" for every failure this Tool can return. */
const FAILURE_CONTEXT = "find the pages on this site that are losing search clicks";

const MAX_PAGES = 25;

function readingLine(page: DecayingPage): string {
  switch (page.reading) {
    case "decay":
      return (
        `    Year over year: ${Math.round(page.yearOverYear! * 100)}% of the same ` +
        `${page.yearOverYearMonths} month(s) a year earlier — lower than last year too, so ` +
        `this looks like decay rather than the calendar.`
      );
    case "seasonal":
      return (
        `    Year over year: ${Math.round(page.yearOverYear! * 100)}% of the same ` +
        `${page.yearOverYearMonths} month(s) a year earlier — about as low then, so this may be ` +
        `seasonal rather than decay.`
      );
    default:
      return page.yearOverYearMonths > 0
        ? "    Year over year: no clicks in the same months a year earlier, so seasonality cannot be told apart."
        : "    Year over year: not checked — the window does not reach back a year from these months.";
  }
}

export async function handler(
  { siteUrl, months, minPeakClicks, minDecline }: InferSchema<typeof schema>,
  google: GoogleReader,
) {
  const horizon = calendarMonths(months ?? DEFAULT_MONTHS);
  const config = {
    minPeakClicks: minPeakClicks ?? DEFAULT_DECAY.minPeakClicks,
    minDecline: minDecline ?? DEFAULT_DECAY.minDecline,
  };

  // ── One read per month, not one read of page × date ──
  //
  // Page × date over sixteen months is a row per page per day: a site with two
  // thousand pages earning clicks is most of a million rows, past what Google
  // will return, and the truncation would fall on exactly the small and fading
  // pages this Tool looks for. One `page` read per month is a row per page per
  // month, which is the grain the analysis wants anyway. The whole-horizon read
  // opens the report — it resolves the property once for all the others, and its
  // header and footer describe the window as a whole. Grouped by page, Google
  // aggregates by page on its own, so `aggregationType` is not sent.
  const whole = await fetchRows(
    google.searchConsole,
    { siteUrl, startDate: horizon.startDate, endDate: horizon.endDate },
    { dimensions: ["page"], rowLimit: DEFAULT_ROW_LIMIT, title: "PAGES LOSING SEARCH CLICKS" },
  );

  const reads = await Promise.all(
    horizon.months.map(async (month) => ({
      month: month.month,
      rows: await readAgain(google.searchConsole, whole, {
        dimensions: ["page"],
        rowLimit: DEFAULT_ROW_LIMIT,
        window: month,
      }),
    })),
  );
  const truncated = reads.filter((read) => read.rows.length >= DEFAULT_ROW_LIMIT);

  const lines = [...whole.header];
  lines.push(`Months: ${horizon.months.length} complete calendar month(s), each read on its own`);
  for (const note of horizon.notes) {
    lines.push("");
    lines.push(`Note: ${note}`);
  }
  lines.push("");
  lines.push(
    `Thresholds (this Tool's, not Google's): a page counts when its best ${DECAY_SPAN} consecutive ` +
      `months averaged at least ${config.minPeakClicks} clicks a month and its last ${DECAY_SPAN} ` +
      `are at least ${config.minDecline}% below that. "Seasonal" means the same months a year ` +
      `earlier had no more than ${Math.round((1 / SEASONAL_RATIO - 1) * 100)}% more clicks.`,
  );
  if (truncated.length > 0) {
    lines.push("");
    lines.push(
      `Truncated: ${truncated.map((read) => read.month).join(", ")} returned the full ` +
        `${DEFAULT_ROW_LIMIT} rows asked for, so pages below the cut in those months read as ` +
        `zero clicks there. A fall into one of those months may be the cut rather than the page.`,
    );
  }

  if (horizon.months.length < DECAY_SPAN * 2) {
    lines.push("");
    lines.push(
      `Only ${horizon.months.length} complete month(s) are available, and comparing a recent ` +
        `${DECAY_SPAN} months with an earlier peak needs at least ${DECAY_SPAN * 2}.`,
    );
    lines.push(...whole.footer);
    return toolText(lines.join("\n"));
  }

  const byPage = monthlyClicksByPage(reads);
  if (byPage.size === 0) {
    lines.push("");
    lines.push("No page rows in any of these months, so there is nothing to compare.");
    lines.push(...whole.footer);
    return toolText(lines.join("\n"));
  }

  const monthNames = horizon.months.map((month) => month.month);
  const findings = decayingPages(monthNames, byPage, config);

  lines.push("");
  lines.push(`Pages with clicks in at least one month: ${byPage.size}`);
  lines.push(`Pages below their peak by the threshold: ${findings.length}`);

  if (findings.length === 0) {
    lines.push("");
    lines.push("No page in these rows has fallen that far from its own peak. That is a finding about");
    lines.push("pages that earned clicks here; a page that never did is not in the rows at all.");
  } else {
    const counts = {
      decay: findings.filter((page) => page.reading === "decay").length,
      seasonal: findings.filter((page) => page.reading === "seasonal").length,
      unknown: findings.filter((page) => page.reading === "unknown").length,
    };
    lines.push(
      `  Lower than a year earlier too: ${counts.decay}; about as low a year earlier: ` +
        `${counts.seasonal}; year over year not checked: ${counts.unknown}`,
    );
    lines.push("");
    lines.push(`=== PAGES (${findings.length}, by clicks lost a month) ===`);
    for (const page of findings.slice(0, MAX_PAGES)) {
      const series = byPage.get(page.page) ?? [];
      lines.push(
        `  ${page.page} — ${page.recentAverage.toFixed(1)} clicks/month over the last ` +
          `${DECAY_SPAN} months against ${page.peakAverage.toFixed(1)} at its peak from ` +
          `${page.peakFrom} (-${Math.round(page.decline * 100)}%)`,
      );
      lines.push(`    By month: ${series.map((clicks) => Math.round(clicks)).join(", ")}`);
      lines.push(readingLine(page));
    }
    if (findings.length > MAX_PAGES) {
      lines.push(...withheld(findings.length, MAX_PAGES, { noun: "pages" }));
    }
  }

  lines.push("");
  lines.push("=== HOW TO READ THIS ===");
  lines.push(`Months, oldest first: ${monthNames.join(", ")}.`);
  lines.push("This is a heuristic over one page's clicks, not a model of seasonality or of why a page");
  lines.push("fell. The year-over-year check only tells the calendar apart where the window reaches a");
  lines.push("year back; with fewer than 13 months it cannot, and says so. A fall can also be a URL");
  lines.push("that moved — a redirect sends its clicks to a different page in these rows — or a query");
  lines.push("that lost demand rather than rank. gsc_page_query_map shows what a page ranks for now.");

  lines.push(...whole.footer);
  return toolText(lines.join("\n"));
}

export default defineGoogleTool(
  FAILURE_CONTEXT,
  { toolName: "gsc_content_decay", domainOf: (args) => args.siteUrl ?? null },
  handler,
);
