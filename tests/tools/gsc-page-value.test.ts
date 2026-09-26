import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import { handler } from "@/tools/gsc-page-value";
import { fakeGoogleReader } from "@/lib/google/fake-reader";
import { UpstreamApiError } from "@/lib/upstream-api-error";
import { resetPersistence } from "@/lib/db/runtime";
import { resetAllSingleFlightCaches } from "@/lib/single-flight";
import type { Ga4Report, Ga4ReportQuery, SearchAnalyticsRow } from "@/lib/google/reader";

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
  propertyId: "123456789",
  startDate: "2026-08-01",
  endDate: "2026-08-28",
  days: undefined,
  minClicks: undefined,
  lowEngagement: undefined,
};

function page(url: string, clicks: number, impressions: number): SearchAnalyticsRow {
  return { keys: [url], clicks, impressions, ctr: clicks / impressions, position: 5.5 };
}

/** A GA4 landing-page report, with the metrics in the order the Tool asks for them. */
function landings(rows: Array<[string, number, number, number]>): Ga4Report {
  return {
    dimensionHeaders: [{ name: "landingPage" }],
    metricHeaders: [{ name: "sessions" }, { name: "engagedSessions" }, { name: "keyEvents" }],
    rows: rows.map(([path, sessions, engaged, keyEvents]) => ({
      dimensionValues: [{ value: path }],
      metricValues: [{ value: String(sessions) }, { value: String(engaged) }, { value: String(keyEvents) }],
    })),
    rowCount: rows.length,
  };
}

function reader(searchRows: SearchAnalyticsRow[], report: Ga4Report, queries: Ga4ReportQuery[] = []) {
  return fakeGoogleReader({
    searchConsole: { searchAnalytics: async () => searchRows },
    analytics: {
      runReport: async (query) => {
        queries.push(query);
        return report;
      },
    },
  });
}

const SEARCH = [
  page("https://example.com/guide/", 300, 9000),
  page("https://example.com/pricing", 120, 2000),
  page("https://example.com/demo", 8, 90),
  page("https://example.com/orphan", 40, 1500),
];

const GA4 = landings([
  ["/guide", 280, 60, 0],
  ["/pricing", 110, 90, 14],
  ["/demo", 7, 6, 3],
  ["/signup-thanks", 12, 12, 9],
  ["(not set)", 5, 0, 0],
]);

describe("gsc_page_value", () => {
  it("reads GA4 over the same calendar dates Search Console was read over", async () => {
    // Which slice of GA4 is `organicLandings`'s, tested in `traffic-segments.test.ts`.
    const queries: Ga4ReportQuery[] = [];
    await handler(args, reader(SEARCH, GA4, queries));

    expect(queries).toHaveLength(1);
    expect(queries[0]).toMatchObject({
      property: "properties/123456789",
      dateRanges: [{ startDate: "2026-08-01", endDate: "2026-08-28" }],
    });
  });

  it("states coverage: how many clicks joined, and what did not on either side", async () => {
    const text = textOf(await handler(args, reader(SEARCH, GA4)));

    expect(text).toContain("Property: sc-domain:example.com");
    expect(text).toContain("GA4 property: properties/123456789");
    expect(text).toContain("Window: 2026-08-01 to 2026-08-28");
    expect(text).toContain("Search Console clicks on pages GA4 also saw: 428 of 468 (91.5%)");
    expect(text).toContain("Pages joined: 3");
    expect(text).toContain("no GA4 organic landing on the same path: 1 (40 clicks)");
    expect(text).toContain("GA4 organic landing pages Search Console reported nothing for: 1");
    expect(text).toContain('"(not set)": 1 (5 sessions)');
  });

  it("finds clicks that do little and value that is barely seen", async () => {
    const text = textOf(await handler(args, reader(SEARCH, GA4)));

    const leaky = text.split("=== CLICKS THAT DO LITTLE")[1].split("===")[1];
    expect(leaky).toContain("https://example.com/guide/ — 300 clicks");
    expect(leaky).toContain("21% engaged, 0 key event(s)");
    expect(leaky).not.toContain("/pricing");

    const unseen = text.split("=== VALUE THAT IS BARELY SEEN")[1];
    expect(unseen).toContain("https://example.com/demo — 8 clicks");
    expect(text).toContain("/signup-thanks — 12 organic sessions, 9 key event(s)");
    expect(text).toContain("Thresholds are this Tool's, not Google's");
  });

  it("says clicks and sessions differ, so every ratio is directional", async () => {
    const text = textOf(await handler(args, reader(SEARCH, GA4)));

    expect(text).toContain("=== WHY CLICKS AND SESSIONS DIFFER ===");
    expect(text).toContain("consent");
    expect(text).toContain("directional");
  });

  it("does not flag pages for missing key events when the property records none", async () => {
    const text = textOf(
      await handler(
        args,
        reader(SEARCH, landings([["/guide", 280, 250, 0], ["/pricing", 110, 90, 0]])),
      ),
    );
    expect(text).toContain("No key event was recorded on any Google organic landing page");
    expect(text).toContain("=== CLICKS THAT DO LITTLE (0) ===");
  });

  it("refuses to join one GA4 row to the same path on two hosts", async () => {
    const text = textOf(
      await handler(
        args,
        reader(
          [page("https://example.com/help", 50, 500), page("https://docs.example.com/help", 30, 300)],
          landings([["/help", 70, 40, 1]]),
        ),
      ),
    );
    expect(text).toContain("same path exists on more than one host: 2 page(s)");
    expect(text).toContain("Pages joined: 0");
  });

  it("answers when GA4 has no organic landings, naming it as a fact about the GA4 rows", async () => {
    const text = textOf(await handler(args, reader(SEARCH, landings([]))));
    expect(text).toContain("GA4 reported no Google organic landing pages in this window");
    expect(text).not.toMatch(/NaN|undefined|Infinity/);
  });

  it("lets a GA4 refusal through rather than reporting Search Console alone", async () => {
    const refusing = fakeGoogleReader({
      searchConsole: { searchAnalytics: async () => SEARCH },
      analytics: {
        runReport: async () => {
          throw new UpstreamApiError("Google Analytics Data API", 403);
        },
      },
    });
    await expect(handler(args, refusing)).rejects.toBeInstanceOf(UpstreamApiError);
  });

  it("refuses a GA4 property it cannot name before reading anything", async () => {
    const searchAnalytics = vi.fn(async () => SEARCH);
    const guarded = fakeGoogleReader({ searchConsole: { searchAnalytics } });
    await expect(handler({ ...args, propertyId: "example.com" }, guarded)).rejects.toThrow(
      /No GA4 property is known/,
    );
    expect(searchAnalytics).not.toHaveBeenCalled();
  });
});
