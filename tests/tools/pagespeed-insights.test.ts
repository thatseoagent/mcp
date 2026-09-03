import { describe, it, expect, afterEach, vi } from "vitest";
import pagespeedInsights from "@/tools/pagespeed-insights";
import { resetAllSingleFlightCaches } from "@/lib/single-flight";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
  resetAllSingleFlightCaches();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

const textOf = (result: Awaited<ReturnType<typeof pagespeedInsights>>): string =>
  result.content.map((part) => part.text).join("\n");

/** The handler's arguments as xmcp hands them over: optional keys present. */
const run = (args: {
  url: string;
  strategy?: "mobile" | "desktop";
  categories?: Array<"performance" | "accessibility" | "best-practices" | "seo">;
}) => pagespeedInsights({ strategy: undefined, categories: undefined, ...args });

/** Answer the PSI endpoint with one payload, and record what was asked. */
function answerWith(payload: unknown, status = 200): void {
  globalThis.fetch = vi.fn(async () =>
    new Response(JSON.stringify(payload), {
      status,
      headers: { "content-type": "application/json" },
    }),
  ) as unknown as typeof fetch;
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

describe("pagespeed_insights without the key configured", () => {
  it("returns an error naming the variable and where to get a value", async () => {
    vi.stubEnv("PAGESPEED_API_KEY", undefined);
    globalThis.fetch = vi.fn(async () => new Response("{}")) as unknown as typeof fetch;

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
    const fetchMock = vi.fn(async () => new Response("{}"));
    globalThis.fetch = fetchMock as unknown as typeof fetch;

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
    answerWith(A_SLOW_SITE);

    const text = textOf(await run({ url: "https://example.com/" }));

    expect(text).toContain("=== FIELD DATA (real user experience, last 28 days) ===");
    expect(text).toContain("Overall category: SLOW");
    expect(text).toContain("LCP (Largest Contentful Paint): 5200ms — SLOW");
    expect(text).toContain("=== LAB DATA (one throttled Lighthouse run) ===");
    expect(text).toContain("Performance: 31/100");
  });

  it("prints CLS as the score everyone quotes, not the CrUX integer", async () => {
    vi.stubEnv("PAGESPEED_API_KEY", "test-key");
    answerWith(A_SLOW_SITE);

    const text = textOf(await run({ url: "https://example.com/" }));

    expect(text).toContain("CLS (Cumulative Layout Shift): 0.180");
    expect(text).not.toContain("Cumulative Layout Shift): 18 ");
  });

  it("leads its advice with field data, which is the half Google ranks on", async () => {
    vi.stubEnv("PAGESPEED_API_KEY", "test-key");
    answerWith(A_SLOW_SITE);

    const text = textOf(await run({ url: "https://example.com/" }));

    expect(text).toContain("Field data says real users are having a SLOW experience");
    expect(text).toContain("28-day trailing window");
  });

  it("calls missing field data an absent reading, not a passing one", async () => {
    vi.stubEnv("PAGESPEED_API_KEY", "test-key");
    answerWith({ lighthouseResult: { categories: { performance: { score: 0.9 } }, audits: {} } });

    const text = textOf(await run({ url: "https://example.com/" }));

    expect(text).toContain("No field data for this URL");
    expect(text).toContain("it is the absence of a");
  });

  it("omits a category the caller did not ask for rather than scoring it zero", async () => {
    vi.stubEnv("PAGESPEED_API_KEY", "test-key");
    answerWith(A_SLOW_SITE);

    const text = textOf(await run({ url: "https://example.com/", categories: ["performance"] }));

    expect(text).toContain("Performance: 31/100");
    expect(text).not.toContain("Accessibility:");
  });

  it("sends the key and the strategy to the API", async () => {
    vi.stubEnv("PAGESPEED_API_KEY", "test-key");
    // Typed by the argument it receives, so the call record is a tuple the
    // assertion below can index into.
    const fetchMock = vi.fn(async (input: string) => {
      void input;
      return new Response(JSON.stringify(A_SLOW_SITE));
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    await run({ url: "https://example.com/", strategy: "desktop" });

    const asked = new URL(fetchMock.mock.calls[0][0]);
    expect(asked.searchParams.get("key")).toBe("test-key");
    expect(asked.searchParams.get("strategy")).toBe("DESKTOP");
    expect(asked.searchParams.get("url")).toBe("https://example.com/");
  });

  it("names the status when the API refuses, and never forwards its body", async () => {
    vi.stubEnv("PAGESPEED_API_KEY", "wrong-key");
    // A real Google error body. Forwarding it verbatim would publish a remote
    // server's text into the model's context under our signature.
    answerWith({ error: { message: "API key not valid. Please pass a valid API key." } }, 400);

    const result = await run({ url: "https://example.com/" });

    expect(result.isError).toBe(true);
    const text = textOf(result);
    expect(text).toContain("PageSpeed Insights API returned HTTP 400");
    expect(text).toContain("the configured key is wrong");
    expect(text).not.toContain("Please pass a valid API key");
  });

  it("explains an exhausted quota as something that resolves on its own", async () => {
    vi.stubEnv("PAGESPEED_API_KEY", "test-key");
    answerWith({}, 429);

    const text = textOf(await run({ url: "https://example.com/" }));

    expect(text).toContain("quota for this key is exhausted");
  });

  it("calls the API once for two identical requests in a turn", async () => {
    vi.stubEnv("PAGESPEED_API_KEY", "test-key");
    const fetchMock = vi.fn(async () => new Response(JSON.stringify(A_SLOW_SITE)));
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    await Promise.all([run({ url: "https://example.com/" }), run({ url: "https://example.com/" })]);

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("shares one call between two spellings of the same request", async () => {
    // Every extra cache key is a duplicate call taking tens of seconds and one
    // more request out of a finite daily quota. Three spellings of one request
    // used to key apart: omitting `categories`, passing all four, and passing
    // the same four in a different order.
    vi.stubEnv("PAGESPEED_API_KEY", "test-key");
    const fetchMock = vi.fn(async () => new Response(JSON.stringify(A_SLOW_SITE)));
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    await run({ url: "https://example.com/" });
    await run({
      url: "https://example.com/",
      categories: ["performance", "accessibility", "best-practices", "seo"],
    });
    await run({
      url: "https://example.com/",
      categories: ["seo", "best-practices", "accessibility", "performance"],
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("still keeps a narrowed request apart from the full one", async () => {
    // The other half of the same rule: asking for performance alone really is a
    // different request, and sharing an entry would hand a caller a result
    // missing the sections they asked for.
    vi.stubEnv("PAGESPEED_API_KEY", "test-key");
    const fetchMock = vi.fn(async () => new Response(JSON.stringify(A_SLOW_SITE)));
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    await run({ url: "https://example.com/" });
    await run({ url: "https://example.com/", categories: ["performance"] });

    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("does not share a result between two strategies", async () => {
    vi.stubEnv("PAGESPEED_API_KEY", "test-key");
    const fetchMock = vi.fn(async () => new Response(JSON.stringify(A_SLOW_SITE)));
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    await run({ url: "https://example.com/", strategy: "mobile" });
    await run({ url: "https://example.com/", strategy: "desktop" });

    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("survives a response with nothing in it", async () => {
    vi.stubEnv("PAGESPEED_API_KEY", "test-key");
    answerWith({});

    const result = await run({ url: "https://example.com/" });

    expect(result.isError).toBeUndefined();
    expect(textOf(result)).toContain("No field data for this URL");
  });
});
