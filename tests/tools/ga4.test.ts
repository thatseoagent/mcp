import { describe, it, expect, afterEach, vi } from "vitest";
import { handler as listProperties } from "@/tools/ga4-list-properties";
import { handler as runReport } from "@/tools/ga4-run-report";
import { handler as pivotReport } from "@/tools/ga4-pivot-report";
import { handler as realtime } from "@/tools/ga4-get-realtime";
import { handler as metadata } from "@/tools/ga4-metadata";
import { handler as customDefinitions } from "@/tools/ga4-custom-definitions";
import { handler as keyEvents } from "@/tools/ga4-key-events";
import { handler as checkCompatibility } from "@/tools/ga4-check-compatibility";
import { handler as aiTraffic } from "@/tools/ga4-ai-traffic";
import { fakeGoogleReader } from "@/lib/google/fake-reader";
import { resetPersistence } from "@/lib/db/runtime";
import type { Ga4Report, Ga4ReportQuery } from "@/lib/google/reader";

afterEach(() => {
  resetPersistence();
  vi.restoreAllMocks();
});

const textOf = (result: { content: Array<{ text: string }> }): string =>
  result.content.map((part) => part.text).join("\n");

const base = { force_refresh: undefined };

/** A GA4 report built from rows, so a test can say what it means in one line. */
function report(
  dimensions: string[],
  metrics: string[],
  rows: Array<[string[], number[]]>,
  extra: Partial<Ga4Report> = {},
): Ga4Report {
  return {
    dimensionHeaders: dimensions.map((name) => ({ name })),
    metricHeaders: metrics.map((name) => ({ name })),
    rows: rows.map(([dims, mets]) => ({
      dimensionValues: dims.map((value) => ({ value })),
      metricValues: mets.map((value) => ({ value: String(value) })),
    })),
    rowCount: rows.length,
    ...extra,
  };
}

describe("ga4_list_properties", () => {
  it("groups properties by the account they belong to", async () => {
    // A consultancy account holds properties belonging to different clients, and
    // a flat list of display names does not say which.
    const text = textOf(await listProperties(base, fakeGoogleReader()));

    expect(text).toContain("Example Ltd");
    expect(text).toContain("properties/123456789 — example.com — GA4");
  });

  it("explains that Analytics access is granted separately when there are none", async () => {
    const result = await listProperties(
      base,
      fakeGoogleReader({ analytics: { listProperties: async () => [] } }),
    );

    expect(result.isError).toBeUndefined();
    expect(textOf(result)).toContain("granted per property");
  });
});

