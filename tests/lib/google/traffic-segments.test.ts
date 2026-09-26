import { describe, it, expect } from "vitest";
import { aiReferred, organicLandings } from "@/lib/google/traffic-segments";
import { fakeGoogleReader } from "@/lib/google/fake-reader";
import type { Ga4Report, Ga4ReportQuery } from "@/lib/google/reader";
import { UpstreamApiError } from "@/lib/upstream-api-error";

const WINDOW = {
  property: "properties/123456789",
  dateRange: { startDate: "28daysAgo", endDate: "yesterday" },
};
const PREVIOUS = { startDate: "56daysAgo", endDate: "29daysAgo" };

/** A GA4 report built from rows, headed by whatever the query asked for. */
function report(
  query: Ga4ReportQuery,
  rows: Array<[string[], number[]]>,
  extra: Partial<Ga4Report> = {},
): Ga4Report {
  return {
    dimensionHeaders: (query.dimensions ?? []).map((name) => ({ name })),
    metricHeaders: (query.metrics ?? []).map((name) => ({ name })),
    rows: rows.map(([dims, mets]) => ({
      dimensionValues: dims.map((value) => ({ value })),
      metricValues: mets.map((value) => ({ value: String(value) })),
    })),
    rowCount: rows.length,
    ...extra,
  };
}

const isLanding = (q: Ga4ReportQuery) => q.dimensions?.includes("landingPage") ?? false;
const isPrevious = (q: Ga4ReportQuery) => q.dateRanges[0].startDate === PREVIOUS.startDate;

/**
 * A reader answering the AI reads by what each query asks for: the source ×
 * medium report (with users when asked), the landing report, the earlier window.
 * Rows are `[source, medium, sessions, users]` and `[source, medium, page, sessions]`.
 */
function aiReader(options: {
  sources?: Array<[string, string, number, number]>;
  landings?: Array<[string, string, string, number]>;
  previous?: Array<[string, string, number]>;
  siteTotal?: number;
  previousExtra?: Partial<Ga4Report>;
}) {
  const asked: Ga4ReportQuery[] = [];
  const google = fakeGoogleReader({
    analytics: {
      runReport: async (query) => {
        asked.push(query);
        if (isLanding(query)) {
          return report(query, (options.landings ?? []).map(([s, m, p, n]) => [[s, m, p], [n]]));
        }
        if (isPrevious(query)) {
          return report(
            query,
            (options.previous ?? []).map(([s, m, n]) => [[s, m], [n]]),
            options.previousExtra,
          );
        }
        const withUsers = query.metrics?.includes("totalUsers");
        return report(
          query,
          (options.sources ?? []).map(([s, m, n, u]) => [[s, m], withUsers ? [n, u] : [n]]),
          options.siteTotal === undefined
            ? {}
            : { totals: [{ metricValues: (query.metrics ?? []).map((_, i) => ({ value: i === 0 ? String(options.siteTotal) : "0" })) }] },
        );
      },
    },
  });
  return { google, asked };
}

