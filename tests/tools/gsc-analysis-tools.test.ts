import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import { handler as quickWins } from "@/tools/gsc-detect-quick-wins";
import { handler as cannibalization } from "@/tools/gsc-detect-cannibalization";
import { handler as anomalies } from "@/tools/gsc-detect-anomalies";
import { handler as trends } from "@/tools/gsc-detect-trends";
import { handler as lostQueries } from "@/tools/gsc-detect-lost-queries";
import { handler as brandedSplit } from "@/tools/gsc-branded-split";
import { handler as deviceGap } from "@/tools/gsc-device-gap";
import { handler as countryOpportunity } from "@/tools/gsc-country-opportunity";
import { handler as pageQueryMap } from "@/tools/gsc-page-query-map";
import { handler as searchAppearance } from "@/tools/gsc-search-appearance";
import { handler as discover } from "@/tools/gsc-discover-performance";
import { handler as indexCoverage } from "@/tools/gsc-index-coverage-analysis";
import { handler as crawlFreshness } from "@/tools/gsc-crawl-freshness";
import { handler as richResults } from "@/tools/gsc-rich-results";
import { handler as featuredSnippets } from "@/tools/gsc-detect-featured-snippets";
import { handler as serpGap } from "@/tools/gsc-serp-features-gap";
import { fakeGoogleReader } from "@/lib/google/fake-reader";
import { resetPersistence } from "@/lib/db/runtime";
import type { SearchAnalyticsRow, SearchAnalyticsQuery } from "@/lib/google/reader";
import { resetAllSingleFlightCaches } from "@/lib/single-flight";

/**
 * The fifteen analysis Tools, against the test reader.
 *
 * These share their analyzers, which have their own tests. What is asserted here
 * is the half those cannot cover: that each Tool says what its numbers *are* —
 * whose threshold, what was sampled, and what an absence of findings means.
 */

beforeEach(() => {
  resetAllSingleFlightCaches();
});

afterEach(() => {
  resetPersistence();
  vi.restoreAllMocks();
});

const textOf = (result: { content: Array<{ text: string }> }): string =>
  result.content.map((part) => part.text).join("\n");

const window = {
  force_refresh: undefined,
  siteUrl: "example.com",
  startDate: undefined,
  endDate: undefined,
  days: undefined,
};

function row(keys: string[], clicks: number, impressions: number, position: number): SearchAnalyticsRow {
  return { keys, clicks, impressions, ctr: impressions > 0 ? clicks / impressions : 0, position };
}

/** A reader answering with different rows depending on the dimensions asked for. */
function readerWith(byDimension: Record<string, SearchAnalyticsRow[]>) {
  return fakeGoogleReader({
    searchConsole: {
      searchAnalytics: async (query: SearchAnalyticsQuery) =>
        byDimension[(query.dimensions ?? []).join(",")] ?? [],
    },
  });
}

describe("every analysis Tool says what its rows are", () => {
  const cases: Array<[string, () => Promise<{ content: Array<{ text: string }> }>]> = [
    ["quick wins", () => quickWins({ ...window, minImpressions: undefined, maxCtr: undefined }, readerWith({ query: [] }))],
    ["cannibalization", () => cannibalization({ ...window, minImpressions: undefined }, readerWith({ "query,page": [] }))],
    ["branded split", () => brandedSplit({ ...window, brandTerms: ["acme"] }, readerWith({ query: [] }))],
    ["device gap", () => deviceGap(window, readerWith({ device: [row(["MOBILE"], 5, 100, 6)] }))],
    ["country opportunity", () => countryOpportunity(window, readerWith({ country: [row(["esp"], 5, 100, 6)] }))],
    ["page query map", () => pageQueryMap({ ...window, page: undefined }, readerWith({ "page,query": [row(["/a", "q"], 5, 100, 6)] }))],
  ];

  for (const [name, run] of cases) {
    it(`${name} names how many rows it read and what Search Console withholds`, async () => {
      const text = textOf(await run());

      expect(text, name).toContain("=== WHAT THIS IS BASED ON ===");
      expect(text, name).toContain("an absence in these rows rather than a fact about the site");
    });
  }
});

describe("gsc_detect_quick_wins", () => {
  const args = { ...window, minImpressions: undefined, maxCtr: undefined };

  it("finds the query and says the thresholds are ours", async () => {
    const google = readerWith({ query: [row(["seo audit tool"], 5, 1000, 7)] });

    const text = textOf(await quickWins(args, google));

    expect(text).toContain("seo audit tool");
    expect(text).toContain("ours rather than Google's");
  });

  it("calls its estimate a floor, not a forecast", async () => {
    const google = readerWith({ query: [row(["q"], 5, 1000, 7)] });

    const text = textOf(await quickWins(args, google));

    expect(text).toContain("a floor built on a modest target, not a forecast");
  });

  it("treats no matches as not a verdict on the site", async () => {
    const text = textOf(await quickWins(args, readerWith({ query: [] })));

    expect(text).toContain("not a verdict on the site");
    expect(text).toContain("Lower `minImpressions`");
  });
});