describe("ga4_run_report", () => {
  const args = {
    ...base,
    propertyId: "123456789",
    metrics: ["sessions"],
    dimensions: undefined,
    startDate: undefined,
    endDate: undefined,
    limit: undefined,
    offset: undefined,
  };

  it("uses GA4's relative dates rather than dates computed here", async () => {
    // Computed dates come from `new Date()`, which is UTC, while GA4 resolves a
    // range in the property's own reporting timezone.
    let asked: Ga4ReportQuery | null = null;
    const google = fakeGoogleReader({
      analytics: {
        runReport: async (query) => {
          asked = query;
          return report(["x"], ["sessions"], []);
        },
      },
    });

    await runReport(args, google);

    expect(asked!.dateRanges[0]).toEqual({ startDate: "28daysAgo", endDate: "yesterday" });
  });

  it("asks for the totals it prints, since Google sends none unless asked", async () => {
    // The default fake answers without totals unless the query asks, as Google
    // does. Before the request asked, the totals line was never printed live.
    const text = textOf(await runReport(args, fakeGoogleReader()));

    expect(text).toContain("Totals across the whole query: sessions 11165");
  });

  it("says a report was truncated rather than letting the rows read as the total", async () => {
    // GA4 returns `rowCount` alongside the rows, so a truncated report looks
    // exactly like a complete one.
    const google = fakeGoogleReader({
      analytics: {
        runReport: async () =>
          report(["page"], ["sessions"], [[["/a"], [10]]], { rowCount: 400 }),
      },
    });

    const text = textOf(await runReport(args, google));

    expect(text).toContain("This property has 400 rows for this query and 1 came back");
    expect(text).toContain("does not give the property's total");
  });

  it("says when GA4 withheld rows for thresholding", async () => {
    const google = fakeGoogleReader({
      analytics: {
        runReport: async () =>
          report(["page"], ["sessions"], [[["/a"], [10]]], {
            metadata: { subjectToThresholding: true },
          }),
      },
    });

    const text = textOf(await runReport(args, google));

    expect(text).toContain("subject to thresholding");
    expect(text).toContain("lower bounds rather than counts");
    expect(text).not.toContain("sampled");
  });

  it("says a sampled report is an estimate, and does not call it thresholded", async () => {
    // The two shared one sentence, so a sampled report was told its numbers
    // were lower bounds. Sampled numbers can be off in either direction.
    const google = fakeGoogleReader({
      analytics: {
        runReport: async () =>
          report(["page"], ["sessions"], [[["/a"], [10]]], {
            metadata: { samplingMetadatas: [{ samplesReadCount: "120000", samplingSpaceSize: "1000000" }] },
          }),
      },
    });

    const text = textOf(await runReport(args, google));

    expect(text).toContain("GA4 sampled this report (from about 12% of the data)");
    expect(text).toContain("estimates");
    expect(text).not.toContain("thresholding");
  });

  it("names a truncation Google reports, with its date", async () => {
    const google = fakeGoogleReader({
      analytics: {
        runReport: async () =>
          report(["page"], ["sessions"], [[["/a"], [10]]], {
            metadata: {
              dataTruncationReasons: [
                {
                  dataTruncationType: "DATA_TRUNCATION_TYPE_DATE_RANGE",
                  dataTruncationDate: "2026-03-01",
                  dataTruncationMessage: "Data before this date is past the property's retention.",
                },
              ],
            },
          }),
      },
    });

    const text = textOf(await runReport(args, google));

    expect(text).toContain("GA4 truncated data in this report (date range) before 2026-03-01");
    expect(text).toContain("past the property's retention");
  });

  it("says an empty report is about the query, not about the property", async () => {
    const google = fakeGoogleReader({
      analytics: { runReport: async () => report(["page"], ["sessions"], []) },
    });

    const text = textOf(await runReport(args, google));

    expect(text).toContain("fact about this query");
    expect(text).toContain("ga4_check_compatibility");
  });
});

describe("ga4_pivot_report", () => {
  it("orders rows by the first metric rather than however GA4 returned them", async () => {
    let asked: unknown = null;
    const google = fakeGoogleReader({
      analytics: {
        runPivotReport: async (query) => {
          asked = query.pivots;
          return report(["page", "channel"], ["sessions"], []);
        },
      },
    });

    await pivotReport(
      {
        ...base,
        propertyId: "1",
        metrics: ["sessions"],
        rowDimension: "landingPage",
        columnDimension: "sessionDefaultChannelGroup",
        startDate: undefined,
        endDate: undefined,
        rowLimit: undefined,
        columnLimit: undefined,
      },
      google,
    );

    expect(JSON.stringify(asked)).toContain('"metricName":"sessions"');
    expect(JSON.stringify(asked)).toContain('"desc":true');
  });
});

describe("ga4_get_realtime", () => {
  it("says its numbers will not reconcile with the reporting API", async () => {
    const text = textOf(
      await realtime(
        { ...base, propertyId: "1", dimensions: undefined, metrics: undefined, limit: undefined },
        fakeGoogleReader(),
      ),
    );

    expect(text).toContain("separate dataset");
    expect(text).toContain("expected rather than a discrepancy");
  });
});

describe("ga4_metadata", () => {
  const args = { ...base, propertyId: "1", search: undefined };

  it("marks the custom fields apart from GA4's built-in ones", async () => {
    const text = textOf(await metadata(args, fakeGoogleReader()));

    expect(text).toContain("customUser:plan — Plan  [custom]");
    expect(text).toContain("sessionDefaultChannelGroup — Session default channel group");
  });

  it("narrows to a search without hiding matches", async () => {
    const text = textOf(await metadata({ ...args, search: "plan" }, fakeGoogleReader()));

    expect(text).toContain("customUser:plan");
    expect(text).not.toContain("sessionDefaultChannelGroup");
  });
});

