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
import { classifyAiReferrer } from "@/lib/google/ai-referrers";
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

    expect(text).toContain("data thresholding");
    expect(text).toContain("lower bounds, not counts");
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

describe("classifying an AI referrer", () => {
  it("takes Google's own classification first", () => {
    expect(classifyAiReferrer("something.example", "ai-assistant")).toBe("google");
  });

  it("falls back to the host list only for a referral", () => {
    expect(classifyAiReferrer("chatgpt.com", "referral")).toBe("host-list");
    expect(classifyAiReferrer("chatgpt.com", "organic")).toBeNull();
  });

  it("matches a subdomain but never a substring", () => {
    // Substring matching is what let `bing.com` stand for
    // `edgeservices.bing.com`, and would just as happily count
    // `notchatgpt.com.example.org`.
    expect(classifyAiReferrer("www.perplexity.ai", "referral")).toBe("host-list");
    expect(classifyAiReferrer("notchatgpt.com.example.org", "referral")).toBeNull();
  });

  it("does not count an ordinary search engine", () => {
    // `bing.com` was on the list once, so every referral from Bing's web search
    // was reported to a site owner as a citation by an AI engine.
    expect(classifyAiReferrer("bing.com", "referral")).toBeNull();
    expect(classifyAiReferrer("google.com", "referral")).toBeNull();
  });
});

describe("ga4_ai_traffic", () => {
  const args = { ...base, propertyId: "1", days: undefined };

  /** A reader answering the three reports this Tool runs, in order. */
  function readerFor(options: {
    sources: Array<[string[], number[]]>;
    landings?: Array<[string[], number[]]>;
    previous?: Array<[string[], number[]]>;
    siteTotal?: number;
  }) {
    let call = 0;
    return fakeGoogleReader({
      analytics: {
        runReport: async () => {
          call++;
          if (call === 1) {
            return report(
              ["sessionSource", "sessionMedium"],
              ["sessions", "totalUsers"],
              options.sources,
              {
                totals: [
                  { metricValues: [{ value: String(options.siteTotal ?? 1000) }, { value: "800" }] },
                ],
              },
            );
          }
          if (call === 2) {
            return report(
              ["sessionSource", "sessionMedium", "landingPage"],
              ["sessions"],
              options.landings ?? [],
            );
          }
          return report(
            ["sessionSource", "sessionMedium"],
            ["sessions"],
            options.previous ?? [],
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
  });

  it("takes the denominator from GA4's totals, not from adding up rows", async () => {
    // `limit` truncates, and a share computed over whatever survived it is a
    // fraction of the wrong number.
    const google = readerFor({
      sources: [[["chatgpt.com", "ai-assistant"], [50, 40]]],
      siteTotal: 5000,
    });

    const text = textOf(await aiTraffic(args, google));

    expect(text).toContain("1.00% of 5000");
  });

  it("compares against the previous window", async () => {
    const google = readerFor({
      sources: [[["chatgpt.com", "ai-assistant"], [150, 100]]],
      previous: [[["chatgpt.com", "ai-assistant"], [100, 80]]],
    });

    const text = textOf(await aiTraffic(args, google));

    expect(text).toContain("+50% against the previous window (100)");
  });

  it("calls a source with no history new rather than infinite growth", async () => {
    const google = readerFor({ sources: [[["claude.ai", "referral"], [12, 9]]] });

    const text = textOf(await aiTraffic(args, google));

    expect(text).toContain("new — nothing in the previous window");
  });

  it("reports the landing pages AI assistants send people to", async () => {
    const google = readerFor({
      sources: [[["chatgpt.com", "ai-assistant"], [30, 20]]],
      landings: [
        [["chatgpt.com", "ai-assistant", "/guide"], [20]],
        [["chatgpt.com", "ai-assistant", "/pricing"], [10]],
        [["google.com", "organic", "/ignored"], [900]],
      ],
    });

    const text = textOf(await aiTraffic(args, google));

    expect(text).toContain("/guide — 20 sessions");
    expect(text).not.toContain("/ignored");
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

    expect(text).toContain("=== WHAT THIS DOES NOT SEE ===");
    expect(text).toContain("a floor on how");
  });
});
