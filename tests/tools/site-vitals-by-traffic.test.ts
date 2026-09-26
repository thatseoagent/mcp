import { describe, it, expect, afterEach, vi } from "vitest";
import siteVitals, { handler } from "@/tools/site-vitals-by-traffic";
import { fakeGoogleReader } from "@/lib/google/fake-reader";
import type { SearchAnalyticsQuery, SearchAnalyticsRow } from "@/lib/google/reader";
import { UpstreamApiError } from "@/lib/upstream-api-error";
import { resetAllSingleFlightCaches } from "@/lib/single-flight";
import { serve } from "../helpers/serve";

afterEach(() => {
  vi.unstubAllGlobals();
  resetAllSingleFlightCaches();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

const textOf = (result: { content: Array<{ text: string }> }): string =>
  result.content.map((part) => part.text).join("\n");

const args = (extra: { pages?: number; device?: "phone" | "desktop" } = {}) => ({
  force_refresh: undefined,
  siteUrl: "example.com",
  startDate: undefined,
  endDate: undefined,
  days: undefined,
  pages: undefined,
  device: undefined,
  ...extra,
});

function row(page: string, clicks: number): SearchAnalyticsRow {
  return { keys: [page], clicks, impressions: clicks * 20, ctr: 0.05, position: 5 };
}

/** A reader whose `page` rows are these, recording what it was asked. */
function readerWith(rows: SearchAnalyticsRow[]) {
  const asked: SearchAnalyticsQuery[] = [];
  const reader = fakeGoogleReader({
    searchConsole: {
      searchAnalytics: async (query: SearchAnalyticsQuery) => {
        asked.push(query);
        return rows;
      },
    },
  });
  return { reader, asked };
}

/** A `queryRecord` answer with these p75s; omitted vitals are absent. */
function record(subject: { url?: string; origin?: string }, p75: { lcp?: number; inp?: number; cls?: number }) {
  const metric = (value: number | string | undefined) =>
    value === undefined ? undefined : { histogram: [{ density: 0.5 }, { density: 0.3 }, { density: 0.2 }], percentiles: { p75: value } };
  return {
    record: {
      key: subject,
      metrics: Object.fromEntries(
        [
          ["largest_contentful_paint", metric(p75.lcp)],
          ["interaction_to_next_paint", metric(p75.inp)],
          ["cumulative_layout_shift", metric(p75.cls === undefined ? undefined : String(p75.cls))],
        ].filter(([, v]) => v !== undefined),
      ),
      collectionPeriod: {
        firstDate: { year: 2026, month: 8, day: 24 },
        lastDate: { year: 2026, month: 9, day: 20 },
      },
    },
  };
}

type Answer = [number, unknown];
const NOT_FOUND: Answer = [404, { error: { code: 404 } }];

/** Answer CrUX by what was asked; record every body and the peak concurrency. */
function crux(answer: (body: Record<string, unknown>) => Answer, delayMs = 0) {
  const bodies: Array<Record<string, unknown>> = [];
  let inFlight = 0;
  const stats = { peak: 0 };
  serve({
    "chromeuxreport.googleapis.com": async (request) => {
      const body = request.json as Record<string, unknown>;
      bodies.push(body);
      inFlight++;
      stats.peak = Math.max(stats.peak, inFlight);
      if (delayMs > 0) await new Promise((resolve) => setTimeout(resolve, delayMs));
      inFlight--;
      const [status, payload] = answer(body);
      return { status, body: JSON.stringify(payload), headers: { "content-type": "application/json" } };
    },
  });
  return { bodies, stats };
}

/** Five pages: slow and busy, very slow and quieter, fast, origin-only, and unmeasured. */
const ROWS = [
  row("https://example.com/busy-slow", 1000),
  row("https://example.com/quiet-very-slow", 100),
  row("https://example.com/fast", 800),
  row("https://example.com/no-page-record", 300),
  row("https://blog.example.com/nothing", 50),
  row("https://example.com/never-clicked", 0),
];

const RECORDS: Record<string, Answer> = {
  "https://example.com/busy-slow": [200, record({ url: "https://example.com/busy-slow" }, { lcp: 4000, inp: 150, cls: 0.05 })],
  "https://example.com/quiet-very-slow": [
    200,
    record({ url: "https://example.com/quiet-very-slow" }, { lcp: 6000, inp: 600, cls: 0.05 }),
  ],
  "https://example.com/fast": [200, record({ url: "https://example.com/fast" }, { lcp: 1800, inp: 90, cls: 0.01 })],
  "https://example.com": [200, record({ origin: "https://example.com" }, { lcp: 3000, inp: 180, cls: 0.02 })],
};

const answerRecords = (body: Record<string, unknown>): Answer =>
  RECORDS[String(body.url ?? body.origin)] ?? NOT_FOUND;

describe("site_vitals_by_traffic without the key", () => {
  it("refuses naming the variable, before reading Search Console or CrUX", async () => {
    vi.stubEnv("PAGESPEED_API_KEY", undefined);
    const { reader, asked } = readerWith(ROWS);
    const { bodies } = crux(answerRecords);

    await expect(handler(args(), reader)).rejects.toThrow("PAGESPEED_API_KEY");
    expect(asked).toHaveLength(0);
    expect(bodies).toHaveLength(0);
  });

  it("refuses as a Tool result through the wrapper", async () => {
    vi.stubEnv("PAGESPEED_API_KEY", undefined);

    const result = await siteVitals({ siteUrl: "example.com" } as Parameters<typeof siteVitals>[0]);

    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("Chrome UX Report API");
  });
});

describe("site_vitals_by_traffic", () => {
  it("reads the page dimension from Search Console", async () => {
    vi.stubEnv("PAGESPEED_API_KEY", "test-key");
    const { reader, asked } = readerWith(ROWS);
    crux(answerRecords);

    await handler(args(), reader);

    expect(asked[0]?.dimensions).toEqual(["page"]);
  });

  it("ranks slow pages by clicks × distance from good, not by slowness alone", async () => {
    vi.stubEnv("PAGESPEED_API_KEY", "test-key");
    crux(answerRecords);

    const text = textOf(await handler(args(), readerWith(ROWS).reader));

    // busy-slow: 1000 × 0.6 = 600. quiet-very-slow: 100 × (1.4 + 2.0) = 340.
    expect(text).toContain("1. https://example.com/busy-slow — 1,000 clicks, weight 600");
    expect(text).toContain("2. https://example.com/quiet-very-slow — 100 clicks, weight 340");
    expect(text).toContain("LCP 4.0s (needs improvement), INP 150ms (good), CLS 0.050 (good)");
    expect(text).toContain("not an estimate of clicks lost");
  });

  it("lists a fast page as passing and leaves it out of the ranking", async () => {
    vi.stubEnv("PAGESPEED_API_KEY", "test-key");
    crux(answerRecords);

    const text = textOf(await handler(args(), readerWith(ROWS).reader));
    const passing = text.slice(text.indexOf("=== PASSING"));

    expect(passing).toContain("- https://example.com/fast — 800 clicks");
    expect(text.slice(0, text.indexOf("=== PASSING"))).not.toContain("example.com/fast");
  });

  it("falls back to the origin for a page without its own record, and says so", async () => {
    vi.stubEnv("PAGESPEED_API_KEY", "test-key");
    const { bodies } = crux(answerRecords);

    const text = textOf(await handler(args(), readerWith(ROWS).reader));
    const section = text.slice(text.indexOf("=== MEASURED ONLY AS PART OF THEIR ORIGIN"));

    expect(bodies).toContainEqual({ origin: "https://example.com", formFactor: "PHONE" });
    expect(section).toContain("not how these pages do");
    expect(section).toContain("https://example.com: LCP 3.0s (needs improvement)");
    expect(section).toContain("- https://example.com/no-page-record — 300 clicks");
  });

  it("lists a page with no data anywhere as not measured, never as fast", async () => {
    vi.stubEnv("PAGESPEED_API_KEY", "test-key");
    crux(answerRecords);

    const text = textOf(await handler(args(), readerWith(ROWS).reader));
    const section = text.slice(text.indexOf("=== NOT CHECKED"));

    expect(section).toContain("not a fast page");
    expect(section).toContain("  https://blog.example.com/nothing (50 clicks) — ");
    expect(text.slice(text.indexOf("=== PASSING"), text.indexOf("=== NOT CHECKED"))).not.toContain(
      "blog.example.com",
    );
  });

  it("does not ask CrUX about a page without clicks", async () => {
    vi.stubEnv("PAGESPEED_API_KEY", "test-key");
    const { bodies } = crux(answerRecords);

    await handler(args(), readerWith(ROWS).reader);

    expect(bodies.map((b) => b.url)).not.toContain("https://example.com/never-clicked");
  });

  it("asks for the origin once, however many of its pages need it", async () => {
    vi.stubEnv("PAGESPEED_API_KEY", "test-key");
    const rows = [row("https://example.com/a", 10), row("https://example.com/b", 9), row("https://example.com/c", 8)];
    const { bodies } = crux((body) => (body.origin ? RECORDS["https://example.com"] : NOT_FOUND) as Answer);

    await handler(args(), readerWith(rows).reader);

    expect(bodies.filter((b) => b.origin)).toHaveLength(1);
  });

  it("reads phone by default and desktop when asked", async () => {
    vi.stubEnv("PAGESPEED_API_KEY", "test-key");
    const phone = crux(answerRecords);
    await handler(args(), readerWith(ROWS).reader);
    expect(phone.bodies.every((b) => b.formFactor === "PHONE")).toBe(true);

    resetAllSingleFlightCaches();
    const desktop = crux(answerRecords);
    const text = textOf(await handler(args({ device: "desktop" }), readerWith(ROWS).reader));
    expect(desktop.bodies.every((b) => b.formFactor === "DESKTOP")).toBe(true);
    expect(text).toContain("Devices: desktop");
  });

  it("measures the top 10 by default and at most 25", async () => {
    vi.stubEnv("PAGESPEED_API_KEY", "test-key");
    const many = Array.from({ length: 40 }, (_, i) => row(`https://example.com/p${i}`, 1000 - i));
    const fast = (body: Record<string, unknown>): Answer =>
      body.url ? [200, record({ url: String(body.url) }, { lcp: 1000, inp: 50, cls: 0.01 })] : NOT_FOUND;

    const byDefault = crux(fast);
    const text = textOf(await handler(args(), readerWith(many).reader));
    expect(byDefault.bodies).toHaveLength(10);
    expect(text).toContain("the top 10 of 40 page(s) with clicks");

    resetAllSingleFlightCaches();
    const most = crux(fast);
    await handler(args({ pages: 99 }), readerWith(many).reader);
    expect(most.bodies).toHaveLength(25);
  });

  it("keeps CrUX requests to a few at a time", async () => {
    // Each answer takes longer than http-client's 100ms gap between starts, so
    // requests overlap and the pool, not the pace, is what caps them.
    vi.stubEnv("PAGESPEED_API_KEY", "test-key");
    const many = Array.from({ length: 12 }, (_, i) => row(`https://example.com/p${i}`, 100 - i));
    const { stats } = crux(
      (body) => [200, record({ url: String(body.url) }, { lcp: 1000, inp: 50, cls: 0.01 })],
      350,
    );

    await handler(args({ pages: 12 }), readerWith(many).reader);

    expect(stats.peak).toBeGreaterThan(1);
    expect(stats.peak).toBeLessThanOrEqual(3);
  });

  it("answers an empty window without asking CrUX anything", async () => {
    vi.stubEnv("PAGESPEED_API_KEY", "test-key");
    const { bodies } = crux(answerRecords);

    const result = await handler(args(), readerWith([]).reader);

    expect(result.isError).toBeUndefined();
    expect(textOf(result)).toContain("No page earned a click in this window");
    expect(textOf(result)).toContain("=== WHAT THIS IS BASED ON ===");
    expect(bodies).toHaveLength(0);
  });

  it("propagates a Search Console refusal rather than answering in part", async () => {
    vi.stubEnv("PAGESPEED_API_KEY", "test-key");
    crux(answerRecords);
    const reader = fakeGoogleReader({
      searchConsole: {
        searchAnalytics: async () => {
          throw new UpstreamApiError("Google Search Console", 403);
        },
      },
    });

    await expect(handler(args(), reader)).rejects.toBeInstanceOf(UpstreamApiError);
  });

  it("propagates a CrUX refusal rather than listing the pages it did read", async () => {
    vi.stubEnv("PAGESPEED_API_KEY", "test-key");
    crux((body) => (body.url === "https://example.com/fast" ? [429, {}] : answerRecords(body)));

    await expect(handler(args(), readerWith(ROWS).reader)).rejects.toThrow("HTTP 429");
  });

  it("prints no NaN, undefined, Infinity or [object Object]", async () => {
    vi.stubEnv("PAGESPEED_API_KEY", "test-key");
    crux((body) =>
      body.url === "https://example.com/busy-slow"
        ? [200, record({ url: "https://example.com/busy-slow" }, { lcp: 5000 })]
        : answerRecords(body),
    );

    const text = textOf(await handler(args(), readerWith([...ROWS, row("not a url", 5)]).reader));

    expect(text).not.toMatch(/NaN|undefined|Infinity|\[object Object\]/);
    // A page with only LCP is still ranked by the vital it has, and the others are named missing.
    expect(text).toContain("LCP 5.0s (poor), INP no reading, CLS no reading");
    expect(text).toContain("  not a url (5 clicks) — Search Console's key for it is not a URL CrUX can look up");
  });
});