describe("aiReferred: what counts as an AI referral", () => {
  it("takes Google's ai-assistant medium first and the host list second, and keeps which", async () => {
    const { google } = aiReader({
      sources: [
        ["something-new.example", "ai-assistant", 40, 30],
        ["chatgpt.com", "ai-assistant", 30, 20],
        ["www.perplexity.ai", "referral", 20, 15],
        ["google", "organic", 900, 700],
      ],
    });

    const ai = await aiReferred(google, WINDOW);

    expect(ai.sessions).toBe(90);
    expect(ai.fromHostList).toBe(20);
    expect(ai.sources.map((s) => [s.source, s.sessions, s.fromHostList])).toEqual([
      ["something-new.example", 40, 0],
      ["chatgpt.com", 30, 0],
      ["www.perplexity.ai", 20, 20],
    ]);
  });

  it("counts neither an ordinary search engine nor a host that only contains an assistant's name", async () => {
    // `bing.com` was on the list once, so every Bing web-search referral was
    // reported as a citation by an AI engine. Substring matching would count the second.
    const { google } = aiReader({
      sources: [
        ["bing.com", "referral", 50, 40],
        ["notchatgpt.com.example.org", "referral", 5, 5],
        ["chatgpt.com", "organic", 7, 7],
      ],
    });

    const ai = await aiReferred(google, WINDOW);

    expect(ai.sources).toEqual([]);
    expect(ai.sessions).toBe(0);
  });

  it("reads rows unfiltered, busiest first, with a limit high enough not to cut AI sources off", async () => {
    const { google, asked } = aiReader({});

    await aiReferred(google, WINDOW);

    expect(asked).toHaveLength(1);
    expect(asked[0]).toMatchObject({
      property: "properties/123456789",
      dimensions: ["sessionSource", "sessionMedium"],
      metrics: ["sessions"],
      orderBys: [{ metric: { metricName: "sessions" }, desc: true }],
    });
    expect(asked[0].dimensionFilter).toBeUndefined();
    expect(asked[0].limit).toBeGreaterThanOrEqual(10_000);
  });

  it("takes the site's sessions from GA4's own total, and asks for it", async () => {
    // Google fills `totals` only when `metricAggregations` asks, and a share
    // over the rows that survived `limit` is a fraction of the wrong number.
    const { google, asked } = aiReader({
      sources: [["chatgpt.com", "ai-assistant", 50, 40]],
      siteTotal: 5000,
    });

    const ai = await aiReferred(google, WINDOW);

    expect(asked[0].metricAggregations).toEqual(["TOTAL"]);
    expect(ai.siteSessions).toBe(5000);
  });

  it("says it has no site total when GA4 sent none, rather than calling it zero", async () => {
    const { google } = aiReader({ sources: [["chatgpt.com", "ai-assistant", 50, 40]] });

    expect((await aiReferred(google, WINDOW)).siteSessions).toBeNull();
  });

  it("lets a Google refusal through rather than answering with no AI traffic", async () => {
    const google = fakeGoogleReader({
      analytics: {
        runReport: async () => {
          throw new UpstreamApiError("Google Analytics Data API", 403);
        },
      },
    });

    await expect(aiReferred(google, WINDOW, { byLanding: true })).rejects.toBeInstanceOf(UpstreamApiError);
  });
});

describe("aiReferred: users at their own grain", () => {
  it("reads users from the source report and never adds them up out of landing rows", async () => {
    // One person reaching two pages from ChatGPT is one user and two landing rows.
    const { google, asked } = aiReader({
      sources: [["chatgpt.com", "ai-assistant", 30, 20]],
      landings: [
        ["chatgpt.com", "ai-assistant", "/guide", 20],
        ["chatgpt.com", "ai-assistant", "/pricing", 10],
      ],
    });

    const ai = await aiReferred(google, WINDOW, { byLanding: true, withUsers: true });

    expect(ai.sources[0]).toMatchObject({ source: "chatgpt.com", users: 20, usersUpperBound: false });
    const landing = asked.find(isLanding)!;
    expect(landing.metrics).toEqual(["sessions"]);
  });

  it("marks a source that arrived under both mediums as an upper bound on users", async () => {
    const { google } = aiReader({
      sources: [
        ["claude.ai", "ai-assistant", 30, 25],
        ["claude.ai", "referral", 10, 8],
      ],
    });

    const [claude] = (await aiReferred(google, WINDOW, { withUsers: true })).sources;

    expect(claude).toMatchObject({ sessions: 40, fromHostList: 10, users: 33, usersUpperBound: true });
  });

  it("does not ask for users, or report any, unless asked", async () => {
    const { google, asked } = aiReader({ sources: [["chatgpt.com", "ai-assistant", 30, 20]] });

    const ai = await aiReferred(google, WINDOW);

    expect(asked[0].metrics).toEqual(["sessions"]);
    expect(ai.sources[0].users).toBeNull();
  });
});

describe("aiReferred: landing pages", () => {
  it("adds sessions up across sources per page, and counts pages GA4 could not name apart", async () => {
    // GA4 writes "" or "(not set)" when it could not place the session. Reading
    // that as `/` credited the home page with every session GA4 lost track of.
    const { google } = aiReader({
      landings: [
        ["chatgpt.com", "ai-assistant", "/guide", 10],
        ["perplexity.ai", "referral", "/guide", 5],
        ["chatgpt.com", "ai-assistant", "/", 3],
        ["chatgpt.com", "ai-assistant", "", 12],
        ["chatgpt.com", "ai-assistant", "(not set)", 8],
        ["google", "organic", "/ignored", 900],
      ],
    });

    const ai = await aiReferred(google, WINDOW, { byLanding: true });

    expect(ai.landings).toEqual({
      pages: [
        { page: "/guide", sessions: 15 },
        { page: "/", sessions: 3 },
      ],
      unattributed: 20,
    });
  });

  it("reads no landing report unless asked", async () => {
    const { google, asked } = aiReader({});

    const ai = await aiReferred(google, WINDOW);

    expect(asked.some(isLanding)).toBe(false);
    expect(ai.landings).toBeNull();
  });
});

