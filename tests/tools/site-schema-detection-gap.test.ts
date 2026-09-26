import { describe, it, expect, afterEach, vi } from "vitest";
import { handler, metadata } from "@/tools/site-schema-detection-gap";
import { fakeGoogleReader } from "@/lib/google/fake-reader";
import type { SearchAnalyticsRow, UrlInspection } from "@/lib/google/reader";
import { UpstreamApiError } from "@/lib/upstream-api-error";
import { resetPersistence } from "@/lib/db/runtime";
import { restoreFetch, serve, type Route } from "../helpers/serve";
import { WINDOW, expectClean, html, jsonLd, row, textOf } from "../helpers/site-tools";

afterEach(() => {
  restoreFetch();
  resetPersistence();
  vi.restoreAllMocks();
});

const ARGS = { ...WINDOW, pages: undefined };

const SITE: Record<string, Route> = {
  "/robots.txt": { body: "User-agent: *\nDisallow: /blocked" },
  "https://example.com/product": html(
    "<h1>Widget</h1>",
    jsonLd({
      "@context": "https://schema.org",
      "@graph": [
        { "@type": "Product", name: "Widget", aggregateRating: { "@type": "AggregateRating", ratingValue: 4 } },
        { "@type": "BreadcrumbList", itemListElement: [] },
        { "@type": "Organization", name: "Example" },
      ],
    }),
  ),
  "https://example.com/faq": html("<h1>FAQ</h1>", jsonLd({ "@type": "FAQPage", mainEntity: [] })),
  "https://example.com/old": html("<h1>Old</h1>"),
  "https://example.com/micro": html(`<div itemscope itemtype="https://schema.org/Recipe"><span itemprop="name">Soup</span></div>`),
  "https://example.com/blocked": html("<h1>Blocked</h1>"),
};

const ROWS: SearchAnalyticsRow[] = [
  row(["https://example.com/product"], 50, 1000),
  row(["https://example.com/faq"], 20, 500),
  row(["https://example.com/old"], 10, 200),
  row(["https://example.com/micro"], 5, 100),
  row(["https://example.com/blocked"], 1, 50),
];

function inspection(detectedItems: unknown[], lastCrawlTime: string | null = "2026-09-10T08:00:00Z"): UrlInspection {
  return {
    inspectionResult: {
      indexStatusResult: { verdict: "PASS", ...(lastCrawlTime ? { lastCrawlTime } : {}) },
      richResultsResult: { verdict: detectedItems.length > 0 ? "PASS" : undefined, detectedItems },
    },
  };
}

const INSPECTIONS: Record<string, UrlInspection> = {
  "https://example.com/product": inspection([
    {
      richResultType: "Product snippets",
      items: [{ name: "Widget", issues: [{ issueMessage: 'Missing field "offers"', severity: "ERROR" }] }],
    },
  ]),
  "https://example.com/faq": inspection([]),
  "https://example.com/old": inspection([{ richResultType: "Breadcrumbs", items: [{ name: "Trail" }] }]),
  "https://example.com/micro": inspection([{ richResultType: "Recipes", items: [{ name: "Soup" }] }]),
  "https://example.com/blocked": inspection([], null),
};

function reader(rows: SearchAnalyticsRow[] = ROWS, inspected: string[] = []) {
  return fakeGoogleReader({
    searchConsole: {
      searchAnalytics: async () => rows,
      inspectUrl: async (_property: string, url: string) => {
        inspected.push(url);
        return INSPECTIONS[url] ?? inspection([]);
      },
    },
  });
}

