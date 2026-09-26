import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import brandPageviews from "@/tools/brand-pageviews";
import { readItems, readSummary } from "@/lib/wikimedia-pageviews";
import { requestsOf, serve } from "../helpers/serve";

/**
 * `brand_pageviews` against a payload captured from Wikimedia's Analytics API on
 * 2026-09-24: 24 months of human views of en.wikipedia.org's "Semrush" article,
 * 2024-09 to 2026-08. The clock is pinned to the day it was captured, so the
 * window the Tool asks for is the window the payload answers.
 */
const MONTHLY = readFileSync(path.resolve(__dirname, "fixtures", "wikimedia-pageviews-monthly.json"), "utf8");

/** The summary endpoint's answer for an ordinary article, trimmed to what is read. */
const summaryOf = (canonical: string, extra: Record<string, unknown> = {}) =>
  JSON.stringify({
    type: "standard",
    title: canonical.replace(/_/g, " "),
    titles: { canonical, normalized: canonical.replace(/_/g, " ") },
    description: "American search engine metrics company",
    content_urls: { desktop: { page: `https://en.wikipedia.org/wiki/${canonical}` } },
    ...extra,
  });

/** Wikipedia's summary lookup, on any edition. */
const SUMMARY = "/api/rest_v1/page/summary/";
/** Wikimedia's per-article pageviews. */
const PAGEVIEWS = "wikimedia.org/api/rest_v1/metrics/pageviews/per-article/";

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-09-24T12:00:00Z"));
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const textOf = (result: Awaited<ReturnType<typeof brandPageviews>>): string =>
  result.content.map((part) => part.text).join("\n");

const run = (args: {
  brand?: string;
  article?: string;
  language?: string;
  months?: number;
  granularity?: "monthly" | "daily";
}) =>
  brandPageviews({
    brand: undefined,
    article: undefined,
    language: undefined,
    months: undefined,
    granularity: undefined,
    ...args,
  });

function expectNoJunk(text: string): void {
  expect(text).not.toMatch(/NaN|undefined|Infinity|\[object Object\]/);
}

