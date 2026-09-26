import { describe, it, expect, afterEach, vi } from "vitest";
import pagespeedInsights from "@/tools/pagespeed-insights";
import { resetAllSingleFlightCaches } from "@/lib/single-flight";
import { serve, type Route } from "../helpers/serve";

afterEach(() => {
  vi.unstubAllGlobals();
  resetAllSingleFlightCaches();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

const textOf = (result: Awaited<ReturnType<typeof pagespeedInsights>>): string =>
  result.content.map((part) => part.text).join("\n");

type Category = "performance" | "accessibility" | "best-practices" | "seo" | "agentic-browsing";

/** The handler's arguments as xmcp hands them over: optional keys present. */
const run = (args: { url: string; strategy?: "mobile" | "desktop"; categories?: Category[] }) =>
  pagespeedInsights({ strategy: undefined, categories: undefined, ...args });

type Answer = [status: number, body: unknown];

/**
 * Answer both endpoints the Tool calls, and record what each was asked.
 *
 * PSI and the CrUX API are separate requests now, so a test says what each one
 * answers; the defaults are a slow page with field data in both.
 */
function route({
  psi = () => [200, A_SLOW_SITE],
  crux = () => [200, A_SLOW_RECORD],
}: {
  psi?: (url: URL) => Answer;
  crux?: (body: Record<string, unknown>) => Answer;
} = {}) {
  const psiCalls: URL[] = [];
  const cruxBodies: Array<Record<string, unknown>> = [];
  const asJson = ([status, body]: Answer): Route => ({
    status,
    body: JSON.stringify(body),
    headers: { "content-type": "application/json" },
  });
  serve({
    "chromeuxreport.googleapis.com": (request) => {
      const body = request.json as Record<string, unknown>;
      cruxBodies.push(body);
      return asJson(crux(body));
    },
    "www.googleapis.com/pagespeedonline": (request) => {
      const url = new URL(request.url);
      psiCalls.push(url);
      return asJson(psi(url));
    },
  });
  return { psiCalls, cruxBodies };
}

const A_SLOW_SITE = {
  loadingExperience: {
    overall_category: "SLOW",
    metrics: {
      LARGEST_CONTENTFUL_PAINT_MS: {
        percentile: 5200,
        category: "SLOW",
        distributions: [{ proportion: 0.31 }, { proportion: 0.24 }, { proportion: 0.45 }],
      },
      INTERACTION_TO_NEXT_PAINT: { percentile: 240, category: "AVERAGE", distributions: [] },
      CUMULATIVE_LAYOUT_SHIFT_SCORE: {
        percentile: 18,
        category: "AVERAGE",
        distributions: [{ proportion: 0.6 }, { proportion: 0.3 }, { proportion: 0.1 }],
      },
    },
  },
  lighthouseResult: {
    categories: {
      performance: { score: 0.31, auditRefs: [{ id: "uses-webp" }, { id: "unused-js" }] },
      seo: { score: 0.92 },
    },
    audits: {
      metrics: {
        details: {
          items: [
            {
              firstContentfulPaint: 2100,
              largestContentfulPaint: 5200,
              totalBlockingTime: 640,
              cumulativeLayoutShift: 0.18,
              speedIndex: 4300,
              interactive: 6100,
            },
          ],
        },
      },
      "uses-webp": {
        id: "uses-webp",
        title: "Serve images in next-gen formats",
        score: 0.2,
        displayValue: "Potential savings of 420 KiB",
        description: "Images can be smaller. [Learn more](https://example.com)",
      },
      "unused-js": { id: "unused-js", title: "Reduce unused JavaScript", score: 0 },
    },
  },
};

/** The CrUX API's record for the same slow page, in `queryRecord`'s shape. */
const A_SLOW_RECORD = {
  record: {
    key: { url: "https://example.com/", formFactor: "PHONE" },
    metrics: {
      largest_contentful_paint: {
        histogram: [
          { start: 0, end: 2500, density: 0.31 },
          { start: 2500, end: 4000, density: 0.24 },
          { start: 4000, density: 0.45 },
        ],
        percentiles: { p75: 5200 },
      },
      interaction_to_next_paint: {
        histogram: [{ start: 0, end: 200, density: 0.7 }, { start: 200, end: 500, density: 0.2 }, { start: 500, density: 0.1 }],
        percentiles: { p75: 240 },
      },
      cumulative_layout_shift: {
        histogram: [{ start: "0.00", end: "0.10", density: 0.6 }, { start: "0.10", end: "0.25", density: 0.3 }, { start: "0.25", density: 0.1 }],
        percentiles: { p75: "0.18" },
      },
      experimental_time_to_first_byte: { histogram: [], percentiles: { p75: 1900 } },
      largest_contentful_paint_image_time_to_first_byte: { percentiles: { p75: 1700 } },
      largest_contentful_paint_image_resource_load_delay: { percentiles: { p75: 2100 } },
      largest_contentful_paint_image_resource_load_duration: { percentiles: { p75: 600 } },
      largest_contentful_paint_image_element_render_delay: { percentiles: { p75: 200 } },
      largest_contentful_paint_resource_type: { fractions: { image: 0.81, text: 0.19 } },
      navigation_types: {
        fractions: { navigate: 0.84, back_forward: 0.06, back_forward_cache: 0.02, reload: 0.08 },
      },
      round_trip_time: { percentiles: { p75: 210 } },
    },
    collectionPeriod: {
      firstDate: { year: 2026, month: 8, day: 24 },
      lastDate: { year: 2026, month: 9, day: 20 },
    },
  },
};

const NOT_FOUND: Answer = [404, { error: { code: 404, message: "chrome ux report data not found" } }];
const NOT_ENABLED: Answer = [
  403,
  { error: { code: 403, message: "Chrome UX Report API has not been used in project 123 before or it is disabled." } },
];

describe("pagespeed_insights without the key configured", () => {
  it("returns an error naming the variable and where to get a value", async () => {
    vi.stubEnv("PAGESPEED_API_KEY", undefined);
    serve({ "googleapis.com": { body: "{}" } });

    const result = await run({ url: "https://example.com/" });

    expect(result.isError).toBe(true);
    const text = textOf(result);
    expect(text).toContain("PAGESPEED_API_KEY");
    expect(text).toContain("https://console.cloud.google.com/apis/credentials");
    expect(text).toContain("PAGESPEED_API_KEY=your_key");
  });

  it("refuses as a Tool result, not as a thrown transport error", async () => {
    // ADR-0003: many MCP clients cannot relay an exception, and an agent that
    // gets a transport failure has nothing to tell the Operator. It has to be
    // text the model can read out.
    vi.stubEnv("PAGESPEED_API_KEY", undefined);

    await expect(run({ url: "https://example.com/" })).resolves.toBeDefined();
  });

  it("never reaches Google before refusing", async () => {
    vi.stubEnv("PAGESPEED_API_KEY", undefined);
    const fetchMock = serve({ "googleapis.com": { body: "{}" } });

    await run({ url: "https://example.com/" });

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("says the rest of the server still works, without claiming how many Tools need this", async () => {
    // The sentence lives in the shared mechanism, so it has to stay true as more
    // Tools adopt it. An earlier draft said "this one Tool alone needs it" — a
    // fact about today's surface baked into a generic class.
    vi.stubEnv("PAGESPEED_API_KEY", undefined);

    expect(textOf(await run({ url: "https://example.com/" }))).toContain(
      "the rest of the server works as usual",
    );
  });

  it("treats a variable set to empty as unset", async () => {
    vi.stubEnv("PAGESPEED_API_KEY", "");

    const result = await run({ url: "https://example.com/" });

    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("PAGESPEED_API_KEY");
  });
});

describe("pagespeed_insights with the key configured", () => {
  it("reports field data and lab data as two separate readings", async () => {
    vi.stubEnv("PAGESPEED_API_KEY", "test-key");
    route();

    const text = textOf(await run({ url: "https://example.com/" }));

    expect(text).toContain("=== FIELD DATA (real Chrome users, 28-day window 2026-08-24 to 2026-09-20) ===");
    expect(text).toContain("Core Web Vitals assessment: does not pass — LCP, INP, CLS not good");
    expect(text).toContain("LCP (Largest Contentful Paint): 5.2s (poor)");
    expect(text).toContain("Poor (> 4.0s): 45.0%");
    expect(text).toContain("=== LAB DATA (one throttled Lighthouse run) ===");
    expect(text).toContain("Performance: 31/100");
  });

  it("takes the field data from the CrUX API and says so", async () => {
    vi.stubEnv("PAGESPEED_API_KEY", "test-key");
    const { cruxBodies } = route();

    const text = textOf(await run({ url: "https://example.com/" }));

    expect(text).toContain("Source: Chrome UX Report API — this page's own record (phone).");
    // PSI's mobile strategy is CrUX's phone form factor, so both halves describe one device class.
    expect(cruxBodies).toEqual([{ url: "https://example.com/", formFactor: "PHONE" }]);
  });

  it("asks CrUX for desktop when the strategy is desktop", async () => {
    vi.stubEnv("PAGESPEED_API_KEY", "test-key");
    const { cruxBodies } = route();

    await run({ url: "https://example.com/", strategy: "desktop" });

    expect(cruxBodies[0]?.formFactor).toBe("DESKTOP");
  });

  it("falls back to the origin's record, and says the figures are not the page's", async () => {
    vi.stubEnv("PAGESPEED_API_KEY", "test-key");
    const origin = structuredClone(A_SLOW_RECORD);
    (origin.record.key as Record<string, unknown>) = { origin: "https://example.com", formFactor: "PHONE" };
    const { cruxBodies } = route({ crux: (body) => (body.url ? NOT_FOUND : [200, origin]) });

    const text = textOf(await run({ url: "https://example.com/quiet" }));

    expect(cruxBodies[1]).toEqual({ origin: "https://example.com", formFactor: "PHONE" });
    expect(text).toContain("Source: Chrome UX Report API — the origin's record (https://example.com, phone).");
    expect(text).toContain("not this page's own figures");
    expect(text).toContain("the pages dragging them down may be other than");
  });

  it("calls missing field data an absent reading, not a passing one", async () => {
    vi.stubEnv("PAGESPEED_API_KEY", "test-key");
    route({
      psi: () => [200, { lighthouseResult: { categories: { performance: { score: 0.9 } }, audits: {} } }],
      crux: () => NOT_FOUND,
    });

    const text = textOf(await run({ url: "https://example.com/" }));

    expect(text).toContain("No field data: the Chrome UX Report has no record for this page or for its origin (phone).");
    expect(text).toContain("it is the absence of a reading");
    expect(text).not.toContain("passes");
  });

  it("uses PSI's copy when the CrUX API is not enabled for the key, and says which source it was", async () => {
    vi.stubEnv("PAGESPEED_API_KEY", "test-key");
    route({ crux: () => NOT_ENABLED });

    const result = await run({ url: "https://example.com/" });
    const text = textOf(result);

    expect(result.isError).toBeUndefined();
    expect(text).toContain("Source: PageSpeed Insights' copy of the Chrome UX Report.");
    expect(text).toContain("refused this key (HTTP 403)");
    expect(text).toContain("same CrUX dataset");
    expect(text).toContain("will stop including it");
    expect(text).toContain("chromeuxreport.googleapis.com");
    // PSI's ×100 CLS integer is divided back, so both sources print the same score.
    expect(text).toContain("CLS (Cumulative Layout Shift): 0.180 (needs improvement)");
    expect(text).toContain("LCP (Largest Contentful Paint): 5.2s (poor)");
  });

  it("says PSI's copy was the origin's when PSI flagged it as a fallback", async () => {
    vi.stubEnv("PAGESPEED_API_KEY", "test-key");
    const psiOrigin = structuredClone(A_SLOW_SITE);
    (psiOrigin.loadingExperience as Record<string, unknown>).origin_fallback = true;
    route({ psi: () => [200, psiOrigin], crux: () => NOT_ENABLED });

    const text = textOf(await run({ url: "https://example.com/" }));

    expect(text).toContain("PSI had no record for this page alone and gave the origin's");
  });

  it("says there is no field data when the CrUX API refuses and PSI has none", async () => {
    vi.stubEnv("PAGESPEED_API_KEY", "test-key");
    const { loadingExperience: _, ...labOnly } = A_SLOW_SITE;
    route({ psi: () => [200, labOnly], crux: () => NOT_ENABLED });

    const text = textOf(await run({ url: "https://example.com/" }));

    expect(text).toContain("No field data. The Chrome UX Report API");
    expect(text).toContain("refused");
    expect(text).toContain("Enable the Chrome UX Report API");
    expect(text).toContain("Performance: 31/100");
  });

  it("fails rather than falling back when the CrUX API fails for another reason", async () => {
    // A 429 is this moment, not the configuration: its retry advice is true, and
    // answering from PSI would hide a failure the Operator should see.
    vi.stubEnv("PAGESPEED_API_KEY", "test-key");
    route({ crux: () => [429, {}] });

    const result = await run({ url: "https://example.com/" });

    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("Chrome UX Report API returned HTTP 429");
  });

  it("describes the unrated CrUX diagnostics without rating them", async () => {
    vi.stubEnv("PAGESPEED_API_KEY", "test-key");
    route();

    const text = textOf(await run({ url: "https://example.com/" }));

    expect(text).toContain("TTFB (Time to First Byte): 1.9s (poor)");
    expect(text).toContain("LCP element: an image on 81% of visits, text on 19%.");
    expect(text).toContain("Resource load delay: 2.1s — the largest");
    expect(text).toContain("bfcache share: 25% of back/forward navigations");
    expect(text).toContain("Round trip time (p75): 210ms");
  });

  it("prints CLS as the score everyone quotes, not the CrUX integer", async () => {
    vi.stubEnv("PAGESPEED_API_KEY", "test-key");
    route();

    const text = textOf(await run({ url: "https://example.com/" }));

    expect(text).toContain("CLS (Cumulative Layout Shift): 0.180");
    expect(text).not.toContain("Cumulative Layout Shift): 18 ");
  });

  it("leads its advice with field data, which is the half Google ranks on", async () => {
    vi.stubEnv("PAGESPEED_API_KEY", "test-key");
    route();

    const text = textOf(await run({ url: "https://example.com/" }));

    expect(text).toContain("Field data says real users are not getting a good experience");
    expect(text).toContain("28-day trailing window");
  });

  it("omits a category the caller did not ask for rather than scoring it zero", async () => {
    vi.stubEnv("PAGESPEED_API_KEY", "test-key");
    route();

    const text = textOf(await run({ url: "https://example.com/", categories: ["performance"] }));

    expect(text).toContain("Performance: 31/100");
    expect(text).not.toContain("Accessibility:");
  });

  it("sends the key and the strategy to the API", async () => {
    vi.stubEnv("PAGESPEED_API_KEY", "test-key");
    const { psiCalls } = route();

    await run({ url: "https://example.com/", strategy: "desktop" });

    const asked = psiCalls[0] as URL;
    expect(asked.searchParams.get("key")).toBe("test-key");
    expect(asked.searchParams.get("strategy")).toBe("DESKTOP");
    expect(asked.searchParams.get("url")).toBe("https://example.com/");
  });

  it("names the status when the API refuses, and never forwards its body", async () => {
    vi.stubEnv("PAGESPEED_API_KEY", "wrong-key");
    // A real Google error body. Forwarding it verbatim would publish a remote
    // server's text into the model's context under our signature.
    route({ psi: () => [400, { error: { message: "API key not valid. Please pass a valid API key." } }] });

    const result = await run({ url: "https://example.com/" });

    expect(result.isError).toBe(true);
    const text = textOf(result);
    expect(text).toContain("PageSpeed Insights API returned HTTP 400");
    expect(text).toContain("the configured key is wrong");
    expect(text).not.toContain("Please pass a valid API key");
  });

  it("explains an exhausted quota as something that resolves on its own", async () => {
    vi.stubEnv("PAGESPEED_API_KEY", "test-key");
    route({ psi: () => [429, {}] });

    const text = textOf(await run({ url: "https://example.com/" }));

    expect(text).toContain("quota for this key is exhausted");
  });

  it("calls the API once for two identical requests in a turn", async () => {
    vi.stubEnv("PAGESPEED_API_KEY", "test-key");
    const { psiCalls, cruxBodies } = route();

    await Promise.all([run({ url: "https://example.com/" }), run({ url: "https://example.com/" })]);

    expect(psiCalls).toHaveLength(1);
    expect(cruxBodies).toHaveLength(1);
  });

  it("shares one call between two spellings of the same request", async () => {
    // Every extra cache key is a duplicate call taking tens of seconds and one
    // more request out of a finite daily quota. Three spellings of one request
    // used to key apart: omitting `categories`, passing all four, and passing
    // the same four in a different order.
    vi.stubEnv("PAGESPEED_API_KEY", "test-key");
    const { psiCalls } = route();

    await run({ url: "https://example.com/" });
    await run({
      url: "https://example.com/",
      categories: ["performance", "accessibility", "best-practices", "seo"],
    });
    await run({
      url: "https://example.com/",
      categories: ["seo", "best-practices", "accessibility", "performance"],
    });

    expect(psiCalls).toHaveLength(1);
  });

  it("still keeps a narrowed request apart from the full one", async () => {
    // The other half of the same rule: asking for performance alone really is a
    // different request, and sharing an entry would hand a caller a result
    // missing the sections they asked for.
    vi.stubEnv("PAGESPEED_API_KEY", "test-key");
    const { psiCalls } = route();

    await run({ url: "https://example.com/" });
    await run({ url: "https://example.com/", categories: ["performance"] });

    expect(psiCalls).toHaveLength(2);
  });

  it("does not share a result between two strategies", async () => {
    vi.stubEnv("PAGESPEED_API_KEY", "test-key");
    const { psiCalls } = route();

    await run({ url: "https://example.com/", strategy: "mobile" });
    await run({ url: "https://example.com/", strategy: "desktop" });

    expect(psiCalls).toHaveLength(2);
  });

  it("survives a response with nothing in it", async () => {
    vi.stubEnv("PAGESPEED_API_KEY", "test-key");
    route({ psi: () => [200, {}], crux: () => [200, {}] });

    const result = await run({ url: "https://example.com/" });

    expect(result.isError).toBeUndefined();
    const text = textOf(result);
    expect(text).toContain("No field data");
    expect(text).toContain("Not checked: this response carried no entity attribution");
    expect(text).not.toMatch(/NaN|undefined|Infinity|\[object Object\]/);
  });
});

/** Lighthouse's entity attribution, and the Lighthouse 13 audit that costs it. */
const WITH_THIRD_PARTIES = {
  ...A_SLOW_SITE,
  lighthouseResult: {
    ...A_SLOW_SITE.lighthouseResult,
    entities: [
      { name: "example.com", isFirstParty: true, origins: ["https://example.com", "https://cdn.example.com"] },
      { name: "Google Tag Manager", category: "tag-manager", origins: ["https://www.googletagmanager.com"] },
      { name: "Intercom", category: "customer-success", origins: ["https://widget.intercom.io", "https://js.intercomcdn.com"] },
      { name: "unknown-pixel.net", isUnrecognized: true, origins: ["https://t.unknown-pixel.net"] },
    ],
    audits: {
      ...A_SLOW_SITE.lighthouseResult.audits,
      "third-parties-insight": {
        id: "third-parties-insight",
        title: "3rd parties",
        details: {
          type: "table",
          items: [
            { entity: "Intercom", transferSize: 412_000, mainThreadTime: 380 },
            { entity: "Google Tag Manager", transferSize: 98_000, mainThreadTime: 120 },
          ],
        },
      },
    },
  },
};

describe("pagespeed_insights third parties", () => {
  it("reports vendors by origin count and transfer, first party excluded", async () => {
    vi.stubEnv("PAGESPEED_API_KEY", "test-key");
    route({ psi: () => [200, WITH_THIRD_PARTIES] });

    const text = textOf(await run({ url: "https://example.com/" }));
    const section = text.slice(text.indexOf("=== THIRD PARTIES"), text.indexOf("=== RECOMMENDATIONS"));

    expect(section).toContain("First party: example.com");
    expect(section).toContain("3 third-party vendor(s) across 4 origin(s), largest transfer first:");
    expect(section).toContain("- Intercom (customer-success) — 2 origin(s), 402 KiB, 380ms main thread");
    expect(section).toContain("- Google Tag Manager (tag-manager) — 1 origin(s), 96 KiB, 120ms main thread");
    // Unlisted by the audit: its size is unknown, not zero.
    expect(section).toContain("- unknown-pixel.net — 1 origin(s)\n");
    expect(section.indexOf("Intercom")).toBeLessThan(section.indexOf("Google Tag Manager"));
    expect(section).toContain("may not appear");
  });

  it("says sizes were not checked when the audit is missing", async () => {
    vi.stubEnv("PAGESPEED_API_KEY", "test-key");
    const noAudit = structuredClone(WITH_THIRD_PARTIES);
    delete (noAudit.lighthouseResult.audits as Record<string, unknown>)["third-parties-insight"];
    route({ psi: () => [200, noAudit] });

    const text = textOf(await run({ url: "https://example.com/" }));

    expect(text).toContain("Transfer size and main-thread time: not checked");
  });
});

describe("pagespeed_insights agentic-browsing", () => {
  it("is not asked for unless the caller opts in", async () => {
    vi.stubEnv("PAGESPEED_API_KEY", "test-key");
    const { psiCalls } = route();

    const text = textOf(await run({ url: "https://example.com/" }));

    expect(psiCalls[0]?.searchParams.getAll("category")).not.toContain("AGENTIC_BROWSING");
    expect(text).not.toContain("AGENTIC BROWSING");
  });

  it("reports the category when PSI runs it", async () => {
    vi.stubEnv("PAGESPEED_API_KEY", "test-key");
    const withAgentic = structuredClone(A_SLOW_SITE) as typeof A_SLOW_SITE & {
      lighthouseResult: { categories: Record<string, unknown>; audits: Record<string, unknown> };
    };
    withAgentic.lighthouseResult.categories["agentic-browsing"] = { score: 0.58, auditRefs: [{ id: "llms-txt" }] };
    withAgentic.lighthouseResult.audits["llms-txt"] = { id: "llms-txt", title: "Site has no llms.txt", score: 0 };
    const { psiCalls } = route({ psi: () => [200, withAgentic] });

    const text = textOf(await run({ url: "https://example.com/", categories: ["performance", "agentic-browsing"] }));

    expect(psiCalls[0]?.searchParams.getAll("category")).toEqual(["PERFORMANCE", "AGENTIC_BROWSING"]);
    expect(text).toContain("=== AGENTIC BROWSING (Lighthouse 13.3, opt-in) ===");
    expect(text).toContain("Score: 58/100");
    expect(text).toContain("- Site has no llms.txt");
  });

  it("says PSI refused the category and still runs the rest", async () => {
    vi.stubEnv("PAGESPEED_API_KEY", "test-key");
    const { psiCalls } = route({
      psi: (url) =>
        url.searchParams.getAll("category").includes("AGENTIC_BROWSING")
          ? [400, { error: { message: "Invalid value at 'category'" } }]
          : [200, A_SLOW_SITE],
    });

    const result = await run({ url: "https://example.com/", categories: ["performance", "seo", "agentic-browsing"] });
    const text = textOf(result);

    expect(result.isError).toBeUndefined();
    expect(psiCalls).toHaveLength(2);
    expect(psiCalls[1]?.searchParams.getAll("category")).toEqual(["PERFORMANCE", "SEO"]);
    expect(text).toContain("PageSpeed Insights refused the agentic-browsing category (HTTP 400)");
    expect(text).toContain("so it was not checked");
    expect(text).toContain("Performance: 31/100");
    expect(text).not.toContain("Invalid value");
  });

  it("says so when PSI accepts the request but leaves the category out", async () => {
    vi.stubEnv("PAGESPEED_API_KEY", "test-key");
    route();

    const text = textOf(await run({ url: "https://example.com/", categories: ["agentic-browsing"] }));

    expect(text).toContain("returned no agentic-browsing category");
  });

  it("still fails when the retry without the category is refused too", async () => {
    vi.stubEnv("PAGESPEED_API_KEY", "test-key");
    route({ psi: () => [400, {}] });

    const result = await run({ url: "https://example.com/", categories: ["agentic-browsing"] });

    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("PageSpeed Insights API returned HTTP 400");
  });
});