describe("ga4_custom_definitions", () => {
  it("says an absence of custom definitions is normal, not a misconfiguration", async () => {
    const google = fakeGoogleReader({
      analytics: {
        getMetadata: async () => ({
          dimensions: [{ apiName: "sessionSource" }],
          metrics: [{ apiName: "sessions" }],
        }),
      },
    });

    const text = textOf(await customDefinitions({ ...base, propertyId: "1" }, google));

    expect(text).toContain("no custom dimensions or metrics");
    expect(text).toContain("normal for a standard install");
  });

  it("lists only the custom ones when there are some", async () => {
    const text = textOf(await customDefinitions({ ...base, propertyId: "1" }, fakeGoogleReader()));

    expect(text).toContain("customUser:plan");
    expect(text).not.toContain("sessionDefaultChannelGroup");
  });
});

describe("ga4_key_events", () => {
  const args = { ...base, propertyId: "1", startDate: undefined, endDate: undefined };

  it("lists only the events that are actually key events", async () => {
    // GA4 returns every event name with a `keyEvents` of zero for the ones
    // nobody marked; printing those under a "key events" heading would suggest
    // fifty conversions that are all failing.
    const google = fakeGoogleReader({
      analytics: {
        runReport: async () =>
          report(
            ["eventName"],
            ["keyEvents", "eventCount"],
            [
              [["purchase"], [42, 42]],
              [["page_view"], [0, 9100]],
            ],
          ),
      },
    });

    const text = textOf(await keyEvents(args, google));

    expect(text).toContain("Key events with activity: 1");
    expect(text).toContain("purchase | 42 | 42");
    expect(text).toContain("Total key events across these: 42");
  });

  it("distinguishes nothing converting from nothing being marked as a conversion", async () => {
    const google = fakeGoogleReader({
      analytics: {
        runReport: async () =>
          report(["eventName"], ["keyEvents", "eventCount"], [[["page_view"], [0, 9100]]]),
      },
    });

    const text = textOf(await keyEvents(args, google));

    expect(text).toContain("no event on this property has been marked as a key event");
    expect(text).toContain("the fix is a toggle rather than tracking");
    // And still shows what is being collected, so the reader can tell which.
    expect(text).toContain("page_view");
  });
});

describe("ga4_check_compatibility", () => {
  it("names the field that will make GA4 refuse", async () => {
    const text = textOf(
      await checkCompatibility(
        { ...base, propertyId: "1", metrics: ["sessions", "adRevenue"], dimensions: undefined },
        fakeGoogleReader(),
      ),
    );

    expect(text).toContain("GA4 will refuse this combination because of: adRevenue");
    expect(text).toContain("scope conflict rather than a missing field");
  });

  it("confirms a workable combination", async () => {
    const google = fakeGoogleReader({
      analytics: {
        checkCompatibility: async () => ({
          metricCompatibilities: [
            { metricMetadata: { apiName: "sessions" }, compatibility: "COMPATIBLE" },
          ],
        }),
      },
    });

    const text = textOf(
      await checkCompatibility(
        { ...base, propertyId: "1", metrics: ["sessions"], dimensions: undefined },
        google,
      ),
    );

    expect(text).toContain("This combination is reportable");
  });
});