describe("brand_pageviews for a brand with an article", () => {
  const answerSemrush = () =>
    serve({
      [SUMMARY]: (request) =>
        new URL(request.url).pathname.endsWith("/Semrush") ? { body: summaryOf("Semrush") } : { status: 404 },
      [PAGEVIEWS]: { body: MONTHLY },
    });

  it("asks for human views of the canonical title, ending at the last complete month", async () => {
    const mock = answerSemrush();

    await run({ brand: "Semrush" });

    const asked = mock.mock.calls.map((call) => new URL(String(call[0])));
    expect(asked.map((u) => u.hostname)).toEqual(["en.wikipedia.org", "wikimedia.org"]);
    expect(asked[1]?.pathname).toBe(
      "/api/rest_v1/metrics/pageviews/per-article/en.wikipedia.org/all-access/user/Semrush/monthly/2024090100/2026083100",
    );
    // Wikimedia rate-limits clients that do not identify themselves.
    expect(requestsOf(mock)[1]?.headers["user-agent"]).toMatch(/ThatSEOAgentBot.*https:\/\//);
  });

  it("reports the window, the trend, the peaks and year over year", async () => {
    answerSemrush();

    const text = textOf(await run({ brand: "Semrush" }));

    expect(text).toContain("Article: Semrush (en.wikipedia.org) — https://en.wikipedia.org/wiki/Semrush");
    expect(text).toContain("Window: 2025-09 … 2026-08 (12 complete months");
    expect(text).toContain("Total views: 90,223; average 7,519 a month");
    expect(text).toContain("Trend: -16% (down)");
    expect(text).toContain("2025-11: 12,142 — 1.7× the median month");
    expect(text).toContain("2026-08 against 2025-08: 4,683 vs 7,162, -35% (down)");
    expect(text).toContain("Last 12 months against the 12 before: 90,223 vs 116,411, -22% (down)");
    expect(text).toContain("2026-08  4,683");
    expectNoJunk(text);
  });

  it("frames the series as a proxy, before any number", async () => {
    answerSemrush();

    const text = textOf(await run({ brand: "Semrush" }));

    const caveat = text.indexOf("proxy for interest in the brand, not a measure of");
    expect(caveat).toBeGreaterThan(-1);
    expect(caveat).toBeLessThan(text.indexOf("Total views"));
    expect(text).toContain("Google Trends");
  });

  it("follows a redirect to the article it lands on", async () => {
    const mock = serve({
      [SUMMARY]: { body: summaryOf("Search_engine_optimization") },
      [PAGEVIEWS]: { body: MONTHLY },
    });

    await run({ article: "SEO" });

    const pageviews = mock.mock.calls.map((call) => String(call[0])).find((u) => u.includes("per-article"));
    expect(pageviews).toContain("/user/Search_engine_optimization/monthly/");
  });

  it("does not compare a year that is missing months", async () => {
    const partial = { items: (JSON.parse(MONTHLY) as { items: Array<{ timestamp: string }> }).items.slice(-14) };
    serve({ [SUMMARY]: { body: summaryOf("Semrush") }, [PAGEVIEWS]: { body: JSON.stringify(partial) } });

    const text = textOf(await run({ brand: "Semrush" }));

    expect(text).toContain("Last 12 months against the 12 before: not available");
    expect(text).toContain("2026-08 against 2025-08: 4,683 vs 7,162");
    expectNoJunk(text);
  });

  it("leaves a month with no figure out, rather than counting it as zero", async () => {
    const items = (JSON.parse(MONTHLY) as { items: Array<{ timestamp: string }> }).items.filter(
      (item) => item.timestamp !== "2026010100",
    );
    serve({ [SUMMARY]: { body: summaryOf("Semrush") }, [PAGEVIEWS]: { body: JSON.stringify({ items }) } });

    const text = textOf(await run({ brand: "Semrush" }));

    expect(text).toContain("1 month(s) in the window came back with no figure (2026-01)");
    expect(text).toContain("2026-01  —");
    expect(text).toContain("average 7,439 a month");
  });

  it("dates a spike day by day when asked for daily figures", async () => {
    const days = Array.from({ length: 30 }, (_, i) => ({
      timestamp: `202609${String(i + 1).padStart(2, "0")}00`,
      views: i === 9 ? 5_000 : 200,
    })).slice(0, 23);
    const mock = serve({
      [SUMMARY]: { body: summaryOf("Semrush") },
      [PAGEVIEWS]: { body: JSON.stringify({ items: days }) },
    });

    const text = textOf(await run({ brand: "Semrush", granularity: "daily", months: 1 }));

    const asked = mock.mock.calls.map((call) => String(call[0])).find((u) => u.includes("per-article"));
    expect(asked).toContain("/daily/2026082400/2026092300");
    expect(text).toContain("2026-09-10: 5,000 — 25.0× the median day");
    expect(text).toContain("usually news or an event");
    expectNoJunk(text);
  });
});

describe("brand_pageviews without an article to count", () => {
  it("answers that there is no article, having looked in the page's language and in English", async () => {
    const mock = serve({});

    const result = await run({ brand: "Acme Widgets", language: "es" });

    expect(result.isError).toBeUndefined();
    expect(textOf(result)).toContain('No Wikipedia article is titled "Acme Widgets"');
    expect(textOf(result)).toContain("searched es.wikipedia.org and en.wikipedia.org");
    expect(mock.mock.calls.map((call) => new URL(String(call[0])).hostname)).toEqual([
      "es.wikipedia.org",
      "en.wikipedia.org",
    ]);
  });

  it("refuses to count a disambiguation page as one brand's readers", async () => {
    const mock = serve({ [SUMMARY]: { body: summaryOf("Mercury", { type: "disambiguation" }) } });

    const result = await run({ brand: "Mercury" });

    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("is a disambiguation page");
    expect(textOf(result)).toContain("Pass the brand's own article title as article");
    expect(mock.mock.calls.some((call) => String(call[0]).includes("per-article"))).toBe(false);
  });

  it("answers when the article exists and nobody read it in the window", async () => {
    serve({
      [SUMMARY]: { body: summaryOf("Tiny_Co") },
      [PAGEVIEWS]: { status: 404, body: '{"title":"Not Found"}' },
    });

    const result = await run({ article: "Tiny Co" });

    expect(result.isError).toBeUndefined();
    expect(textOf(result)).toContain("recorded no human views of this article in the window");
  });

  it("asks for a brand or an article", async () => {
    const result = await run({});

    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("Give brand");
  });
});

describe("brand_pageviews when Wikimedia does not answer", () => {
  it("reports a rate limit by status, without the body, and never as no article", async () => {
    serve({
      [SUMMARY]: { body: summaryOf("Semrush") },
      [PAGEVIEWS]: { status: 429, body: "Too many requests from your IP, see policy" },
    });

    const result = await run({ brand: "Semrush" });

    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("Analytics API returned HTTP 429");
    expect(textOf(result)).not.toContain("your IP");
  });

  it("does not read a failed lookup as a missing article", async () => {
    serve({ [SUMMARY]: { status: 503, body: "upstream" } });

    const result = await run({ brand: "Semrush" });

    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("Wikipedia's REST API returned HTTP 503");
    expect(textOf(result)).not.toContain("No Wikipedia article");
  });
});

describe("reading the payloads", () => {
  it("drops a row it cannot read rather than zeroing it", () => {
    const points = readItems(
      { items: [{ timestamp: "2026010100", views: "12" }, { timestamp: "2026020100", views: 5 }, {}] },
      "monthly",
    );
    expect(points).toEqual([{ period: "2026-02", views: 5 }]);
  });

  it("reads a summary with no canonical title as no article", () => {
    const page = { kind: "page", title: "Acme", canonical: null, type: "standard", url: null, description: null } as const;
    expect(readSummary(page, "en").kind).toBe("none");
  });
});
