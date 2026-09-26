import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import { handler } from "@/tools/gsc-content-decay";
import { fakeGoogleReader } from "@/lib/google/fake-reader";
import { calendarMonths } from "@/lib/google/gsc-dates";
import { DEFAULT_ROW_LIMIT } from "@/lib/google/gsc-tool-shape";
import { UpstreamApiError } from "@/lib/upstream-api-error";
import { resetPersistence } from "@/lib/db/runtime";
import { resetAllSingleFlightCaches } from "@/lib/single-flight";
import type { SearchAnalyticsQuery, SearchAnalyticsRow } from "@/lib/google/reader";

beforeEach(() => {
  resetAllSingleFlightCaches();
});

afterEach(() => {
  resetPersistence();
  vi.restoreAllMocks();
});

const textOf = (result: { content: Array<{ text: string }> }): string =>
  result.content.map((part) => part.text).join("\n");

const args = {
  force_refresh: undefined,
  siteUrl: "example.com",
  months: undefined,
  minPeakClicks: undefined,
  minDecline: undefined,
};

function page(url: string, clicks: number): SearchAnalyticsRow {
  return { keys: [url], clicks, impressions: clicks * 30, ctr: 1 / 30, position: 6 };
}

/**
 * A reader that answers each month's read from a per-month function, and the
 * whole-horizon read with whatever the months add up to.
 */
function monthlyReader(
  clicksFor: (monthIndex: number, month: string) => SearchAnalyticsRow[],
  count: number,
  queries: SearchAnalyticsQuery[] = [],
) {
  const { months } = calendarMonths(count);
  return fakeGoogleReader({
    searchConsole: {
      searchAnalytics: async (query) => {
        queries.push(query);
        const index = months.findIndex(
          (month) => month.startDate === query.startDate && month.endDate === query.endDate,
        );
        if (index >= 0) return clicksFor(index, months[index].month);
        // The whole horizon: each page's months, added up.
        const totals = new Map<string, number>();
        months.forEach((month, monthIndex) => {
          for (const row of clicksFor(monthIndex, month.month)) {
            totals.set(row.keys![0], (totals.get(row.keys![0]) ?? 0) + row.clicks);
          }
        });
        return [...totals.entries()].map(([url, clicks]) => page(url, clicks));
      },
    },
  });
}

describe("gsc_content_decay", () => {
  // How many complete months fifteen asks for turns out to be depends on the
  // day: retention can have eaten into the oldest one. The fixtures are written
  // against whatever the count is today.
  const n = calendarMonths(15).months.length;

  it("reads one page read per complete month, plus the whole horizon, all by page", async () => {
    const queries: SearchAnalyticsQuery[] = [];
    await handler(args, monthlyReader(() => [], 12, queries));

    expect(queries).toHaveLength(calendarMonths(12).months.length + 1);
    for (const query of queries) {
      expect(query.dimensions).toEqual(["page"]);
      expect(query.rowLimit).toBe(DEFAULT_ROW_LIMIT);
    }
  });

  it("flags a falling page, names the thresholds, and says the reading is a heuristic", async () => {
    const text = textOf(
      await handler(
        { ...args, months: 15 },
        monthlyReader(
          (index) => [
            page("https://example.com/falling", index < n - 3 ? 100 : 20),
            page("https://example.com/steady", 50),
          ],
          15,
        ),
      ),
    );

    expect(text).toContain("=== PAGES LOSING SEARCH CLICKS ===");
    expect(text).toMatch(/^Window: \d{4}-\d{2}-01 to \d{4}-\d{2}-\d{2}$/m);
    expect(text).toContain("Thresholds (this Tool's, not Google's)");
    expect(text).toContain("at least 20 clicks a month");
    expect(text).toContain("at least 40% below");
    expect(text).toContain("https://example.com/falling — 20.0 clicks/month over the last 3 months against 100.0");
    expect(text).toContain("(-80%)");
    expect(text).toContain("looks like decay rather than the calendar");
    expect(text).not.toContain("https://example.com/steady —");
    expect(text).toContain("This is a heuristic");
  });

  it("calls a fall that happened a year earlier too possibly seasonal", async () => {
    // Low in the first three months and the last three: the calendar, not the page.
    const text = textOf(
      await handler(
        { ...args, months: 15 },
        monthlyReader((index) => [page("https://example.com/ski", index < 3 || index >= n - 3 ? 20 : 100)], 15),
      ),
    );
    expect(text).toContain("may be seasonal rather than decay");
  });

  it("says year over year was not checked when the window does not reach back a year", async () => {
    const text = textOf(
      await handler(
        { ...args, months: 9 },
        monthlyReader((index) => [page("https://example.com/a", index < 6 ? 100 : 10)], 9),
      ),
    );
    expect(text).toContain("Year over year: not checked");
  });

  it("applies thresholds the caller gives", async () => {
    const text = textOf(
      await handler(
        { ...args, months: 9, minDecline: 90 },
        monthlyReader((index) => [page("https://example.com/a", index < 6 ? 100 : 20)], 9),
      ),
    );
    expect(text).toContain("at least 90% below");
    expect(text).toContain("Pages below their peak by the threshold: 0");
  });

  it("names a month whose read came back at the row limit", async () => {
    const full = Array.from({ length: DEFAULT_ROW_LIMIT }, (_, index) => page(`https://example.com/p${index}`, 1));
    const text = textOf(
      await handler({ ...args, months: 6 }, monthlyReader((index) => (index === 5 ? full : []), 6)),
    );
    const { months } = calendarMonths(6);
    expect(text).toContain(`Truncated: ${months[5].month} returned the full`);
  });

  it("answers an empty horizon with a sentence, not a failure", async () => {
    const text = textOf(await handler(args, monthlyReader(() => [], 12)));
    expect(text).toContain("No page rows in any of these months");
    expect(text).toContain("=== WHAT THIS IS BASED ON ===");
  });

  it("lets a refusal from Google through rather than answering with less", async () => {
    const reader = fakeGoogleReader({
      searchConsole: {
        searchAnalytics: async () => {
          throw new UpstreamApiError("Google Search Console", 403);
        },
      },
    });
    await expect(handler({ ...args, siteUrl: "sc-domain:example.com" }, reader)).rejects.toBeInstanceOf(
      UpstreamApiError,
    );
  });
});
