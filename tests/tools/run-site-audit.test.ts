import { describe, it, expect, afterEach, vi } from "vitest";
import { handler as runSiteAudit } from "@/tools/run-site-audit";
import { handler as metricTrend } from "@/tools/seo-metric-trend";
import { fakeGoogleReader } from "@/lib/google/fake-reader";
import { findSite, listSites } from "@/lib/sites";
import { readSeries, readMonths } from "@/lib/metric-history";
import { listRefreshes } from "@/lib/site-refresh";
import { resetPersistence } from "@/lib/db/runtime";
import { DB_PATH_VARIABLE } from "@/lib/db/database";
import { InvalidInputError } from "@/lib/invalid-input-error";
import { useTempDatabase } from "../helpers/temp-database";
import { serve } from "../helpers/serve";

const originalFetch = globalThis.fetch;
let temp: ReturnType<typeof useTempDatabase> | null = null;

/** The public-surface half of the audit reaches the site over HTTP. */
function servePublicSurface(): void {
  serve({
    "example.com/robots.txt": { status: 404, body: "" },
    "https://example.com/": {
      headers: { "content-type": "text/html", "x-frame-options": "DENY" },
      body: "<html><head><title>Example</title></head><body></body></html>",
    },
  });
}

afterEach(() => {
  globalThis.fetch = originalFetch;
  temp?.dispose();
  temp = null;
  delete process.env[DB_PATH_VARIABLE];
  resetPersistence();
  vi.restoreAllMocks();
});

const textOf = (result: { content: Array<{ text: string }> }): string =>
  result.content.map((part) => part.text).join("\n");

const audit = (
  args: Partial<{ domain: string; ga4PropertyId: string; days: number }> = {},
  google = fakeGoogleReader(),
) =>
  runSiteAudit(
    {
      force_refresh: undefined,
      domain: "example.com",
      ga4PropertyId: undefined,
      days: undefined,
      ...args,
    },
    google,
  );

describe("run_site_audit with Property Access", () => {
  it("registers the Site and produces the Full Report", async () => {
    temp = useTempDatabase();
    servePublicSurface();

    const text = textOf(await audit());

    expect(listSites().map((site) => site.domain)).toEqual(["example.com"]);
    expect(text).toContain("=== FULL REPORT ===");
    expect(text).toContain("Search Console property: sc-domain:example.com");
    expect(text).toContain("=== SEARCH CONSOLE ===");
    expect(text).toContain("=== ANALYTICS ===");
    expect(text).toContain("=== PUBLIC SURFACE ===");
  });

  it("records the run's numbers so the next one can be compared against it", async () => {
    temp = useTempDatabase();
    servePublicSurface();

    await audit();
    const site = findSite("example.com")!;

    expect(readSeries(site.id, "gsc.clicks")).toHaveLength(1);
    expect(readSeries(site.id, "gsc.clicks")[0].value).toBe(494);
  });

  it("accumulates readings across runs rather than replacing them", async () => {
    temp = useTempDatabase();
    servePublicSurface();

    await audit();
    await audit();
    const site = findSite("example.com")!;

    // Two refreshes, so two rows: the idempotence key is `(refresh_id, metric)`,
    // which corrects a re-run of *one* refresh without collapsing history.
    expect(listRefreshes(site.id)).toHaveLength(2);
    expect(readSeries(site.id, "gsc.clicks")).toHaveLength(2);
  });

  it("shows movement once there is something to compare against", async () => {
    temp = useTempDatabase();
    servePublicSurface();

    const first = textOf(await audit());
    expect(first).toContain("Nothing to compare against yet");

    const google = fakeGoogleReader({
      searchConsole: {
        searchAnalytics: async () => [{ clicks: 410, impressions: 700, ctr: 0.58, position: 1.1 }],
      },
    });
    const second = textOf(await audit({}, google));

    expect(second).toContain("Search clicks: 410 (-84.00, worse)");
  });

  it("records an unanswered section as unmeasured rather than as zero", async () => {
    // A timed-out section stored as 0 is an invented collapse, and the trend
    // built on it shows a cliff that never happened.
    temp = useTempDatabase();
    servePublicSurface();
    const google = fakeGoogleReader({ searchConsole: { searchAnalytics: async () => [] } });

    const text = textOf(await audit({}, google));
    const site = findSite("example.com")!;

    expect(text).toContain("No search data in this window");
    expect(readSeries(site.id, "gsc.clicks")[0].value).toBeNull();
  });

  it("builds the monthly rollup as it goes", async () => {
    temp = useTempDatabase();
    servePublicSurface();

    await audit();
    const site = findSite("example.com")!;
    const months = readMonths(site.id);

    expect(months).toHaveLength(1);
    expect(months[0].readings).toBe(1);
    expect(months[0].metrics["gsc.clicks"].last).toBe(494);
  });

  it("says Analytics was not run rather than reporting zero sessions", async () => {
    // GA4 has no identifier carrying a domain, so it genuinely cannot be
    // inferred — which is different from being unavailable.
    temp = useTempDatabase();
    servePublicSurface();

    const text = textOf(await audit());

    expect(text).toContain("Not run: no GA4 property is linked");
    expect(text).toContain("cannot be");
    expect(text).not.toContain("Sessions: 0");
  });

  it("reads Analytics when a property is named, and remembers it", async () => {
    temp = useTempDatabase();
    servePublicSurface();

    await audit({ ga4PropertyId: "properties/123456789" });

    expect(findSite("example.com")?.ga4PropertyId).toBe("properties/123456789");
    const site = findSite("example.com")!;
    expect(readSeries(site.id, "ga4.sessions")).toHaveLength(1);
  });
});

