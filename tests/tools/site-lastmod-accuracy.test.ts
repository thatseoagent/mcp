import { describe, it, expect, afterEach, vi } from "vitest";
import { handler, metadata } from "@/tools/site-lastmod-accuracy";
import { fakeGoogleReader } from "@/lib/google/fake-reader";
import type { SearchAnalyticsRow, UrlInspection } from "@/lib/google/reader";
import { UpstreamApiError } from "@/lib/upstream-api-error";
import { resetPersistence } from "@/lib/db/runtime";
import { restoreFetch, serve } from "../helpers/serve";
import { WINDOW, expectClean, row, textOf } from "../helpers/site-tools";

afterEach(() => {
  restoreFetch();
  resetPersistence();
  vi.restoreAllMocks();
});

const ARGS = { ...WINDOW, pages: undefined, sitemapUrl: undefined };

const urlset = (...urls: Array<[string, string?]>) =>
  `<urlset>` +
  urls.map(([path, lastmod]) => `<url><loc>https://example.com${path}</loc>${lastmod ? `<lastmod>${lastmod}</lastmod>` : ""}</url>`).join("") +
  `</urlset>`;

const SITEMAP = urlset(
  ["/a", "2026-09-01"],
  ["/b", "2026-09-15T10:00:00Z"],
  ["/c"],
  ["/d", "2026-08-01"],
  ["/e", "last tuesday"],
);

const ROWS: SearchAnalyticsRow[] = [row(["https://example.com/b"], 20, 500), row(["https://www.example.com/a/"], 5, 100)];

const crawled = (lastCrawlTime?: string): UrlInspection => ({
  inspectionResult: { indexStatusResult: { verdict: "PASS", ...(lastCrawlTime ? { lastCrawlTime } : {}) } },
});

const INSPECTIONS: Record<string, UrlInspection> = {
  "https://example.com/a": crawled("2026-09-10T08:00:00Z"),
  "https://example.com/b": crawled("2026-09-10T08:00:00Z"),
  "https://example.com/d": crawled(),
};

function reader(rows: SearchAnalyticsRow[] = ROWS, inspected: string[] = []) {
  return fakeGoogleReader({
    searchConsole: {
      searchAnalytics: async () => rows,
      inspectUrl: async (_property: string, url: string) => {
        inspected.push(url);
        return INSPECTIONS[url] ?? crawled("2026-09-20T00:00:00Z");
      },
    },
  });
}

const serveSitemap = (body: string) =>
  serve({ "/robots.txt": { status: 404 }, "https://example.com/sitemap.xml": { body } });

