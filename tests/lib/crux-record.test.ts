import { describe, it, expect, afterEach, vi } from "vitest";
import {
  assessVitals,
  describeDiagnostics,
  largestLcpSubpart,
  readCruxRecord,
  readRecord,
} from "@/lib/crux-record";
import { readCruxHistory } from "@/lib/crux-history";
import { requestsOf, serve } from "../helpers/serve";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

const A_RECORD = {
  record: {
    key: { url: "https://example.com/a" },
    metrics: {
      largest_contentful_paint: {
        histogram: [{ density: 0.7 }, { density: 0.2 }, { density: 0.1 }],
        percentiles: { p75: 2900 },
      },
      cumulative_layout_shift: { histogram: [{ density: "NaN" }], percentiles: { p75: "0.02" } },
      round_trip_time: { percentiles: { p75: 180 } },
      navigation_types: { fractions: { navigate: 0.9, back_forward: 0.05, back_forward_cache: 0.05 } },
    },
    collectionPeriod: {
      firstDate: { year: 2026, month: 8, day: 24 },
      lastDate: { year: 2026, month: 9, day: 20 },
    },
  },
};

describe("readRecord", () => {
  it("reads rated vitals, diagnostics and the window", () => {
    const result = readRecord(A_RECORD, "page", "https://example.com/a", "PHONE");
    if (result.kind !== "record") throw new Error("expected a record");
    const { record } = result;

    expect(record.subject).toBe("https://example.com/a");
    expect(record.periodStart).toBe("2026-08-24");
    expect(record.periodEnd).toBe("2026-09-20");
    expect(record.vitals.find((v) => v.key === "lcp")).toEqual({
      key: "lcp",
      p75: 2900,
      shares: { good: 0.7, needsImprovement: 0.2, poor: 0.1 },
    });
    // A string CLS is a number; a "NaN" density is no reading, not zero.
    expect(record.vitals.find((v) => v.key === "cls")).toEqual({
      key: "cls",
      p75: 0.02,
      shares: { good: null, needsImprovement: null, poor: null },
    });
    expect(record.diagnostics.roundTripTime).toBe(180);
    expect(record.diagnostics.navigationTypes.back_forward_cache).toBe(0.05);
  });

  it("treats a response with no record as no data", () => {
    expect(readRecord({}, "origin", "https://example.com", "ALL").kind).toBe("no-data");
    expect(readRecord("garbage", "origin", "https://example.com", "ALL").kind).toBe("no-data");
  });
});

describe("assessVitals", () => {
  it("does not pass a reading with a missing vital", () => {
    expect(assessVitals([{ key: "lcp", p75: 2000, shares: null }, { key: "cls", p75: 0.01, shares: null }])).toEqual({
      verdict: "unassessable",
      missing: ["inp"],
    });
  });

  it("fails a reading whatever the missing vital would say, once one fails", () => {
    expect(assessVitals([{ key: "lcp", p75: 5000, shares: null }]).verdict).toBe("fails");
  });
});

describe("the diagnostics", () => {
  it("names no largest LCP part unless all four were measured", () => {
    const three = [
      { part: "ttfb" as const, p75: 300 },
      { part: "loadDelay" as const, p75: 900 },
      { part: "loadDuration" as const, p75: 200 },
      { part: "renderDelay" as const, p75: null },
    ];
    expect(largestLcpSubpart(three)).toBeNull();
    expect(largestLcpSubpart(three.map((p) => ({ ...p, p75: p.p75 ?? 100 })))?.part).toBe("loadDelay");
  });

  it("says a missing diagnostic is missing and rates nothing", () => {
    const lines = describeDiagnostics({
      lcpSubparts: [],
      lcpResourceType: {},
      navigationTypes: { navigate: 0.95, back_forward: 0.03, back_forward_cache: 0.01 },
      roundTripTime: null,
    }).join("\n");

    expect(lines).toContain("bfcache share: 25% of back/forward navigations");
    expect(lines).not.toContain("Round trip time");
    expect(lines).not.toMatch(/\((good|poor|needs improvement)\)/);
  });
});

describe("readCruxRecord", () => {
  it("asks queryRecord for the origin, and answers a 404 as no data", async () => {
    vi.stubEnv("PAGESPEED_API_KEY", "test-key");
    const mock = serve({ "chromeuxreport.googleapis.com": { status: 404, body: "{}" } });

    const result = await readCruxRecord({ url: "https://example.com/deep/page", scope: "origin", formFactor: "DESKTOP" });

    expect(result).toEqual({ kind: "no-data", subject: "https://example.com", scope: "origin", formFactor: "DESKTOP" });
    const [asked] = requestsOf(mock);
    expect(asked?.url).toContain("records:queryRecord");
    expect(asked?.searchParams.get("key")).toBe("test-key");
    expect(asked?.json).toEqual({ origin: "https://example.com", formFactor: "DESKTOP" });
  });

  it("refuses before any request without the key", async () => {
    vi.stubEnv("PAGESPEED_API_KEY", undefined);
    const mock = serve({ "chromeuxreport.googleapis.com": { body: "{}" } });

    await expect(readCruxRecord({ url: "https://example.com/", scope: "page" })).rejects.toThrow(
      "Chrome UX Report API",
    );
    expect(mock).not.toHaveBeenCalled();
  });

  it("throws a refusal rather than reading it as no data", async () => {
    vi.stubEnv("PAGESPEED_API_KEY", "test-key");
    serve({ "chromeuxreport.googleapis.com": { status: 403, body: "{}" } });

    await expect(readCruxRecord({ url: "https://example.com/", scope: "page" })).rejects.toThrow("HTTP 403");
  });
});

describe("CrUX's quota", () => {
  it("is one window of 150 a minute for both endpoints, and the next request waits for it", async () => {
    // Google's allowance covers `queryRecord` and `queryHistoryRecord` together,
    // so 149 record reads and one history read spend it, and the next record
    // read waits rather than being sent to meet a 429.
    vi.useFakeTimers();
    vi.stubEnv("PAGESPEED_API_KEY", "test-key");
    const mock = serve({ "chromeuxreport.googleapis.com": { status: 404, body: "{}" } });

    for (let i = 0; i < 149; i++) {
      await readCruxRecord({ url: `https://example.com/${i}`, scope: "page" });
    }
    await readCruxHistory({ url: "https://example.com/", scope: "origin" });

    let started = false;
    const next = readCruxRecord({ url: "https://example.com/next", scope: "page" }).then(() => {
      started = true;
    });
    await vi.advanceTimersByTimeAsync(59_000);
    expect(started).toBe(false);
    expect(mock).toHaveBeenCalledTimes(150);

    await vi.advanceTimersByTimeAsync(1_100);
    await next;
    expect(started).toBe(true);
  });
});
