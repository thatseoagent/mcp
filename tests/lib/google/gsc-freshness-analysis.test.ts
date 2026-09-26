import { describe, expect, it } from "vitest";
import {
  DEFAULT_DECAY,
  decayingPages,
  hourlyReadings,
  monthlyClicksByPage,
  parseHourKey,
} from "@/lib/google/gsc-analysis";
import {
  calendarMonths,
  hourlyWindow,
  pacificToday,
  resolveWindow,
  shiftDate,
} from "@/lib/google/gsc-dates";
import { fetchRows, readAgain } from "@/lib/google/gsc-tool-shape";
import { fakeGoogleReader } from "@/lib/google/fake-reader";
import type { SearchAnalyticsQuery, SearchAnalyticsRow } from "@/lib/google/reader";

/**
 * The pure halves of the freshness and long-horizon reads: hours against the
 * same hour on earlier days, months against a page's own peak, and the windows
 * both of them ask Google for.
 */

function row(keys: string[], clicks: number, impressions = clicks * 10): SearchAnalyticsRow {
  return { keys, clicks, impressions, ctr: impressions > 0 ? clicks / impressions : 0, position: 5 };
}

describe("Pacific days", () => {
  it("is still yesterday in Pacific Time for the first hours of a UTC day", () => {
    // 03:00 UTC on the 24th is 20:00 on the 23rd in Los Angeles. A window that
    // ended on UTC's today would ask for a day Google has not started.
    expect(pacificToday(new Date("2026-09-24T03:00:00Z"))).toBe("2026-09-23");
    expect(pacificToday(new Date("2026-09-24T12:00:00Z"))).toBe("2026-09-24");
  });

  it("reads the last N days, today included, and never more than Google's ten", () => {
    const now = new Date("2026-09-24T18:00:00Z");
    expect(hourlyWindow(3, now)).toEqual({ startDate: "2026-09-22", endDate: "2026-09-24" });
    expect(hourlyWindow(1, now)).toEqual({ startDate: "2026-09-24", endDate: "2026-09-24" });
    expect(hourlyWindow(40, now).startDate).toBe(shiftDate("2026-09-24", -9));
  });

  it("ends a fresh window today and says the last days will still rise", () => {
    const now = new Date("2026-09-24T18:00:00Z");
    const window = resolveWindow({ fresh: true, days: 7 }, now);

    expect(window.endDate).toBe("2026-09-24");
    // Seven days, both ends inclusive: the 18th through the 24th.
    expect(window.startDate).toBe("2026-09-18");
    expect(window.notes.join(" ")).toContain("will rise");
    expect(window.notes.join(" ")).not.toContain("lags by two to three days, and including today");
  });

  it("spans exactly the days asked for, both ends included", () => {
    // It started `days` before the end, which made "28 days" 29.
    const now = new Date("2026-09-24T18:00:00Z");
    const window = resolveWindow({ days: 28 }, now);

    expect(window.endDate).toBe("2026-09-21");
    expect(window.startDate).toBe("2026-08-25");
    const span = (Date.parse(window.endDate) - Date.parse(window.startDate)) / 86_400_000 + 1;
    expect(span).toBe(28);
  });

  it("leaves the finished-data window exactly as it was", () => {
    const now = new Date("2026-09-24T18:00:00Z");
    expect(resolveWindow({ fresh: false }, now)).toEqual(resolveWindow({}, now));
  });
});

describe("calendar months", () => {
  it("ends on the last month outside the lag and never includes the current one", () => {
    const window = calendarMonths(12, new Date("2026-09-24T12:00:00Z"));

    expect(window.months).toHaveLength(12);
    expect(window.months[11]).toEqual({ month: "2026-08", startDate: "2026-08-01", endDate: "2026-08-31" });
    expect(window.months[0].month).toBe("2025-09");
    expect(window.startDate).toBe("2025-09-01");
    expect(window.endDate).toBe("2026-08-31");
  });

  it("treats a month whose last day is still inside the lag as unfinished", () => {
    // 2 September: the last days of August are not settled yet.
    const window = calendarMonths(6, new Date("2026-09-02T12:00:00Z"));
    expect(window.months[5].month).toBe("2026-07");
  });

  it("drops a month retention has already eaten into, and says so", () => {
    const window = calendarMonths(16, new Date("2026-09-24T12:00:00Z"));

    expect(window.months.length).toBeLessThan(16);
    expect(window.notes.join(" ")).toContain("sixteen months");
  });
});

describe("hours against the same hour on earlier days", () => {
  it("reads a key in Pacific Time without moving it into the server's timezone", () => {
    expect(parseHourKey("2025-04-07T23:00:00-07:00")).toMatchObject({ date: "2025-04-07", hour: "23" });
    expect(parseHourKey("seo audit tool")).toBeNull();
  });

  it("uses the same hour on earlier days as the baseline, not the hour before", () => {
    const readings = hourlyReadings([
      row(["2026-09-22T14:00:00-07:00"], 10),
      row(["2026-09-23T14:00:00-07:00"], 20),
      row(["2026-09-24T13:00:00-07:00"], 100),
      row(["2026-09-24T14:00:00-07:00"], 30),
    ]);

    const today = readings.find((reading) => reading.date === "2026-09-24" && reading.hour === "14")!;
    expect(today.baselineClicks).toBe(15);
    expect(today.baselineDays).toBe(2);

    const first = readings.find((reading) => reading.date === "2026-09-22")!;
    expect(first.baselineClicks).toBeNull();
  });

  it("marks hours from the first incomplete one on and keeps them out of every baseline", () => {
    const readings = hourlyReadings(
      [
        row(["2026-09-23T14:00:00-07:00"], 20),
        row(["2026-09-24T14:00:00-07:00"], 2),
        row(["2026-09-25T14:00:00-07:00"], 30),
      ],
      "2026-09-24T14:00:00-07:00",
    );

    expect(readings.map((reading) => reading.partial)).toEqual([false, true, true]);
    // The 25th's baseline is the 23rd alone: the 24th is still being counted.
    expect(readings[2].baselineClicks).toBe(20);
    expect(readings[2].baselineDays).toBe(1);
  });

  it("finds the same hour a week earlier when the window reaches it", () => {
    const readings = hourlyReadings([
      row(["2026-09-17T09:00:00-07:00"], 40),
      row(["2026-09-24T09:00:00-07:00"], 44),
    ]);
    expect(readings[1].weekAgoClicks).toBe(40);
    expect(readings[0].weekAgoClicks).toBeNull();
  });
});