describe("site_lastmod_accuracy", () => {
  it("is named as a cross-source Tool, says it spends inspections, and what it needs", () => {
    expect(metadata.name).toBe("site_lastmod_accuracy");
    expect(metadata.description).toContain("URL Inspection");
    expect(metadata.description).toContain("Needs the Google login");
  });

  it("compares each sampled lastmod with Google's last crawl", async () => {
    serveSitemap(SITEMAP);
    const inspected: string[] = [];
    const text = textOf(await handler(ARGS, reader(ROWS, inspected)));

    expect(text).toContain("URLs with a lastmod: 3 of 5");
    expect(text).toContain("Missing lastmod: 1");
    expect(text).toContain("Not a W3C date (so unusable as a lastmod): 1");

    expect(text).toContain("=== AGAINST GOOGLE'S LAST CRAWL (3 URL(s)) ===");
    expect(text).toContain("2 sampled by impressions in this window; the other 1 had none");
    expect(text).toContain("Last crawled on or after its lastmod: 1");
    expect(text).toContain("lastmod after the last crawl: 1");
    expect(text).toContain(
      "https://example.com/b — lastmod 2026-09-15T10:00:00Z, last crawled 2026-09-10T08:00:00Z",
    );
    expect(text).toContain("=== NO CRAWL ON RECORD (1) ===");
    expect(text).toContain("URL Inspection: 3 URL(s) inspected");
    // Busiest first, matched to Search Console across www and trailing slash.
    expect(inspected).toEqual(["https://example.com/b", "https://example.com/a", "https://example.com/d"]);
    expectClean(text);
  });

  it("quotes Google and labels the generation-time reading as our inference", async () => {
    serveSitemap(SITEMAP);
    const text = textOf(await handler(ARGS, reader()));

    expect(text).toContain("Google uses the <lastmod> value if it's consistently and verifiably");
    expect(text).toContain("https://developers.google.com/search/docs/crawling-indexing/sitemaps/build-sitemap");
    expect(text).toContain("is our inference from that sentence");
  });

  it("spots a sitemap that stamps every URL with the time it was generated", async () => {
    const now = new Date().toISOString();
    serveSitemap(urlset(["/a", now], ["/b", now], ["/c", now]));
    const text = textOf(await handler(ARGS, reader()));

    expect(text).toContain("Every dated URL carries the same lastmod");
    expect(text).toContain("3 of 3 dated URL(s) carry a lastmod within 10 minutes of when we fetched the sitemap");
    expectClean(text);
  });

  it("spots one date shared by the whole site without calling it generated", async () => {
    serveSitemap(urlset(["/a", "2020-01-01"], ["/b", "2020-01-01"]));
    const text = textOf(await handler(ARGS, reader()));

    expect(text).toContain("Every dated URL carries the same lastmod (2020-01-01)");
    expect(text).not.toContain("stamps the time it was generated");
  });

  it("inspects only as many as asked, busiest first", async () => {
    serveSitemap(SITEMAP);
    const inspected: string[] = [];
    const text = textOf(await handler({ ...ARGS, pages: 1 }, reader(ROWS, inspected)));

    expect(inspected).toEqual(["https://example.com/b"]);
    expect(text).toContain("Sampled by impressions in this window, most first.");
  });

  it("answers an empty window by sampling in sitemap order", async () => {
    serveSitemap(SITEMAP);
    const text = textOf(await handler(ARGS, reader([])));

    expect(text).toContain("0 sampled by impressions in this window; the other 3 had none");
    expectClean(text);
  });

  it("reports a sitemap it could not read as not checked, and inspects nothing", async () => {
    serve({ "/robots.txt": { status: 404 }, "https://example.com/sitemap.xml": { status: 500 } });
    const inspected: string[] = [];
    const text = textOf(await handler(ARGS, reader(ROWS, inspected)));

    expect(text).toContain("=== NOT CHECKED (1) ===\n  https://example.com/sitemap.xml (sitemap file) — it answered HTTP 500");
    expect(text).toContain("Not checked: no sitemap could be read");
    expect(inspected).toEqual([]);
    expectClean(text);
  });

  it("reports a sitemap robots.txt closes to us as not checked", async () => {
    serve({ "/robots.txt": { body: "User-agent: *\nDisallow: /" }, "https://example.com/sitemap.xml": { body: SITEMAP } });
    const text = textOf(await handler(ARGS, reader()));

    expect(text).toContain("robots.txt disallows this URL for our crawler, so it was not fetched");
    expect(text).toContain("Not checked: no sitemap could be read");
  });

  it("rejects when Google refuses an inspection", async () => {
    serveSitemap(SITEMAP);
    const refusing = fakeGoogleReader({
      searchConsole: {
        searchAnalytics: async () => ROWS,
        inspectUrl: async () => {
          throw new UpstreamApiError("Search Console", 429);
        },
      },
    });
    await expect(handler(ARGS, refusing)).rejects.toBeInstanceOf(UpstreamApiError);
  });

  it("counts a URL Google could not answer for apart from one it has no crawl of", async () => {
    // A 500 for one URL says nothing about the crawl, and "no crawl on record"
    // would be a claim about the page. It is listed with its reason instead.
    vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    serveSitemap(SITEMAP);
    const failing = fakeGoogleReader({
      searchConsole: {
        searchAnalytics: async () => ROWS,
        inspectUrl: async (_property: string, url: string) => {
          if (url.endsWith("/d")) throw new UpstreamApiError("Google Search Console", 500);
          return INSPECTIONS[url] ?? crawled("2026-09-20T00:00:00Z");
        },
      },
    });

    const text = textOf(await handler(ARGS, failing));

    expect(text).toContain("No crawl on record: 0");
    expect(text).toContain("Inspection did not complete: 1");
    expect(text).toContain("  https://example.com/d (inspection) — Google Search Console returned HTTP 500.");
    expect(text).toContain("3 of the 3 sitemap URL(s) with a usable lastmod, chosen by impressions.");
    expectClean(text);
  });

  it("rejects when Google refuses the Search Analytics read", async () => {
    const refusing = fakeGoogleReader({
      searchConsole: {
        searchAnalytics: async () => {
          throw new UpstreamApiError("Search Console", 403);
        },
      },
    });
    await expect(handler(ARGS, refusing)).rejects.toBeInstanceOf(UpstreamApiError);
  });
});
