import { describe, it, expect, afterEach, vi } from "vitest";
import {
  busiest,
  inspectPages,
  readPages,
  sampleNote,
  sampleSize,
  type Inspected,
} from "@/lib/google/busiest-pages";
import { fakeGoogleReader } from "@/lib/google/fake-reader";
import { summarise } from "@/lib/google/inspection-report";
import type { SearchAnalyticsRow, UrlInspection } from "@/lib/google/reader";
import { UpstreamApiError } from "@/lib/upstream-api-error";
import { MissingConfigError } from "@/lib/required-config";
import { CrawlBudgetError, MAX_REQUESTS_PER_ORIGIN, MIN_REQUEST_GAP_MS, paceRequestTo } from "@/lib/crawl-pacing";
import { restoreFetch, serve } from "../../helpers/serve";
import { html, row } from "../../helpers/site-tools";

afterEach(() => {
  restoreFetch();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

const PROPERTY = "sc-domain:example.com";

const verdict = (url: string): UrlInspection => ({
  inspectionResult: { indexStatusResult: { verdict: "PASS", coverageState: `indexed ${url}` } },
});

/** A reader whose inspections are decided per URL, recording every one Google was asked for. */
function inspecting(answer: (url: string) => UrlInspection | Error) {
  const asked: string[] = [];
  const reader = fakeGoogleReader({
    searchConsole: {
      inspectUrl: async (_property: string, url: string) => {
        asked.push(url);
        const result = answer(url);
        if (result instanceof Error) throw result;
        return result;
      },
    },
  }).searchConsole;
  return { reader, asked };
}

/** Swallow stderr, and hand back what was written to it. */
function stderr(): () => string {
  const spy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
  return () => spy.mock.calls.map(([chunk]) => String(chunk)).join("");
}

describe("busiest", () => {
  const ROWS: SearchAnalyticsRow[] = [
    row(["https://example.com/a"], 10, 1000),
    row(["https://example.com/b"], 50, 500),
    row(["https://example.com/c"], 0, 2000),
    row(["https://example.com/d"], 5, 0),
  ];

  it("ranks by the metric asked for, and drops a page with none of it", () => {
    const byClicks = busiest({ rows: ROWS }, { by: "clicks", max: 10, default: 10 });
    expect(byClicks.pages.map((page) => page.url)).toEqual([
      "https://example.com/b",
      "https://example.com/a",
      "https://example.com/d",
    ]);
    expect(byClicks).toMatchObject({ reported: 4, eligible: 3, by: "clicks" });

    const byImpressions = busiest({ rows: ROWS }, { by: "impressions", max: 10, default: 10 });
    expect(byImpressions.pages.map((page) => page.url)).toEqual([
      "https://example.com/c",
      "https://example.com/a",
      "https://example.com/b",
    ]);
    expect(byImpressions).toMatchObject({ reported: 4, eligible: 3 });
  });

  it("breaks a tie on the other metric", () => {
    const tied = [row(["https://example.com/x"], 5, 100), row(["https://example.com/y"], 5, 900)];
    const chosen = busiest({ rows: tied }, { by: "clicks", max: 10, default: 10 });
    expect(chosen.pages.map((page) => page.url)).toEqual(["https://example.com/y", "https://example.com/x"]);
  });

  it("drops a row without a key rather than ranking it as a page", () => {
    const rows: SearchAnalyticsRow[] = [
      { clicks: 900, impressions: 9000, ctr: 0.1, position: 1 },
      { keys: [], clicks: 800, impressions: 8000, ctr: 0.1, position: 1 },
      { keys: [""], clicks: 700, impressions: 7000, ctr: 0.1, position: 1 },
      row(["https://example.com/a"], 1, 10),
    ];
    const chosen = busiest({ rows }, { by: "clicks", max: 10, default: 10 });
    expect(chosen.pages.map((page) => page.url)).toEqual(["https://example.com/a"]);
    expect(chosen.reported).toBe(1);
  });

  it("rolls a finer read up by page, recomputing CTR and position rather than averaging them", () => {
    const rows = [
      row(["https://example.com/a", "one"], 9, 100, 2),
      row(["https://example.com/a", "two"], 1, 900, 10),
      row(["https://example.com/b", "three"], 5, 50, 1),
    ];
    const [a, b] = busiest({ rows }, { by: "clicks", max: 10, default: 10 }).pages;

    expect(a).toMatchObject({ url: "https://example.com/a", clicks: 10, impressions: 1000, ctr: 0.01 });
    expect(a.position).toBeCloseTo(9.2);
    expect(a.rows).toHaveLength(2);
    expect(b.url).toBe("https://example.com/b");
  });

  it("clamps the count once, to between one and the maximum", () => {
    const many = Array.from({ length: 30 }, (_, i) => row([`https://example.com/${i}`], 30 - i, 100));
    const take = (count?: number) =>
      busiest({ rows: many }, { by: "clicks", count, max: 20, default: 10 }).pages.length;

    expect(take()).toBe(10);
    expect(take(99)).toBe(20);
    expect(take(0)).toBe(1);
    expect(take(-4)).toBe(1);
    expect(take(3.9)).toBe(3);
    expect(sampleSize({ count: undefined, max: 50, default: 20 })).toBe(20);
  });

  it("answers an empty read with no pages rather than failing", () => {
    expect(busiest({ rows: [] }, { by: "impressions", max: 20, default: 20 })).toEqual({
      pages: [],
      reported: 0,
      eligible: 0,
      by: "impressions",
    });
  });
});

describe("inspectPages", () => {
  const URLS = ["https://example.com/a", "https://example.com/b", "https://example.com/c"];

  it("answers each URL in the order given, inspecting a repeated one once", async () => {
    const { reader, asked } = inspecting(verdict);
    const inspected = await inspectPages(reader, PROPERTY, [...URLS, URLS[0]]);

    expect(inspected.map((entry) => entry.url)).toEqual([...URLS, URLS[0]]);
    expect(inspected.every((entry) => entry.ok)).toBe(true);
    expect(inspected[1].ok && inspected[1].summary.index.coverageState).toBe("indexed https://example.com/b");
    expect(asked.sort()).toEqual([...URLS].sort());
  });

  it.each([401, 403, 429])(
    "rejects on a %i once the batch settles, so a re-run spends only what failed",
    async (status) => {
      let refusing = true;
      const { reader, asked } = inspecting((url) =>
        url.endsWith("/b") && refusing ? new UpstreamApiError("Google Search Console", status) : verdict(url),
      );

      await expect(inspectPages(reader, PROPERTY, URLS)).rejects.toMatchObject({ status });
      // The whole batch was asked before the refusal was thrown.
      expect(asked.sort()).toEqual([...URLS].sort());

      refusing = false;
      asked.length = 0;
      const inspected = await inspectPages(reader, PROPERTY, URLS);

      expect(inspected.every((entry) => entry.ok)).toBe(true);
      // The two that succeeded were cached; only the refused one is spent again.
      expect(asked).toEqual(["https://example.com/b"]);
    },
  );

  it("does not start a later batch once one has been refused", async () => {
    const urls = Array.from({ length: 8 }, (_, i) => `https://example.com/${i}`);
    const { reader, asked } = inspecting((url) =>
      url.endsWith("/2") ? new UpstreamApiError("Google Search Console", 429) : verdict(url),
    );

    await expect(inspectPages(reader, PROPERTY, urls)).rejects.toBeInstanceOf(UpstreamApiError);
    expect(asked).toHaveLength(5);
  });

  it("rejects when the login is missing, which is the whole answer rather than one URL's", async () => {
    const login = { variable: "GOOGLE_LOGIN", purpose: "read Search Console", howToGet: "Run pnpm login." };
    const { reader } = inspecting(() => new MissingConfigError(login));
    await expect(inspectPages(reader, PROPERTY, URLS)).rejects.toBeInstanceOf(MissingConfigError);
  });

  it("records a failure about one URL against that URL, logs its cause, and answers the rest", async () => {
    const logged = stderr();
    const { reader } = inspecting((url) => {
      if (url.endsWith("/b")) return new UpstreamApiError("Google Search Console", 500);
      if (url.endsWith("/c")) return new TypeError("fetch failed: socket hang up at 10.0.0.1");
      return verdict(url);
    });

    const [a, b, c] = await inspectPages(reader, PROPERTY, URLS);

    expect(a.ok).toBe(true);
    expect(b).toEqual({
      url: "https://example.com/b",
      ok: false,
      reason: expect.stringContaining("Google Search Console returned HTTP 500."),
    });
    // A driver's string never reaches the reason; it goes to stderr instead.
    expect(c).toEqual({
      url: "https://example.com/c",
      ok: false,
      reason: "URL Inspection did not complete for this URL; the cause is in the server log.",
    });
    expect(logged()).toContain("inspect https://example.com/b");
    expect(logged()).toContain("socket hang up");
  });
});

describe("readPages", () => {
  const SITE = {
    "/robots.txt": { body: "User-agent: *\nDisallow: /private" },
    "https://example.com/a": html("<h1>A</h1>", "<title>A</title>"),
    "https://example.com/linked": {
      ...html("<h1>L</h1>"),
      headers: { "content-type": "text/html; charset=utf-8", link: '<https://example.com/de/>; rel="alternate"' },
    },
    "https://example.com/private": html("<h1>Private</h1>"),
    "https://example.com/gone": { status: 404 },
  };

  it("reads each page in the order given, keeping its headers for an analyzer that needs one", async () => {
    serve(SITE);
    const [a, linked] = await readPages(["https://example.com/a", "https://example.com/linked"]);

    expect(a.ok && a.page.$("title").text()).toBe("A");
    expect(linked.ok && linked.headers.link).toContain("rel=\"alternate\"");
  });

  it("says a page robots.txt closes to us was not checked, in the one shared sentence", async () => {
    const mock = serve(SITE);
    const [read] = await readPages(["https://example.com/private"]);

    expect(read).toEqual({
      ok: false,
      url: "https://example.com/private",
      reason: "robots.txt disallows this URL for our crawler, so it was not fetched",
    });
    expect(mock.mock.calls.map(([input]) => String(input))).not.toContain("https://example.com/private");
  });

  it("says why an unreachable page was not checked", async () => {
    serve(SITE);
    const [read] = await readPages(["https://example.com/gone"]);

    expect(read.ok).toBe(false);
    expect(!read.ok && read.reason).toContain("The URL returned HTTP 404");
  });

  it("lets our own pacing refusal through, because it is the whole answer", async () => {
    serve(SITE);
    // Pinned to a window boundary, as `crawl-pacing.test.ts` explains, so the
    // spent budget and the read fall in the same window.
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const spend = (async () => {
      for (let i = 0; i < MAX_REQUESTS_PER_ORIGIN; i++) await paceRequestTo(`https://example.com/${i}`);
    })();
    await vi.advanceTimersByTimeAsync(MAX_REQUESTS_PER_ORIGIN * MIN_REQUEST_GAP_MS);
    await spend;

    await expect(readPages(["https://example.com/a"])).rejects.toBeInstanceOf(CrawlBudgetError);
  });
});

describe("sampleNote", () => {
  const ok = (url: string): Inspected => ({ url, ok: true, inspection: verdict(url), summary: summarise(verdict(url)) });

  it("says how many were chosen, of how many, and by what", () => {
    const note = sampleNote({ reported: 40, chosen: 10, by: "clicks" });

    expect(note).toEqual({
      read: ["Sample: 10 of the 40 page(s) Search Console reported for this window, chosen by clicks."],
      notChecked: [],
    });
  });

  it("with inspections, says why the rest were not inspected and what the sample cost", () => {
    const note = sampleNote({ reported: 40, chosen: 2, by: "impressions", inspected: [ok("a"), ok("b")] });
    const text = note.read.join("\n");

    expect(text).toContain("The rest were not inspected. Google rations URL Inspection per property per day");
    expect(text).toContain("URL Inspection: 2 URL(s) inspected for this report, which spends at most 2 of the 2,000");
    expect(note.notChecked).toEqual([]);
  });

  it("hands every inspection that did not complete to NOT CHECKED, with its reason", () => {
    const note = sampleNote({
      reported: 2,
      chosen: 2,
      by: "impressions",
      inspected: [ok("https://example.com/a"), { url: "https://example.com/b", ok: false, reason: "Google said no." }],
    });

    expect(note.read.join("\n")).not.toContain("The rest were not inspected");
    expect(note.notChecked).toEqual([{ subject: "https://example.com/b", reason: "Google said no." }]);
  });

  it("names a candidate set that is not Search Console's pages", () => {
    const [first] = sampleNote({ reported: 12, chosen: 5, by: "impressions", of: "sitemap URL(s) with a usable lastmod" }).read;
    expect(first).toBe("Sample: 5 of the 12 sitemap URL(s) with a usable lastmod, chosen by impressions.");
  });
});