describe("run_site_audit refusing rather than degrading", () => {
  it("refuses without Property Access, and does not return a partial report", async () => {
    // ADR-0003, and the rule most likely to be broken by a well-meaning change:
    // this Tool *could* return the public-surface analysis and call it a report.
    temp = useTempDatabase();
    servePublicSurface();
    const google = fakeGoogleReader({ searchConsole: { listProperties: async () => [] } });

    const failure = await audit({}, google).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(InvalidInputError);
    const message = (failure as Error).message;
    expect(message).toContain("No Full Report for example.com");
    expect(message).toContain("does not fall back to a smaller report");
    // And it names the Tools that do cover that case.
    expect(message).toContain("seo_analyze_page");
    expect(message).toContain("crawl_site");
    // Nothing that looks like a report came back.
    expect(message).not.toContain("=== FULL REPORT ===");
  });

  it("refuses on an unverified property with the sentence for that case", async () => {
    temp = useTempDatabase();

    const failure = await audit({ domain: "unverified.example.net" }).catch(
      (error: unknown) => error,
    );

    expect((failure as Error).message).toContain("not verified");
    expect((failure as Error).message).toContain("one step rather than a setup");
  });

  it("records nothing when it refuses", async () => {
    // A refusal that left a refresh row would put a gap in the history that
    // looks like a run whose numbers all vanished.
    temp = useTempDatabase();
    const google = fakeGoogleReader({ searchConsole: { listProperties: async () => [] } });

    await audit({}, google).catch(() => undefined);
    const site = findSite("example.com")!;

    expect(listRefreshes(site.id)).toHaveLength(0);
    expect(readSeries(site.id, "gsc.clicks")).toHaveLength(0);
  });

  it("marks a refresh failed rather than leaving it pending forever", async () => {
    temp = useTempDatabase();
    servePublicSurface();
    const google = fakeGoogleReader({
      searchConsole: {
        searchAnalytics: async () => {
          throw new Error("Google fell over");
        },
      },
    });

    await audit({}, google).catch(() => undefined);
    const site = findSite("example.com")!;

    expect(listRefreshes(site.id)[0].status).toBe("failed");
  });

  it("refuses when there is no database at all", async () => {
    process.env[DB_PATH_VARIABLE] = "off";
    resetPersistence();

    await expect(audit()).rejects.toThrow(/needs the server's database/);
  });
});

describe("seo_metric_trend", () => {
  const trend = (args: Partial<{ domain: string; metric: string; months: boolean }> = {}) =>
    metricTrend({
      force_refresh: undefined,
      domain: "example.com",
      metric: undefined,
      months: undefined,
      ...args,
    });

  it("shows the series and its movement", async () => {
    temp = useTempDatabase();
    servePublicSurface();
    await audit();
    await audit(
      {},
      fakeGoogleReader({
        searchConsole: {
          searchAnalytics: async () => [{ clicks: 200, impressions: 400, ctr: 0.5, position: 2 }],
        },
      }),
    );

    const text = textOf(await trend({ metric: "gsc.clicks" }));

    expect(text).toContain("=== Search clicks (gsc.clicks) ===");
    expect(text).toContain("Latest: 200");
    expect(text).toContain("worse");
  });

  it("reads a falling average position as an improvement", async () => {
    // The one metric where a bare arrow lies: a *rising* average position is a
    // site moving down the results page, so the direction has to be stated.
    temp = useTempDatabase();
    servePublicSurface();
    await audit();
    await audit(
      {},
      fakeGoogleReader({
        searchConsole: {
          searchAnalytics: async () => [{ clicks: 310, impressions: 520, ctr: 0.596, position: 5 }],
        },
      }),
    );

    const text = textOf(await trend({ metric: "gsc.position" }));

    expect(text).toContain("Lower is better for this one");
    expect(text).toContain("better");
  });

  it("reads the monthly rollups back", async () => {
    temp = useTempDatabase();
    servePublicSurface();
    await audit();

    const text = textOf(await trend({ months: true }));

    expect(text).toContain("=== BY MONTH (1) ===");
    expect(text).toContain("built from 1 run(s)");
  });

  it("tells an Operator with one run that the comparison starts with the second", async () => {
    temp = useTempDatabase();
    servePublicSurface();
    await audit();

    const text = textOf(await trend({ metric: "gsc.clicks" }));

    expect(text).toContain("first one that answered");
  });

  it("keeps 'not registered' apart from 'no history'", async () => {
    // The fixes differ: one is a Tool call away, the other is time.
    temp = useTempDatabase();

    await expect(trend({ domain: "never-seen.example" })).rejects.toThrow(
      /is not a registered Site/,
    );
  });

  it("refuses a metric key it does not record", async () => {
    temp = useTempDatabase();
    servePublicSurface();
    await audit();

    await expect(trend({ metric: "invented.metric" })).rejects.toThrow(/Known keys/);
  });
});