describe("ga4_ai_traffic", () => {
  // What counts as AI traffic, users' grain, unattributed landings and the
  // comparison window are `traffic-segments.ts`'s, tested there. These are the
  // sentences the Operator reads.
  const args = { ...base, propertyId: "1", days: undefined };

  /** A reader answering this Tool's reports by what each query asks for. */
  function readerFor(options: {
    sources: Array<[string[], number[]]>;
    landings?: Array<[string[], number[]]>;
    previous?: Array<[string[], number[]]>;
    siteTotal?: number | null;
  }) {
    return fakeGoogleReader({
      analytics: {
        runReport: async (query: Ga4ReportQuery) => {
          if (query.dimensions?.includes("landingPage")) {
            return report(query.dimensions, ["sessions"], options.landings ?? []);
          }
          if (query.dateRanges[0].startDate !== "28daysAgo") {
            return report(["sessionSource", "sessionMedium"], ["sessions"], options.previous ?? []);
          }
          const total = options.siteTotal === undefined ? 1000 : options.siteTotal;
          return report(
            ["sessionSource", "sessionMedium"],
            ["sessions", "totalUsers"],
            options.sources,
            total === null ? {} : { totals: [{ metricValues: [{ value: String(total) }, { value: "800" }] }] },
          );
        },
      },
    });
  }

  it("counts what Google classified and what its own host list caught, and says which", async () => {
    const google = readerFor({
      sources: [
        [["chatgpt.com", "ai-assistant"], [80, 60]],
        [["perplexity.ai", "referral"], [20, 15]],
        [["google.com", "organic"], [500, 400]],
      ],
      siteTotal: 1000,
    });

    const text = textOf(await aiTraffic(args, google));

    expect(text).toContain("AI sessions: 100");
    expect(text).toContain("Share of all sessions: 10.00% of 1000");
    expect(text).toContain("20 session(s) were counted by this Tool's own host list");
    expect(text).toContain("chatgpt.com — 80 sessions, 60 users");
    expect(text).toContain("perplexity.ai — 20 sessions, 15 users");
    expect(text).toContain("(counted by this Tool's host list, not by Google's own classification)");
  });

  it("says the share is not available when GA4 reported no site total", async () => {
    const google = readerFor({ sources: [[["chatgpt.com", "ai-assistant"], [50, 40]]], siteTotal: null });

    const text = textOf(await aiTraffic(args, google));

    expect(text).toContain("Share of all sessions: not available");
  });

  it("says a user count is an upper bound when a source arrived under both mediums", async () => {
    const google = readerFor({
      sources: [
        [["claude.ai", "ai-assistant"], [30, 25]],
        [["claude.ai", "referral"], [10, 8]],
      ],
    });

    const text = textOf(await aiTraffic(args, google));

    expect(text).toContain("claude.ai — 40 sessions, up to 33 users");
    expect(text).toContain("(10 of these counted by this Tool's host list");
  });

  it("states the change against the previous window, and calls a source with no history new", async () => {
    const google = readerFor({
      sources: [
        [["chatgpt.com", "ai-assistant"], [150, 100]],
        [["claude.ai", "referral"], [12, 9]],
      ],
      previous: [[["chatgpt.com", "ai-assistant"], [100]]],
    });

    const text = textOf(await aiTraffic(args, google));

    expect(text).toContain("chatgpt.com — 150 sessions, 100 users — +50% against the previous window (100)");
    expect(text).toContain("claude.ai — 12 sessions, 9 users — new — nothing in the previous window");
  });

  it("reports the landing pages AI assistants send people to, and the sessions on none", async () => {
    const google = readerFor({
      sources: [[["chatgpt.com", "ai-assistant"], [30, 20]]],
      landings: [
        [["chatgpt.com", "ai-assistant", "/guide"], [20]],
        [["chatgpt.com", "ai-assistant", "(not set)"], [10]],
      ],
    });

    const text = textOf(await aiTraffic(args, google));

    expect(text).toContain("=== LANDING PAGES (1) ===");
    expect(text).toContain("/guide — 20 sessions");
    expect(text).not.toContain("(not set) —");
    expect(text).toContain("10 AI-referred session(s) had no landing page GA4 could name");
  });

  it("says an absence is a measurement, not a verdict on the site", async () => {
    const google = readerFor({ sources: [[["google.com", "organic"], [500, 400]]] });

    const result = await aiTraffic(args, google);

    expect(result.isError).toBeUndefined();
    const text = textOf(result);
    expect(text).toContain("No AI assistant traffic in this window");
    expect(text).toContain("measurement, not a verdict");
    // The reason a zero here is not the whole story.
    expect(text).toContain("summarises your page rather than");
  });

  it("says out loud that it only sees visits carrying a referrer", async () => {
    const google = readerFor({ sources: [[["chatgpt.com", "ai-assistant"], [30, 20]]] });

    const text = textOf(await aiTraffic(args, google));

    const basis = text.slice(text.indexOf("=== WHAT THIS IS BASED ON ==="));
    expect(basis).toContain("GA4 only sees AI visits that arrived with a referrer");
    expect(text).toContain("a floor on how");
  });
});