describe("content decay", () => {
  const months = Array.from({ length: 15 }, (_, index) => {
    const date = new Date(Date.UTC(2025, 5 + index, 1));
    return date.toISOString().slice(0, 7);
  });

  it("buckets one read per month into a series per page, with zero for a missing month", () => {
    const byPage = monthlyClicksByPage([
      { month: "2026-01", rows: [row(["/a"], 5), row(["/b"], 2)] },
      { month: "2026-02", rows: [row(["/a"], 7)] },
    ]);
    expect(byPage.get("/a")).toEqual([5, 7]);
    expect(byPage.get("/b")).toEqual([2, 0]);
  });

  it("flags a page whose last three months are well below its best three", () => {
    const series = [100, 100, 100, 100, 100, 100, 100, 100, 100, 100, 100, 100, 30, 30, 30];
    const [finding] = decayingPages(months, new Map([["/falling", series]]));

    expect(finding.page).toBe("/falling");
    expect(finding.peakAverage).toBe(100);
    expect(finding.recentAverage).toBe(30);
    expect(finding.decline).toBeCloseTo(0.7);
    // The same months a year earlier had 100 each, so this is not the calendar.
    expect(finding.reading).toBe("decay");
    expect(finding.yearOverYearMonths).toBe(3);
  });

  it("calls a fall seasonal when the same months a year earlier were as low", () => {
    const series = [30, 30, 30, 100, 100, 100, 100, 100, 100, 100, 100, 100, 30, 30, 30];
    const [finding] = decayingPages(months, new Map([["/ski-hire", series]]));
    expect(finding.reading).toBe("seasonal");
  });

  it("says it cannot tell when the window does not reach back a year", () => {
    const short = months.slice(0, 12);
    const series = [100, 100, 100, 100, 100, 100, 100, 100, 100, 20, 20, 20];
    const [finding] = decayingPages(short, new Map([["/a", series]]));
    expect(finding.reading).toBe("unknown");
    expect(finding.yearOverYear).toBeNull();
  });

  it("ignores pages too small at peak and falls smaller than the threshold", () => {
    const findings = decayingPages(
      months,
      new Map([
        ["/tiny", [6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 1, 1, 1]],
        ["/steady", [100, 100, 100, 100, 100, 100, 100, 100, 100, 100, 100, 100, 80, 80, 80]],
      ]),
      DEFAULT_DECAY,
    );
    expect(findings).toEqual([]);
  });

  it("does not let the recent months be their own peak", () => {
    const series = [10, 10, 10, 10, 10, 10, 10, 10, 10, 10, 10, 10, 90, 90, 90];
    expect(decayingPages(months, new Map([["/growing", series]]))).toEqual([]);
  });
});

describe("fresh reads through the shared shape", () => {
  const args = { siteUrl: "sc-domain:example.com", startDate: "2026-09-22", endDate: "2026-09-24" };

  it("asks for the data state and keeps what Google said about it", async () => {
    const queries: SearchAnalyticsQuery[] = [];
    const reader = fakeGoogleReader({
      searchConsole: {
        searchAnalyticsWithMetadata: async (query) => {
          queries.push(query);
          return { rows: [], firstIncompleteHour: "2026-09-24T10:00:00-07:00" };
        },
      },
    });

    const fetched = await fetchRows(reader.searchConsole, args, {
      dimensions: ["hour"],
      dataState: "hourly_all",
      dimensionFilterGroups: [{ groupType: "and", filters: [] }],
      title: "T",
    });

    expect(queries[0].dataState).toBe("hourly_all");
    expect(queries[0].dimensionFilterGroups).toEqual([{ groupType: "and", filters: [] }]);
    expect(fetched.firstIncompleteHour).toBe("2026-09-24T10:00:00-07:00");
  });

  it("sends exactly the old request when no data state is asked for", async () => {
    const queries: SearchAnalyticsQuery[] = [];
    const reader = fakeGoogleReader({
      searchConsole: {
        searchAnalytics: async (query) => {
          queries.push(query);
          return [];
        },
      },
    });

    const fetched = await fetchRows(reader.searchConsole, args, { dimensions: ["page"], title: "T" });
    await readAgain(reader.searchConsole, fetched, { dimensions: ["page"] });

    for (const query of queries) {
      expect(query).not.toHaveProperty("dataState");
      expect(query).not.toHaveProperty("dimensionFilterGroups");
    }
    expect(fetched).not.toHaveProperty("firstIncompleteDate");
  });
});