describe("site_schema_detection_gap", () => {
  it("is named as a cross-source Tool, says it spends inspections, and what it needs", () => {
    expect(metadata.name).toBe("site_schema_detection_gap");
    expect(metadata.description).toContain("URL Inspection");
    expect(metadata.description).toContain("Needs the Google login");
    expect(metadata.annotations?.idempotentHint).toBe(false);
  });

  it("finds markup with no rich result, rich results with issues, and detections the page no longer backs", async () => {
    serve(SITE);
    const text = textOf(await handler(ARGS, reader()));

    const declared = text.split("=== DECLARED, NO RICH RESULT DETECTED")[1].split("\n===")[0];
    expect(declared).toContain("https://example.com/product — BreadcrumbList");
    // Product was detected; Organization and the nested rating are never expected.
    expect(declared).not.toContain("— Product");
    expect(declared).not.toContain("Organization");
    expect(declared).not.toContain("AggregateRating");

    expect(text).toContain("=== RICH RESULTS WITH ISSUES (1) ===");
    expect(text).toContain('Product snippets: 1 issue(s), 1 ERROR (Google: an item with an ERROR cannot appear as a rich result); Missing field "offers"');

    expect(text).toContain("=== DETECTED BY GOOGLE, NO LONGER DECLARED (1) ===");
    expect(text).toContain("https://example.com/old — Google detected Breadcrumbs on 2026-09-10; the live page declares none of BreadcrumbList");
    // Microdata counts as declared.
    expect(text).not.toContain("https://example.com/micro — Google detected Recipes");

    expect(text).toContain("=== DECLARED, RICH RESULT RETIRED (1) ===");
    expect(text).toContain("https://example.com/faq — FAQPage");
    expectClean(text);
  });

  it("says the mapping is ours and how many inspections it spent", async () => {
    serve(SITE);
    const text = textOf(await handler(ARGS, reader()));

    expect(text).toContain("The pairing of schema.org types to rich result types is ours");
    expect(text).toContain("URL Inspection: 5 URL(s) inspected for this report");
    expect(text).toContain("2,000");
  });

  it("reuses inspections made in the last hour rather than spending them again", async () => {
    serve(SITE);
    const inspected: string[] = [];
    await handler(ARGS, reader(ROWS, inspected));
    await handler(ARGS, reader(ROWS, inspected));
    expect(inspected).toHaveLength(5);
  });

  it("reports a page robots.txt closes to us as not checked, keeping Google's side", async () => {
    serve(SITE);
    const text = textOf(await handler(ARGS, reader()));

    expect(text).toContain("Declared: not checked — the reason is under NOT CHECKED below.");
    expect(text).toContain("robots.txt disallows this URL");
    expect(text).toContain("=== NOT CHECKED (1) ===");
    expect(text).toContain("appears only in the issues list, which is Google's side");
    expect(text).toMatch(/^ {2}https:\/\/\S+ \(not read\) — robots\.txt disallows/m);
    expect(text).toContain("(Google reports no crawl of this URL)");
  });

  it("reports an unreachable page as not checked", async () => {
    serve({ ...SITE, "https://example.com/old": { status: 404 } });
    const text = textOf(await handler(ARGS, reader()));

    expect(text).toContain("Declared: not checked — the reason is under NOT CHECKED below.");
    expect(text).toContain("The URL returned HTTP 404");
    expect(text).not.toContain("https://example.com/old — Google detected Breadcrumbs");
    expectClean(text);
  });

  it("answers an empty window without inspecting anything", async () => {
    const mock = serve(SITE);
    const inspected: string[] = [];
    const text = textOf(await handler(ARGS, reader([], inspected)));

    expect(text).toContain("No pages with impressions in this window, so nothing was inspected");
    expect(inspected).toEqual([]);
    expect(mock).not.toHaveBeenCalled();
    expectClean(text);
  });

  it("rejects when Google refuses an inspection, rather than comparing the pages it did answer", async () => {
    const mock = serve(SITE);
    const refusing = fakeGoogleReader({
      searchConsole: {
        searchAnalytics: async () => ROWS,
        inspectUrl: async (_property: string, url: string) => {
          if (url.endsWith("/old")) throw new UpstreamApiError("Search Console", 429);
          return inspection([]);
        },
      },
    });

    await expect(handler(ARGS, refusing)).rejects.toBeInstanceOf(UpstreamApiError);
    // Google first: the site is not read for a report that cannot be made.
    expect(mock).not.toHaveBeenCalled();
  });

  it("reports a page Google could not inspect as not compared, and compares the rest", async () => {
    // One URL's 500 is that URL's answer; the other four are still a whole
    // comparison, and the note says which one is missing and why.
    vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    serve(SITE);
    const failing = fakeGoogleReader({
      searchConsole: {
        searchAnalytics: async () => ROWS,
        inspectUrl: async (_property: string, url: string) => {
          if (url.endsWith("/old")) throw new UpstreamApiError("Google Search Console", 500);
          return INSPECTIONS[url] ?? inspection([]);
        },
      },
    });

    const text = textOf(await handler(ARGS, failing));

    expect(text).toContain("  Google detected: not checked — the reason is under NOT CHECKED below.");
    expect(text).toContain("Google Search Console returned HTTP 500.");
    expect(text).not.toContain("https://example.com/old — Google detected Breadcrumbs");
    expect(text).toContain("=== RICH RESULTS WITH ISSUES (1) ===");
    // Two: this page, and the one robots.txt closes to us in the same fixture.
    expect(text).toContain("=== NOT CHECKED (2) ===");
    expect(text).toContain("neither side of the comparison was made for it");
    expect(text).toMatch(/^ {2}https:\/\/\S+ \(not inspected\) — Google Search Console returned HTTP 500\./m);
    // Listed once, with what it cost the comparison, not a second time as a bare failed inspection.
    expect(text.match(/example\.com\/old \(not inspected\)/g)).toHaveLength(1);
    expectClean(text);
  });

  it("lets a refusal of the Search Analytics read reject", async () => {
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
