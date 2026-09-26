import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import { handler as searchAnalytics, metadata as searchAnalyticsMetadata, schema } from "@/tools/gsc-search-analytics";
import { handler as brandedSplit, metadata as brandedMetadata } from "@/tools/gsc-branded-split";
import { fakeGoogleReader } from "@/lib/google/fake-reader";
import { pacificToday } from "@/lib/google/gsc-dates";
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
  dimensions: undefined,
  startDate: undefined,
  endDate: undefined,
  days: undefined,
  type: undefined,
  rowLimit: undefined,
  freshData: undefined,
};

function day(date: string, clicks: number): SearchAnalyticsRow {
  return { keys: [date], clicks, impressions: clicks * 10, ctr: 0.1, position: 4 };
}

/** Records which method was called and with what, answering fresh reads with `fresh`. */
function recordingReader(fresh: SearchAnalyticsResult) {
  const finished: SearchAnalyticsQuery[] = [];
  const withMetadata: SearchAnalyticsQuery[] = [];
  const reader = fakeGoogleReader({
    searchConsole: {
      searchAnalytics: async (query) => {
        finished.push(query);
        return [day("2026-09-01", 5)];
      },
      searchAnalyticsWithMetadata: async (query) => {
        withMetadata.push(query);
        return fresh;
      },
    },
  });
  return { reader, finished, withMetadata };
}

describe("gsc_search_analytics with freshData", () => {
  it("sends exactly the old request when fresh data is not asked for", async () => {
    const { reader, finished, withMetadata } = recordingReader({ rows: [] });
    const text = textOf(await searchAnalytics(args, reader));

    expect(withMetadata).toHaveLength(0);
    expect(finished[0]).not.toHaveProperty("dataState");
    expect(text).not.toContain("Data: fresh");
    expect(text).toContain("data lags by two to");
  });

  it("asks for the `all` data state and ends the default window today, Pacific", async () => {
    const { reader, withMetadata } = recordingReader({ rows: [day("2026-09-20", 3)] });
    const text = textOf(await searchAnalytics({ ...args, freshData: true }, reader));

    expect(withMetadata[0].dataState).toBe("all");
    expect(withMetadata[0].endDate).toBe(pacificToday());
    expect(text).toContain("Data: fresh — includes days Google is still collecting");
    expect(text).toContain("today in Pacific Time");
  });

  it("names the partial days Google reported and marks their rows", async () => {
    const { reader } = recordingReader({
      rows: [day("2026-09-21", 40), day("2026-09-22", 38), day("2026-09-23", 12)],
      firstIncompleteDate: "2026-09-23",
    });
    const text = textOf(
      await searchAnalytics(
        { ...args, freshData: true, dimensions: ["date"], startDate: "2026-09-21", endDate: "2026-09-23" },
        reader,
      ),
    );

    expect(text).toContain("Partial: 2026-09-23 to 2026-09-23");
    expect(text).toContain("will still rise");
    expect(text).toContain("2026-09-23 — 12 / 120 / 10.00% / 4.0 — partial");
    expect(text).not.toContain("2026-09-22 — 38 / 380 / 10.00% / 4.0 — partial");
  });

  it("does not read Google's silence as an all-clear when the rows are not grouped by date", async () => {
    const { reader } = recordingReader({ rows: [{ clicks: 9, impressions: 90, ctr: 0.1, position: 3 }] });
    const text = textOf(await searchAnalytics({ ...args, freshData: true }, reader));

    expect(text).toContain("Partial: not stated");
    expect(text).toContain("add `date` to the dimensions");
  });

  it("says so when grouped by date and Google reported no partial day", async () => {
    const { reader } = recordingReader({ rows: [day("2026-09-01", 4)] });
    const text = textOf(await searchAnalytics({ ...args, freshData: true, dimensions: ["date"] }, reader));
    expect(text).toContain("Partial: none");
  });

  it("leaves the hour dimension to gsc_hourly_performance and says why", () => {
    expect(schema.dimensions.safeParse(["hour"]).success).toBe(false);
    expect(schema.dimensions.description).toContain("gsc_hourly_performance");
    expect(searchAnalyticsMetadata.description).toContain("freshData");
  });
});

describe("gsc_branded_split is an approximation, not Google's filter", () => {
  const window = { force_refresh: undefined, siteUrl: "example.com", startDate: undefined, endDate: undefined, days: undefined };

  it("says so in its description", () => {
    expect(brandedMetadata.description).toContain("not Google's classification");
    expect(brandedMetadata.description).toContain("not available through its API");
  });

  it("says so in every answer, with or without brand terms", async () => {
    for (const brandTerms of [["example"], []]) {
      const text = textOf(await brandedSplit({ ...window, brandTerms }, fakeGoogleReader()));
      expect(text).toContain("this server's approximation");
      expect(text).toContain("branded-queries filter (November 2025) is not available through the API");
    }
  });
});
