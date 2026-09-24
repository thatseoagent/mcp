import { describe, it, expect, afterEach, vi } from "vitest";
import cruxHistory from "@/tools/crux-history";
import { readHistory } from "@/lib/crux-history";
import { resetAllSingleFlightCaches } from "@/lib/single-flight";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
  resetAllSingleFlightCaches();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

const textOf = (result: Awaited<ReturnType<typeof cruxHistory>>): string =>
  result.content.map((part) => part.text).join("\n");

/** The handler's arguments as xmcp hands them over: optional keys present. */
const run = (args: { url: string; scope?: "page" | "origin"; device?: "phone" | "desktop" | "tablet" }) =>
  cruxHistory({ scope: undefined, device: undefined, ...args });

/** Answer the CrUX endpoint with one payload, and record what was asked. */
function answerWith(payload: unknown, status = 200) {
  const mock = vi.fn(async () =>
    new Response(JSON.stringify(payload), {
      status,
      headers: { "content-type": "application/json" },
    }),
  );
  globalThis.fetch = mock as unknown as typeof fetch;
  return mock;
}

const period = (y: number, m: number, d: number) => ({
  firstDate: { year: y, month: m, day: d },
  lastDate: { year: y, month: m, day: d },
});

/** Four periods: LCP improves from needs-improvement to good in the third. */
const AN_IMPROVING_ORIGIN = {
  record: {
    key: { origin: "https://example.com" },
    collectionPeriods: [period(2026, 8, 30), period(2026, 9, 6), period(2026, 9, 13), period(2026, 9, 20)],
    metrics: {
      largest_contentful_paint: {
        histogramTimeseries: [
          { start: 0, end: 2500, densities: [0.6, 0.65, 0.78, 0.8] },
          { start: 2500, end: 4000, densities: [0.3, 0.25, 0.15, 0.14] },
          { start: 4000, densities: [0.1, 0.1, 0.07, 0.06] },
        ],
        percentilesTimeseries: { p75s: [3100, 2800, 2400, 2300] },
      },
      interaction_to_next_paint: {
        histogramTimeseries: [{ start: 0, end: 200, densities: [0.9, 0.9, 0.9, 0.9] }],
        percentilesTimeseries: { p75s: [150, 160, 155, 150] },
      },
      cumulative_layout_shift: {
        histogramTimeseries: [{ start: "0.00", end: "0.10", densities: [0.9, 0.9, "NaN", 0.9] }],
        // CrUX writes CLS as strings, and a missing reading as null.
        percentilesTimeseries: { p75s: ["0.05", "0.06", null, "0.04"] },
      },
    },
  },
};

describe("crux_history without the key configured", () => {
  it("refuses with the variable and the API to enable, before any request", async () => {
    vi.stubEnv("PAGESPEED_API_KEY", undefined);
    const mock = answerWith({});

    const result = await run({ url: "https://example.com/" });

    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("PAGESPEED_API_KEY");
    expect(textOf(result)).toContain("Chrome UX Report API");
    expect(mock).not.toHaveBeenCalled();
  });
});

describe("crux_history with the key configured", () => {
  it("asks for the origin when told to, not for the page", async () => {
    vi.stubEnv("PAGESPEED_API_KEY", "test-key");
    const mock = answerWith(AN_IMPROVING_ORIGIN);

    await run({ url: "https://example.com/blog/post?x=1", scope: "origin", device: "phone" });

    const [calledUrl, init] = mock.mock.calls[0] as unknown as [string, RequestInit];
    expect(calledUrl).toContain("records:queryHistoryRecord");
    expect(init.method).toBe("POST");
    expect(JSON.parse(String(init.body))).toEqual({ origin: "https://example.com", formFactor: "PHONE" });
  });

  it("reports the direction and when the rating changed", async () => {
    vi.stubEnv("PAGESPEED_API_KEY", "test-key");
    answerWith(AN_IMPROVING_ORIGIN);

    const text = textOf(await run({ url: "https://example.com/", scope: "origin" }));

    expect(text).toContain("LCP: 3.1s (needs improvement) → 2.3s (good)");
    expect(text).toContain('Visits in "good": 60% → 80%');
    expect(text).toContain("needs improvement → good in the window ending 2026-09-13");
    expect(text).toContain("Latest period: passes");
  });

  it("says the readings overlap, before any number", async () => {
    vi.stubEnv("PAGESPEED_API_KEY", "test-key");
    answerWith(AN_IMPROVING_ORIGIN);

    const text = textOf(await run({ url: "https://example.com/", scope: "origin" }));

    expect(text.indexOf("share three of their four")).toBeGreaterThan(-1);
    expect(text.indexOf("share three of their four")).toBeLessThan(text.indexOf("LCP:"));
  });

  it("does not read a period with no CLS reading as a perfect score", async () => {
    vi.stubEnv("PAGESPEED_API_KEY", "test-key");
    answerWith(AN_IMPROVING_ORIGIN);

    const text = textOf(await run({ url: "https://example.com/", scope: "origin" }));

    expect(text).toContain("1 of 4 periods had too few samples");
    expect(text).toMatch(/2026-09-13\s+2\.4s\s+155ms\s+—/);
  });

  it("answers, rather than erroring, when CrUX has no data", async () => {
    vi.stubEnv("PAGESPEED_API_KEY", "test-key");
    answerWith({ error: { code: 404, message: "chrome ux report data not found" } }, 404);

    const result = await run({ url: "https://example.com/quiet-page" });

    expect(result.isError).toBeUndefined();
    expect(textOf(result)).toContain("absence of a reading");
    expect(textOf(result)).toContain("Try scope: origin");
  });

  it("names the refusal when the API is not enabled for the key", async () => {
    vi.stubEnv("PAGESPEED_API_KEY", "test-key");
    answerWith({ error: { code: 403, message: "API not enabled" } }, 403);

    const result = await run({ url: "https://example.com/" });

    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("Chrome UX Report API returned HTTP 403");
    // The remote body stays on stderr, never in the model's context.
    expect(textOf(result)).not.toContain("API not enabled");
  });

  it("will not call a period passing when a ranking vital has no reading", async () => {
    vi.stubEnv("PAGESPEED_API_KEY", "test-key");
    const withoutInp = structuredClone(AN_IMPROVING_ORIGIN) as { record: { metrics: Record<string, unknown> } };
    delete withoutInp.record.metrics.interaction_to_next_paint;
    answerWith(withoutInp);

    const text = textOf(await run({ url: "https://example.com/", scope: "origin" }));

    expect(text).toContain("cannot be assessed — no reading for INP");
    expect(text).not.toContain("passes");
  });
});

describe("reading the payload", () => {
  it("treats a response with no record as no data", () => {
    expect(readHistory({}, "page", "https://example.com/", "ALL").kind).toBe("no-data");
  });
});
