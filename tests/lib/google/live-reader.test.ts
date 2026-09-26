import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { UpstreamApiError } from "@/lib/upstream-api-error";
import { requestsOf, serve, type ServedRequest } from "../../helpers/serve";

vi.mock("@/lib/google/oauth", () => ({
  accessToken: vi.fn(async () => "test-access-token"),
}));

import { createGoogleReader } from "@/lib/google/live-reader";

/** What each Google request asked, in order: the live record of the current `serve`. */
let calls: ServedRequest[] = [];

/** Answer every Google request with `answer`, recording what was asked. */
function answerBy(answer: () => { status?: number; payload: unknown }): void {
  const mock = serve({
    "googleapis.com": () => {
      const { status = 200, payload } = answer();
      return { status, body: JSON.stringify(payload), headers: { "content-type": "application/json" } };
    },
  });
  calls = requestsOf(mock);
}

/** Answer every Google request with one payload. */
function answerWith(payload: unknown, status = 200): void {
  answerBy(() => ({ status, payload }));
}

beforeEach(async () => {
  answerWith({});
  // The token mock is module-level, so its call count carries between cases.
  const { accessToken } = await import("@/lib/google/oauth");
  vi.mocked(accessToken).mockClear();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("authenticating every request", () => {
  it("sends the access token as a bearer token", async () => {
    await createGoogleReader().searchConsole.listProperties();

    expect(calls[0]?.headers.authorization).toBe(
      "Bearer test-access-token",
    );
  });

  it("asks for a token per request rather than holding one", async () => {
    // Nothing is cached in the reader, so a long-running server can never hand
    // out a stale token. The refresh decision lives in the token store.
    const { accessToken } = await import("@/lib/google/oauth");

    const reader = createGoogleReader();
    await reader.searchConsole.listProperties();
    await reader.searchConsole.listProperties();

    expect(accessToken).toHaveBeenCalledTimes(2);
  });
});

describe("Search Console requests", () => {
  it("escapes a Domain Property identifier in the path", async () => {
    // `sc-domain:example.com` contains a colon, which changes what a URL path
    // means. Forgetting this produces a 404 that reads as "you do not have this
    // property".
    await createGoogleReader().searchConsole.listSitemaps("sc-domain:example.com");

    expect(calls[0].url).toContain("/sites/sc-domain%3Aexample.com/sitemaps");
  });

  it("escapes a URL-Prefix Property identifier in the path", async () => {
    await createGoogleReader().searchConsole.listSitemaps("https://example.com/");

    expect(calls[0].url).toContain("/sites/https%3A%2F%2Fexample.com%2F/sitemaps");
  });

  it("posts the query without repeating the property in the body", async () => {
    await createGoogleReader().searchConsole.searchAnalytics({
      siteUrl: "sc-domain:example.com",
      startDate: "2026-08-01",
      endDate: "2026-08-28",
      dimensions: ["query"],
    });

    expect(calls[0]?.method).toBe("POST");
    const body = calls[0]?.json;
    expect(body).toEqual({
      startDate: "2026-08-01",
      endDate: "2026-08-28",
      dimensions: ["query"],
      // Google's own default, written out because the reader pages from it.
      rowLimit: 1_000,
      startRow: 0,
    });
    expect(body.siteUrl).toBeUndefined();
  });

  it("reads a limit above Google's page size in pages until one comes back short", async () => {
    const row = { keys: ["q"], clicks: 1, impressions: 1, ctr: 1, position: 1 };
    const pages = [25_000, 25_000, 7];
    // The request is recorded before it is answered, so `calls.length` is its number.
    answerBy(() => ({ payload: { rows: Array.from({ length: pages[calls.length - 1] ?? 0 }, () => row) } }));

    const rows = await createGoogleReader().searchConsole.searchAnalytics({
      siteUrl: "sc-domain:example.com",
      startDate: "2026-08-01",
      endDate: "2026-08-28",
      dimensions: ["query"],
      rowLimit: 100_000,
    });

    // Without paging this was 25,000 rows presented as all of them.
    expect(rows).toHaveLength(50_007);
    expect(calls).toHaveLength(3);
    expect(calls.map((call) => call.json.startRow)).toEqual([0, 25_000, 50_000]);
    expect(calls.map((call) => call.json.rowLimit)).toEqual([
      25_000, 25_000, 25_000,
    ]);
  });

  it("never asks for more rows than the caller's limit", async () => {
    answerWith({ rows: [] });

    await createGoogleReader().searchConsole.searchAnalytics({
      siteUrl: "sc-domain:example.com",
      startDate: "2026-08-01",
      endDate: "2026-08-28",
      rowLimit: 30,
    });

    expect(calls[0]?.json.rowLimit).toBe(30);
    expect(calls).toHaveLength(1);
  });

  it("passes on which days Google says are still partial", async () => {
    answerWith({ rows: [], metadata: { firstIncompleteDate: "2026-09-23" } });

    const result = await createGoogleReader().searchConsole.searchAnalyticsWithMetadata({
      siteUrl: "sc-domain:example.com",
      startDate: "2026-09-01",
      endDate: "2026-09-24",
      dimensions: ["date"],
      dataState: "all",
    });

    expect(result.firstIncompleteDate).toBe("2026-09-23");
    expect(calls[0]?.json.dataState).toBe("all");
  });

  it("reads no properties as an empty list rather than as undefined", async () => {
    // An Operator with no properties gets `{}` from Google, not `{ siteEntry: [] }`.
    answerWith({});

    await expect(createGoogleReader().searchConsole.listProperties()).resolves.toEqual([]);
  });

  it("reads no rows as an empty list", async () => {
    answerWith({});

    await expect(
      createGoogleReader().searchConsole.searchAnalytics({
        siteUrl: "sc-domain:example.com",
        startDate: "2026-08-01",
        endDate: "2026-08-28",
      }),
    ).resolves.toEqual([]);
  });

  it("names both the property and the URL when inspecting", async () => {
    // Google requires the property: the same URL can sit under more than one
    // property an Operator holds.
    await createGoogleReader().searchConsole.inspectUrl(
      "sc-domain:example.com",
      "https://example.com/page",
    );

    const body = calls[0]?.json;
    expect(body.siteUrl).toBe("sc-domain:example.com");
    expect(body.inspectionUrl).toBe("https://example.com/page");
  });
});

describe("Analytics requests", () => {
  it("accepts a bare property id and a full resource name alike", async () => {
    const reader = createGoogleReader();

    await reader.analytics.getMetadata("123456789");
    await reader.analytics.getMetadata("properties/123456789");

    expect(calls[0].url).toContain("/properties/123456789/metadata");
    expect(calls[1].url).toContain("/properties/123456789/metadata");
  });

  it("converts dimensions and metrics into the shape the Data API wants", async () => {
    // The API takes `[{ name: "sessions" }]` where every caller here thinks in
    // `["sessions"]`. Converting at the boundary keeps the awkward shape out of
    // every Tool.
    await createGoogleReader().analytics.runReport({
      property: "123456789",
      dateRanges: [{ startDate: "2026-08-01", endDate: "2026-08-28" }],
      dimensions: ["sessionDefaultChannelGroup"],
      metrics: ["sessions"],
    });

    const body = calls[0]?.json;
    expect(body.dimensions).toEqual([{ name: "sessionDefaultChannelGroup" }]);
    expect(body.metrics).toEqual([{ name: "sessions" }]);
    expect(body.dateRanges).toEqual([{ startDate: "2026-08-01", endDate: "2026-08-28" }]);
  });

  it("flattens account summaries into one list of properties", async () => {
    // Account summaries rather than the properties endpoint, which needs an
    // account filter an Operator does not necessarily know.
    answerWith({
      accountSummaries: [
        {
          account: "accounts/1",
          displayName: "Example Ltd",
          propertySummaries: [
            { property: "properties/111", displayName: "One" },
            { property: "properties/222", displayName: "Two" },
          ],
        },
        { account: "accounts/2", displayName: "Other", propertySummaries: [] },
      ],
    });

    await expect(createGoogleReader().analytics.listProperties()).resolves.toEqual([
      { name: "properties/111", displayName: "One", account: "Example Ltd" },
      { name: "properties/222", displayName: "Two", account: "Example Ltd" },
    ]);
  });
});

describe("Analytics configuration requests", () => {
  it("reads the stable settings from v1beta and the rest from v1alpha", async () => {
    const reader = createGoogleReader();

    await reader.analyticsAdmin.getDataRetention("123");
    await reader.analyticsAdmin.getAttributionSettings("123");
    await reader.analyticsAdmin.getEnhancedMeasurement("properties/123/dataStreams/9");

    expect(calls[0].url).toBe(
      "https://analyticsadmin.googleapis.com/v1beta/properties/123/dataRetentionSettings",
    );
    expect(calls[1].url).toBe(
      "https://analyticsadmin.googleapis.com/v1alpha/properties/123/attributionSettings",
    );
    expect(calls[2].url).toBe(
      "https://analyticsadmin.googleapis.com/v1alpha/properties/123/dataStreams/9/enhancedMeasurementSettings",
    );
    expect(calls.every((call) => call.method === "GET")).toBe(true);
  });

  it("follows every page of a list", async () => {
    const pages = [
      { keyEvents: [{ eventName: "purchase" }], nextPageToken: "next" },
      { keyEvents: [{ eventName: "generate_lead" }] },
    ];
    answerBy(() => ({ payload: pages[calls.length - 1] }));

    const events = await createGoogleReader().analyticsAdmin.listKeyEvents("123");

    expect(events.map((event) => event.eventName)).toEqual(["purchase", "generate_lead"]);
    expect(calls[1].url).toContain("pageToken=next");
  });

  it("names a link by what it links to", async () => {
    answerWith({ bigqueryLinks: [{ name: "properties/123/bigQueryLinks/1", project: "projects/42" }] });

    await expect(createGoogleReader().analyticsAdmin.listBigQueryLinks("123")).resolves.toEqual([
      { name: "properties/123/bigQueryLinks/1", target: "projects/42" },
    ]);
  });

  it("sends a funnel's steps as event filters, narrowed to a page when one is named", async () => {
    await createGoogleReader().analytics.runFunnelReport({
      property: "123",
      dateRanges: [{ startDate: "28daysAgo", endDate: "yesterday" }],
      steps: [
        { name: "Landing", eventName: "session_start" },
        { name: "Pricing", eventName: "page_view", pagePathPrefix: "/pricing" },
      ],
    });

    expect(calls[0].url).toBe("https://analyticsdata.googleapis.com/v1alpha/properties/123:runFunnelReport");
    const body = calls[0]?.json;
    expect(body.funnel.steps[0].filterExpression).toEqual({
      funnelEventFilter: { eventName: "session_start" },
    });
    expect(body.funnel.steps[1].filterExpression.andGroup.expressions[1]).toEqual({
      funnelFieldFilter: {
        fieldName: "pagePath",
        stringFilter: { matchType: "BEGINS_WITH", value: "/pricing" },
      },
    });
  });
});

describe("when Google refuses", () => {
  it("names the service and the status, and never forwards Google's body", async () => {
    answerWith({ error: { message: "Request had insufficient authentication scopes." } }, 403);

    const failure = await createGoogleReader()
      .searchConsole.listProperties()
      .catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(UpstreamApiError);
    const message = (failure as Error).message;
    expect(message).toContain("Google Search Console returned HTTP 403");
    expect(message).toContain("The key was refused");
    expect(message).not.toContain("insufficient authentication scopes");
  });

  it("distinguishes Analytics from Search Console in the refusal", async () => {
    answerWith({}, 429);

    await expect(createGoogleReader().analytics.listProperties()).rejects.toThrow(
      /Google Analytics returned HTTP 429/,
    );
  });
});

describe("no ambient auth state anywhere", () => {
  /**
   * Asserted against the source, because this is a rule about shape rather than
   * behaviour and no test of behaviour would catch it being broken.
   *
   * The retired implementation carried its OAuth client in an
   * `AsyncLocalStorage`, because on a shared serverless runtime module scope
   * meant one user's tokens answering another user's request. A **Single-tenant**
   * server has no callers to isolate, so porting the machinery would have added
   * the complexity without the reason — and left a thread-local a future reader
   * could mistake for a per-caller boundary this server does not have.
   */
  it("contains no AsyncLocalStorage in the Google layer", () => {
    const dir = path.resolve(process.cwd(), "src/lib/google");

    for (const file of readdirSync(dir).filter((name) => name.endsWith(".ts"))) {
      const source = readFileSync(path.join(dir, file), "utf8");
      // Comments are allowed to explain the decision; a use is not.
      expect(source.replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, ""), file).not.toContain(
        "AsyncLocalStorage",
      );
    }
  });

  it("holds no module-level mutable credential", () => {
    const dir = path.resolve(process.cwd(), "src/lib/google");

    for (const file of readdirSync(dir).filter((name) => name.endsWith(".ts"))) {
      const source = readFileSync(path.join(dir, file), "utf8").replace(
        /\/\*[\s\S]*?\*\/|\/\/[^\n]*/g,
        "",
      );
      // A top-level `let` in this layer is how a cached client or token would
      // arrive. There is no legitimate one today.
      expect(source, file).not.toMatch(/^let\s/m);
    }
  });
});