describe("aiReferred: the comparison window", () => {
  it("reads the same slice over the window it is given, by source", async () => {
    const { google, asked } = aiReader({
      sources: [["chatgpt.com", "ai-assistant", 150, 100]],
      previous: [
        ["chatgpt.com", "ai-assistant", 80],
        ["chatgpt.com", "referral", 20],
        ["google", "organic", 900],
      ],
    });

    const ai = await aiReferred(google, WINDOW, { compareWith: PREVIOUS });

    expect(asked.find(isPrevious)?.dateRanges).toEqual([PREVIOUS]);
    expect(ai.previous?.sessions).toBe(100);
    expect(ai.previous?.bySource.get("chatgpt.com")).toBe(100);
  });

  it("says which window a caveat belongs to", async () => {
    const { google } = aiReader({
      previous: [["chatgpt.com", "ai-assistant", 10]],
      previousExtra: { metadata: { subjectToThresholding: true } },
    });

    const ai = await aiReferred(google, WINDOW, { compareWith: PREVIOUS });

    expect(ai.caveats).toHaveLength(1);
    expect(ai.caveats[0]).toMatch(/^In the comparison window: GA4 marks this report as subject to thresholding/);
  });

  it("reads no earlier window unless asked", async () => {
    const { google, asked } = aiReader({});

    expect((await aiReferred(google, WINDOW)).previous).toBeNull();
    expect(asked).toHaveLength(1);
  });
});

describe("organicLandings", () => {
  function organicReader(rows: Array<[string, number, number, number]>, extra: Partial<Ga4Report> = {}) {
    const asked: Ga4ReportQuery[] = [];
    const google = fakeGoogleReader({
      analytics: {
        runReport: async (query) => {
          asked.push(query);
          return report(query, rows.map(([page, ...metrics]) => [[page], metrics]), extra);
        },
      },
    });
    return { google, asked };
  }

  it("asks GA4 for Google organic alone: source google and medium organic, both exact", async () => {
    // The channel group, or the medium alone, takes in Bing and DuckDuckGo,
    // which Search Console does not report and so cannot be joined to.
    const { google, asked } = organicReader([]);

    await organicLandings(google, WINDOW, { limit: 1234 });

    expect(asked).toHaveLength(1);
    expect(asked[0]).toMatchObject({
      property: "properties/123456789",
      dateRanges: [WINDOW.dateRange],
      dimensions: ["landingPage"],
      metrics: ["sessions", "engagedSessions", "keyEvents"],
      orderBys: [{ metric: { metricName: "sessions" }, desc: true }],
      limit: 1234,
    });
    expect(asked[0].dimensionFilter).toEqual({
      andGroup: {
        expressions: [
          { filter: { fieldName: "sessionSource", stringFilter: { matchType: "EXACT", value: "google" } } },
          { filter: { fieldName: "sessionMedium", stringFilter: { matchType: "EXACT", value: "organic" } } },
        ],
      },
    });
    expect(JSON.stringify(asked[0])).not.toContain("sessionDefaultChannelGroup");
  });

  it("returns the pages busiest first, with pages GA4 could not name counted apart", async () => {
    const { google } = organicReader(
      [
        ["/pricing", 110, 90, 14],
        ["/guide", 280, 60, 0],
        ["(not set)", 5, 0, 0],
        ["", 2, 1, 0],
      ],
      { metadata: { subjectToThresholding: true } },
    );

    const organic = await organicLandings(google, WINDOW, { limit: 100 });

    expect(organic.pages).toEqual([
      { landingPage: "/guide", sessions: 280, engagedSessions: 60, keyEvents: 0 },
      { landingPage: "/pricing", sessions: 110, engagedSessions: 90, keyEvents: 14 },
    ]);
    expect(organic.unattributed).toEqual({ rows: 2, sessions: 7 });
    expect(organic.rowsRead).toBe(4);
    expect(organic.caveats[0]).toContain("thresholding");
  });
});
