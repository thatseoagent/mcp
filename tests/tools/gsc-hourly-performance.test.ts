import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import { handler } from "@/tools/gsc-hourly-performance";
import { fakeGoogleReader } from "@/lib/google/fake-reader";
import { hourlyWindow, shiftDate } from "@/lib/google/gsc-dates";
import { UpstreamApiError } from "@/lib/upstream-api-error";
import { resetPersistence } from "@/lib/db/runtime";
import { resetAllSingleFlightCaches } from "@/lib/single-flight";
import type { SearchAnalyticsQuery, SearchAnalyticsResult, SearchAnalyticsRow } from "@/lib/google/reader";

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
  days: undefined,
  page: undefined,
  query: undefined,
};

function hour(date: string, hh: string, clicks: number): SearchAnalyticsRow {
  return {
    keys: [`${date}T${hh}:00:00-07:00`],
    clicks,
    impressions: clicks * 40,
    ctr: 0.025,
    position: 7,
  };
}

/** A reader that answers hourly reads with these rows and records what it was asked. */
function hourlyReader(result: SearchAnalyticsResult, queries: SearchAnalyticsQuery[] = []) {
  return fakeGoogleReader({
    searchConsole: {
      searchAnalyticsWithMetadata: async (query) => {
        queries.push(query);
        return result;
      },
    },
  });
}

describe("gsc_hourly_performance", () => {
  const { startDate, endDate } = hourlyWindow(3);
  const middle = shiftDate(endDate, -1);

  it("asks Google for hours on the hourly data state, over the last three Pacific days", async () => {
    const queries: SearchAnalyticsQuery[] = [];
    await handler(args, hourlyReader({ rows: [] }, queries));

    expect(queries[0]).toMatchObject({
      dimensions: ["hour"],
      dataState: "hourly_all",
      startDate,
      endDate,
    });
    expect(queries[0]).not.toHaveProperty("dimensionFilterGroups");
  });

  it("filters to one page and one query with exact matches, keeping one row per hour", async () => {
    const queries: SearchAnalyticsQuery[] = [];
    await handler(
      { ...args, page: "https://example.com/launch", query: "new thing" },
      hourlyReader({ rows: [] }, queries),
    );

    expect(queries[0].dimensions).toEqual(["hour"]);
    expect(queries[0].dimensionFilterGroups).toEqual([
      {
        groupType: "and",
        filters: [
          { dimension: "page", operator: "equals", expression: "https://example.com/launch" },
          { dimension: "query", operator: "equals", expression: "new thing" },
        ],
      },
    ]);
  });

  it("compares each hour today with the same hour on earlier days and marks partial hours", async () => {
    const text = textOf(
      await handler(
        args,
        hourlyReader({
          rows: [
            hour(startDate, "14", 20),
            hour(middle, "14", 40),
            hour(endDate, "13", 90),
            hour(endDate, "14", 45),
            hour(endDate, "15", 4),
          ],
          firstIncompleteHour: `${endDate}T15:00:00-07:00`,
        }),
      ),
    );

    expect(text).toContain("Times: Pacific Time");
    expect(text).toContain(`Still being collected from: ${endDate}T15:00:00-07:00`);
    expect(text).toContain("14:00 — 45 clicks, 1800 impressions — same hour on 2 earlier day(s): 30.0 clicks (+50%)");
    expect(text).toMatch(/15:00 — 4 clicks.* — partial/);
    expect(text).toContain(`=== ${endDate}, HOUR BY HOUR ===`);
    expect(text).toContain("1 still being collected");
  });

  it("says hourly data is noisy and to compare the same hour, not the adjacent one", async () => {
    const text = textOf(await handler(args, hourlyReader({ rows: [hour(endDate, "09", 3)] })));

    expect(text).toContain("hourly numbers are noisy");
    expect(text).toContain("and not with the hour before it");
    expect(text).toContain("no earlier day to compare");
  });

  it("prints a small difference in clicks rather than as a percentage", async () => {
    const text = textOf(
      await handler(args, hourlyReader({ rows: [hour(middle, "02", 1), hour(endDate, "02", 2)] })),
    );
    expect(text).toContain("1.0 clicks (+1.0)");
    expect(text).not.toContain("(+100%)");
  });

  it("answers an empty window with a sentence about the hours, not the site", async () => {
    const text = textOf(await handler({ ...args, page: "https://example.com/x" }, hourlyReader({ rows: [] })));

    expect(text).toContain("No hourly rows in this window");
    expect(text).toContain("Page: https://example.com/x");
    expect(text).toContain("=== WHAT THIS IS BASED ON ===");
  });

  it("leaves out rows whose key is not an hour and says how many", async () => {
    const text = textOf(await handler(args, fakeGoogleReader()));
    expect(text).toContain("Left out: 3 row(s) whose key was not an hour.");
    expect(text).not.toMatch(/NaN|undefined|Infinity/);
  });

  it("lets a refusal from Google through rather than answering with less", async () => {
    const reader = fakeGoogleReader({
      searchConsole: {
        searchAnalyticsWithMetadata: async () => {
          throw new UpstreamApiError("Google Search Console", 403);
        },
      },
    });
    await expect(handler({ ...args, siteUrl: "sc-domain:example.com" }, reader)).rejects.toBeInstanceOf(
      UpstreamApiError,
    );
  });
});