describe("gsc_detect_cannibalization", () => {
  it("refuses to call two pages on one query a defect", async () => {
    // The single most over-diagnosed finding in SEO, and the caveat comes before
    // the list rather than after it.
    const google = readerWith({
      "query,page": [row(["shoes", "/a"], 10, 200, 4), row(["shoes", "/b"], 2, 150, 9)],
    });

    const text = textOf(await cannibalization({ ...window, minImpressions: undefined }, google));

    expect(text).toContain("a description, not a defect");
    expect(text).toContain("usually correct");
    expect(text.indexOf("interpretation")).toBeLessThan(text.indexOf("/a"));
  });
});

describe("gsc_detect_anomalies", () => {
  const days = (count: number, clicks: number) =>
    Array.from({ length: count }, (_, i) =>
      row([`2026-08-${String(i + 1).padStart(2, "0")}`], clicks, 100, 5),
    );

  it("says the window is too short rather than reporting a clean result", async () => {
    const text = textOf(await anomalies(window, readerWith({ date: days(5, 10) })));

    expect(text).toContain("Not enough days to say");
    expect(text).not.toContain("No day in this window");
  });

  it("warns that the most common anomaly is a Sunday", async () => {
    const rows = days(20, 10);
    rows[7] = row(["2026-08-08"], 90, 100, 5);

    const text = textOf(await anomalies(window, readerWith({ date: rows })));

    expect(text).toContain("2026-08-08");
    expect(text).toContain("The most common 'anomaly' in any window is a Sunday");
  });
});

describe("gsc_detect_trends and gsc_detect_lost_queries", () => {
  /** Different rows for the current and preceding windows. */
  function twoWindows(now: SearchAnalyticsRow[], before: SearchAnalyticsRow[]) {
    let call = 0;
    return fakeGoogleReader({
      searchConsole: { searchAnalytics: async () => (++call === 1 ? now : before) },
    });
  }

  it("reports a query as new rather than as having fallen from rank zero", async () => {
    const google = twoWindows([row(["new"], 20, 300, 12)], []);

    const text = textOf(await trends(window, google));

    expect(text).toContain("new in this window");
    expect(text).not.toContain("position 12.0 from 0.0");
  });

  it("says a disappearance is a change in what is reported", async () => {
    const google = twoWindows([], [row(["gone"], 40, 800, 3)]);

    const text = textOf(await lostQueries({ ...window, minImpressions: undefined }, google));

    expect(text).toContain("change in what Search Console reports");
    expect(text).toContain("Only the first is a problem");
  });
});

describe("gsc_branded_split", () => {
  it("refuses to guess the brand", async () => {
    const text = textOf(await brandedSplit({ ...window, brandTerms: [] }, readerWith({ query: [] })));

    expect(text).toContain("nothing to split on");
  });

  it("says a high branded share is not a fault", async () => {
    const google = readerWith({ query: [row(["acme"], 100, 200, 1), row(["seo tool"], 5, 900, 9)] });

    const text = textOf(await brandedSplit({ ...window, brandTerms: ["acme"] }, google));

    expect(text).toContain("A high branded share is not a fault");
    expect(text).toContain("Counted as branded, for example: acme");
  });
});

describe("gsc_device_gap and gsc_country_opportunity", () => {
  it("blames the web rather than the site for part of the mobile gap", async () => {
    const google = readerWith({
      device: [row(["MOBILE"], 5, 1000, 8), row(["DESKTOP"], 60, 500, 8)],
    });

    const text = textOf(await deviceGap(window, google));

    expect(text).toContain("Some of that gap is the web rather than the site");
  });

  it("reads a country seen and not clicked as language or intent, not rank", async () => {
    const google = readerWith({
      country: [row(["deu"], 1, 900, 6), row(["esp"], 90, 1000, 6)],
    });

    const text = textOf(await countryOpportunity(window, google));

    expect(text).toContain("=== SEEN, NOT CLICKED ===");
    expect(text).toContain("The usual");
    expect(text).toContain("seo_hreflang_validator");
  });
});

describe("gsc_search_appearance and gsc_serp_features_gap", () => {
  it("explains that no appearances is the normal state", async () => {
    const text = textOf(await searchAppearance(window, readerWith({ searchAppearance: [] })));

    expect(text).toContain("normal state for a site without structured");
  });

  it("says appearances overlap and do not add up to the property total", async () => {
    const google = readerWith({ searchAppearance: [row(["FAQ rich results"], 50, 500, 4)] });

    const text = textOf(await searchAppearance(window, google));

    expect(text).toContain("do not add up to the property's total");
  });

  it("frames a missing enhancement as a precondition, not a to-do", async () => {
    const google = readerWith({ searchAppearance: [], "": [row([], 10, 1000, 8)] });

    const text = textOf(await serpGap(window, google));

    expect(text).toContain("not a checklist");
    expect(text).toContain("manual action");
  });
});

describe("gsc_discover_performance", () => {
  it("explains that no Discover data is normal and not fixable", async () => {
    const text = textOf(await discover(window, readerWith({ page: [] })));

    expect(text).toContain("Most sites have none");
    expect(text).toContain("no setting that");
  });

  it("says there is no position column because a feed is not ranked", async () => {
    const google = readerWith({ page: [row(["/news/a"], 400, 9000, 0)] });

    const text = textOf(await discover(window, google));

    expect(text).toContain("no position column, and that is not an omission");
  });
});

