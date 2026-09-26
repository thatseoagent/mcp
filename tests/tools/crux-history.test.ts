import { describe, it, expect, afterEach, vi } from "vitest";
import cruxHistory from "@/tools/crux-history";
import { readHistory } from "@/lib/crux-history";
import { resetAllSingleFlightCaches } from "@/lib/single-flight";
import { requestsOf, serve } from "../helpers/serve";

afterEach(() => {
  vi.unstubAllGlobals();
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
  return serve({
    "chromeuxreport.googleapis.com": {
      status,
      body: JSON.stringify(payload),
      headers: { "content-type": "application/json" },
    },
  });
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

    const [asked] = requestsOf(mock);
    expect(asked?.url).toContain("records:queryHistoryRecord");
    expect(asked?.method).toBe("POST");
    expect(asked?.json).toEqual({
      origin: "https://example.com",
      formFactor: "PHONE",
      // The API's maximum. It was the default, 25, which left half a year of history unread.
      collectionPeriodCount: 40,
    });
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

/** The same origin, with the unrated metrics the History API also serves. */
const WITH_DIAGNOSTICS = structuredClone(AN_IMPROVING_ORIGIN) as { record: { metrics: Record<string, unknown> } };
Object.assign(WITH_DIAGNOSTICS.record.metrics, {
  largest_contentful_paint_image_time_to_first_byte: { percentilesTimeseries: { p75s: [600, 600, 580, 590] } },
  largest_contentful_paint_image_resource_load_delay: { percentilesTimeseries: { p75s: [1400, 1200, 700, 650] } },
  largest_contentful_paint_image_resource_load_duration: { percentilesTimeseries: { p75s: [300, 310, 290, 700] } },
  largest_contentful_paint_image_element_render_delay: { percentilesTimeseries: { p75s: [90, 95, null, 100] } },
  largest_contentful_paint_resource_type: {
    fractionTimeseries: { image: { fractions: [0.7, 0.71, 0.72, 0.72] }, text: { fractions: [0.3, 0.29, 0.28, 0.28] } },
  },
  navigation_types: {
    fractionTimeseries: {
      navigate: { fractions: [0.8, 0.8, 0.78, 0.76] },
      back_forward: { fractions: [0.08, 0.06, 0.04, 0.02] },
      back_forward_cache: { fractions: [0.02, 0.04, 0.06, 0.08] },
      reload: { fractions: [0.1, 0.1, 0.12, "NaN"] },
    },
  },
  round_trip_time: { percentilesTimeseries: { p75s: [150, 148, 152, 149] } },
});

describe("crux_history diagnostics", () => {
  it("describes the latest period without rating any diagnostic", async () => {
    vi.stubEnv("PAGESPEED_API_KEY", "test-key");
    answerWith(WITH_DIAGNOSTICS);

    const text = textOf(await run({ url: "https://example.com/", scope: "origin" }));
    const section = text.slice(text.indexOf("=== FIELD DIAGNOSTICS"), text.indexOf("=== BY PERIOD"));

    expect(section).toContain("no Google threshold, so not rated");
    expect(section).toContain("Resource load duration: 700ms — the largest");
    expect(section).toContain("The largest part is resource load duration");
    expect(section).toContain("LCP element: an image on 72% of visits, text on 28%");
    expect(section).toContain("bfcache share: 80% of back/forward navigations");
    expect(section).toContain("Round trip time (p75): 149ms");
    // Nothing unrated is given a verdict.
    expect(section).not.toMatch(/\((good|poor|needs improvement)\)/);
  });

  it("says how each diagnostic moved across the series", async () => {
    vi.stubEnv("PAGESPEED_API_KEY", "test-key");
    answerWith(WITH_DIAGNOSTICS);

    const text = textOf(await run({ url: "https://example.com/", scope: "origin" }));

    expect(text).toContain("Image LCP resource load delay (p75): 1.4s → 650ms");
    expect(text).toContain("bfcache share of back/forward navigations: 20% → 80%");
    expect(text).toContain("LCP element an image: 70% → 72%");
  });

  it("does not print NaN for a period CrUX marked missing", async () => {
    vi.stubEnv("PAGESPEED_API_KEY", "test-key");
    answerWith(WITH_DIAGNOSTICS);

    const text = textOf(await run({ url: "https://example.com/", scope: "origin" }));

    expect(text).not.toMatch(/NaN|undefined|Infinity|\[object Object\]/);
  });

  it("says so when the response carries no diagnostics", async () => {
    vi.stubEnv("PAGESPEED_API_KEY", "test-key");
    answerWith(AN_IMPROVING_ORIGIN);

    const text = textOf(await run({ url: "https://example.com/", scope: "origin" }));

    expect(text).toContain("CrUX reported no diagnostic metrics for this subject.");
  });
});

describe("reading the payload", () => {
  it("treats a response with no record as no data", () => {
    expect(readHistory({}, "page", "https://example.com/", "ALL").kind).toBe("no-data");
  });
});