describe("the Tools that inspect a sample", () => {
  const args = { force_refresh: undefined, siteUrl: "example.com", days: undefined };

  /** A property with pages, each inspectable. */
  function withPages(pages: Array<[string, number]>, inspection: (url: string) => unknown) {
    return fakeGoogleReader({
      searchConsole: {
        searchAnalytics: async () => pages.map(([url, impressions]) => row([url], 0, impressions, 5)),
        inspectUrl: async (_property: string, url: string) =>
          inspection(url) as { inspectionResult: Record<string, unknown> },
      },
    });
  }

  it("index coverage groups the unindexed by Google's own reason", async () => {
    // "Crawled, currently not indexed" and "Blocked by robots.txt" need entirely
    // different work, and a flat list makes them look like one problem.
    const google = withPages(
      [
        ["https://example.com/a", 900],
        ["https://example.com/b", 800],
      ],
      (url) => ({
        inspectionResult: {
          indexStatusResult: url.endsWith("/a")
            ? { verdict: "PASS", coverageState: "Submitted and indexed" }
            : { verdict: "FAIL", coverageState: "Blocked by robots.txt" },
        },
      }),
    );

    const text = textOf(await indexCoverage(args, google));

    expect(text).toContain("Indexed: 1 of 2 inspected");
    expect(text).toContain("Blocked by robots.txt — 1 page(s)");
  });

  it("index coverage keeps 'indexed as something else' separate", async () => {
    const google = withPages([["https://example.com/a", 900]], () => ({
      inspectionResult: {
        indexStatusResult: {
          verdict: "PASS",
          coverageState: "Submitted and indexed",
          googleCanonical: "https://example.com/other",
          userCanonical: "https://example.com/a",
        },
      },
    }));

    const text = textOf(await indexCoverage(args, google));

    expect(text).toContain("=== INDEXED AS SOMETHING ELSE (1) ===");
  });

  it("every sampling Tool says it sampled rather than surveyed", async () => {
    const google = withPages([["https://example.com/a", 900]], () => ({
      inspectionResult: { indexStatusResult: { verdict: "PASS", lastCrawlTime: new Date().toISOString() } },
    }));

    for (const run of [indexCoverage, crawlFreshness, richResults]) {
      const text = textOf(await run(args, google));
      expect(text).toContain("=== WHAT WAS SAMPLED ===");
      expect(text).toContain("chosen by impressions");
    }
  });

  it("crawl freshness treats a missing date as unknown, not as never", async () => {
    const google = withPages([["https://example.com/a", 900]], () => ({
      inspectionResult: { indexStatusResult: { verdict: "PASS" } },
    }));

    const text = textOf(await crawlFreshness(args, google));

    expect(text).toContain("absence of information rather than a crawl that never happened");
  });

  it("crawl freshness names its staleness threshold as ours", async () => {
    const old = new Date(Date.now() - 90 * 86_400_000).toISOString();
    const google = withPages([["https://example.com/a", 900]], () => ({
      inspectionResult: { indexStatusResult: { verdict: "PASS", lastCrawlTime: old } },
    }));

    const text = textOf(await crawlFreshness(args, google));

    expect(text).toContain("is our threshold, not Google's");
    expect(text).toContain("not an error");
  });

  it("rich results says nothing detected is not a fault", async () => {
    const google = withPages([["https://example.com/a", 900]], () => ({
      inspectionResult: { indexStatusResult: { verdict: "PASS" }, richResultsResult: { verdict: "PASS", detectedItems: [] } },
    }));

    const text = textOf(await richResults(args, google));

    expect(text).toContain("=== NOTHING DETECTED (1) ===");
    expect(text).toContain("Not a fault");
  });

  it("rich results separates detected-but-unusable from absent", async () => {
    // Markup that is there and will not be used is the most actionable state and
    // the easiest to miss.
    const google = withPages([["https://example.com/a", 900]], () => ({
      inspectionResult: {
        indexStatusResult: { verdict: "PASS" },
        richResultsResult: { verdict: "FAIL", detectedItems: [{ richResultType: "FAQ" }] },
      },
    }));

    const text = textOf(await richResults(args, google));

    expect(text).toContain("=== DETECTED BUT NOT USABLE (1) ===");
  });
});

describe("gsc_detect_featured_snippets", () => {
  it("says up front that nothing here is Google telling us anything", async () => {
    const text = textOf(await featuredSnippets(window, readerWith({ query: [] })));

    expect(text).toContain("no featured-snippet dimension");
    expect(text).toContain("Verify any of these by searching for the query yourself");
  });

  it("names the other reasons a well-ranked query gets no clicks", async () => {
    const google = readerWith({ query: [row(["q"], 3, 500, 3)] });

    const text = textOf(await featuredSnippets(window, google));

    expect(text).toContain("has other causes than a snippet");
    expect(text).toContain("Look at");
  });
});
