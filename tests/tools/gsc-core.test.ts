import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import { handler as searchAnalytics } from "@/tools/gsc-search-analytics";
import { handler as inspectUrl } from "@/tools/gsc-inspect-url";
import { handler as bulkInspect, MAX_URLS } from "@/tools/gsc-bulk-url-inspection";
import { handler as listSitemaps } from "@/tools/gsc-list-sitemaps";
import { handler as getSitemap } from "@/tools/gsc-get-sitemap";
import { handler as healthCheck } from "@/tools/gsc-sites-health-check";
import { fakeGoogleReader } from "@/lib/google/fake-reader";
import { resetInspectionCache } from "@/lib/google/inspection-cache";
import { LAG_DAYS, daysAgo } from "@/lib/google/gsc-dates";
import { UpstreamApiError } from "@/lib/upstream-api-error";
import { resetPersistence } from "@/lib/db/runtime";

/**
 * The core Search Console Tools, against the test reader.
 *
 * No Google account, no project, no verified property and no network — which is
 * the whole reason #9 built the interface these are handed.
 */

beforeEach(() => {
  resetInspectionCache();
});

afterEach(() => {
  resetPersistence();
  vi.restoreAllMocks();
});

const textOf = (result: { content: Array<{ text: string }> }): string =>
  result.content.map((part) => part.text).join("\n");

const base = { force_refresh: undefined };

describe("gsc_search_analytics", () => {
  const args = {
    ...base,
    siteUrl: "example.com",
    dimensions: undefined,
    startDate: undefined,
    endDate: undefined,
    days: undefined,
    type: undefined,
    rowLimit: undefined,
  };

  it("resolves a bare domain to the Domain Property", async () => {
    const text = textOf(await searchAnalytics(args, fakeGoogleReader()));

    expect(text).toContain("Property: sc-domain:example.com");
  });

  it("ends the window before Search Console's lag rather than at today", async () => {
    // A window ending today ends with two or three days of zeroes, and every
    // comparison built on it reads that as traffic collapsing.
    const text = textOf(await searchAnalytics(args, fakeGoogleReader()));

    expect(text).toContain(`to ${daysAgo(LAG_DAYS)}`);
    expect(text).toContain("data lags by two to");
  });

  it("leaves an end date the caller named alone", async () => {
    const text = textOf(
      await searchAnalytics({ ...args, endDate: "2026-06-30" }, fakeGoogleReader()),
    );

    expect(text).toContain("to 2026-06-30");
    // And says nothing about the lag, because nothing was moved.
    expect(text).not.toContain("data lags by two to");
  });

  it("prints CTR as a percentage and position to one decimal", async () => {
    const text = textOf(
      await searchAnalytics({ ...args, dimensions: ["query"] }, fakeGoogleReader()),
    );

    expect(text).toContain("seo audit tool — 120 / 4300 / 2.79% / 8.4");
  });

  it("says an empty result is about the window, not about the site", async () => {
    const text = textOf(
      await searchAnalytics(
        args,
        fakeGoogleReader({ searchConsole: { searchAnalytics: async () => [] } }),
      ),
    );

    expect(text).toContain("fact about the window rather than about the property");
    expect(text).not.toContain("Rows: 0");
  });

  it("warns that a full page is probably not the whole answer", async () => {
    // Google returns exactly the limit when there is more, so a full page is
    // indistinguishable from a complete answer unless it is said.
    const text = textOf(
      await searchAnalytics({ ...args, rowLimit: 3, dimensions: ["query"] }, fakeGoogleReader()),
    );

    expect(text).toContain("A full page came back");
  });

  it("labels its totals as covering the rows shown, not the property", async () => {
    const text = textOf(
      await searchAnalytics({ ...args, dimensions: ["query"] }, fakeGoogleReader()),
    );

    expect(text).toContain("Across the rows shown: 494 clicks, 13920 impressions");
  });
});

describe("gsc_inspect_url", () => {
  const args = { ...base, url: "https://example.com/page", siteUrl: undefined };

  it("reports the indexing verdict and the canonical Google chose", async () => {
    const text = textOf(await inspectUrl(args, fakeGoogleReader()));

    expect(text).toContain("Verdict: PASS");
    expect(text).toContain("Chosen by Google: https://example.com/page");
  });

  it("calls out a canonical Google disagreed with", async () => {
    // The most useful thing an inspection says, and the most often misread.
    const text = textOf(
      await inspectUrl(
        args,
        fakeGoogleReader({
          searchConsole: {
            inspectUrl: async () => ({
              inspectionResult: {
                indexStatusResult: {
                  verdict: "PASS",
                  googleCanonical: "https://example.com/other",
                  userCanonical: "https://example.com/page",
                },
              },
            }),
          },
        }),
      ),
    );

    expect(text).toContain("Google chose a different canonical");
    expect(text).toContain("not the one appearing in results");
  });

  it("says 'not reported' rather than inventing a failed check", async () => {
    // A missing verdict is a check that did not run, not a FAIL.
    const text = textOf(
      await inspectUrl(
        args,
        fakeGoogleReader({
          searchConsole: { inspectUrl: async () => ({ inspectionResult: {} }) },
        }),
      ),
    );

    expect(text).toContain("Verdict: not reported by Google");
    expect(text).not.toContain("FAIL");
  });

  it("does not spend a second inspection on a URL already inspected", async () => {
    // Google rations these per property per day, and a spent one does not come
    // back.
    let inspections = 0;
    const counting = fakeGoogleReader({
      searchConsole: {
        inspectUrl: async () => {
          inspections++;
          return { inspectionResult: { indexStatusResult: { verdict: "PASS" } } };
        },
      },
    });

    await inspectUrl(args, counting);
    await inspectUrl(args, counting);

    expect(inspections).toBe(1);
  });
});

describe("gsc_bulk_url_inspection", () => {
  const args = (urls: string[]) => ({ ...base, urls, siteUrl: "example.com" });

  it("separates indexed from not indexed, and both from what it could not ask", async () => {
    const google = fakeGoogleReader({
      searchConsole: {
        inspectUrl: async (_siteUrl: string, url: string) => {
          if (url.endsWith("/broken")) throw new UpstreamApiError("Google Search Console", 404);
          return {
            inspectionResult: {
              indexStatusResult: {
                verdict: url.endsWith("/missing") ? "FAIL" : "PASS",
                coverageState: url.endsWith("/missing") ? "Crawled - currently not indexed" : "Indexed",
              },
            },
          };
        },
      },
    });

    const text = textOf(
      await bulkInspect(
        args([
          "https://example.com/a",
          "https://example.com/missing",
          "https://example.com/broken",
        ]),
        google,
      ),
    );

    expect(text).toContain("Indexed: 1");
    expect(text).toContain("Not indexed, or not reported as indexed: 1");
    expect(text).toContain("Could not be inspected on this run: 1");
    expect(text).toContain("=== NOT EVALUATED (1) ===");
  });

  it("does not let one failure discard the inspections already spent", async () => {
    // Those requests are gone from the daily allowance whether or not the report
    // renders.
    const google = fakeGoogleReader({
      searchConsole: {
        inspectUrl: async (_siteUrl: string, url: string) => {
          if (url.endsWith("/1")) throw new Error("boom");
          return { inspectionResult: { indexStatusResult: { verdict: "PASS" } } };
        },
      },
    });

    const result = await bulkInspect(
      args(["https://example.com/1", "https://example.com/2"]),
      google,
    );

    expect(result.isError).toBeUndefined();
    expect(textOf(result)).toContain("Indexed: 1");
  });

  it("collapses a duplicate URL instead of inspecting it twice", async () => {
    let inspections = 0;
    const google = fakeGoogleReader({
      searchConsole: {
        inspectUrl: async () => {
          inspections++;
          return { inspectionResult: { indexStatusResult: { verdict: "PASS" } } };
        },
      },
    });

    await bulkInspect(args(["https://example.com/a", "https://example.com/a"]), google);

    expect(inspections).toBe(1);
  });

  it("clamps a long list rather than spending the day's allowance on it", async () => {
    const urls = Array.from({ length: MAX_URLS + 5 }, (_, i) => `https://example.com/${i}`);
    let inspections = 0;
    const google = fakeGoogleReader({
      searchConsole: {
        inspectUrl: async () => {
          inspections++;
          return { inspectionResult: { indexStatusResult: { verdict: "PASS" } } };
        },
      },
    });

    const text = textOf(await bulkInspect(args(urls), google));

    expect(inspections).toBe(MAX_URLS);
    expect(text).toContain(`Only the first ${MAX_URLS} were inspected`);
    expect(text).toContain("left rather than spent");
  });

  it("treats an empty list as nothing to do, not as an error", async () => {
    const result = await bulkInspect(args([]), fakeGoogleReader());

    expect(result.isError).toBeUndefined();
    expect(textOf(result)).toContain("No URLs were given");
  });
});

describe("the sitemap Tools", () => {
  const args = { ...base, siteUrl: "example.com" };

  it("reports what a sitemap declares against what is indexed", async () => {
    const text = textOf(await listSitemaps(args, fakeGoogleReader()));

    expect(text).toContain("https://example.com/sitemap.xml");
    expect(text).toContain("web: 412 submitted, 398 indexed");
    expect(text).toContain("97% of what this sitemap declares is indexed");
  });

  it("says a missing count is not reported yet rather than zero", async () => {
    // A sitemap Google has not downloaded reported as `0 indexed` reads as a
    // sitemap Google rejected.
    const text = textOf(
      await listSitemaps(
        args,
        fakeGoogleReader({
          searchConsole: {
            listSitemaps: async () => [{ path: "https://example.com/sitemap.xml" }],
          },
        }),
      ),
    );

    expect(text).toContain("never — Google has not fetched it yet");
    expect(text).toContain("URL counts: not reported yet");
    expect(text).not.toContain("0 indexed");
  });

  it("treats a property with no sitemaps as a finding, not an error", async () => {
    const result = await listSitemaps(
      args,
      fakeGoogleReader({ searchConsole: { listSitemaps: async () => [] } }),
    );

    expect(result.isError).toBeUndefined();
    expect(textOf(result)).toContain("has no sitemaps for this property");
    expect(textOf(result)).toContain("not fatal");
  });

  it("reads one sitemap's record", async () => {
    const text = textOf(
      await getSitemap(
        { ...args, feedpath: "https://example.com/sitemap.xml" },
        fakeGoogleReader(),
      ),
    );

    expect(text).toContain("=== SITEMAP ===");
    expect(text).toContain("This is a sitemap index");
  });
});

describe("gsc_sites_health_check", () => {
  const args = { ...base, days: undefined };

  it("sorts the properties with data by clicks and names the silent ones", async () => {
    const google = fakeGoogleReader({
      searchConsole: {
        searchAnalytics: async (query) =>
          query.siteUrl === "sc-domain:example.com"
            ? [{ clicks: 500, impressions: 9000, ctr: 0.05, position: 5 }]
            : [],
      },
    });

    const text = textOf(await healthCheck(args, google));

    expect(text).toContain("With data in the window: 1");
    expect(text).toContain("sc-domain:example.com — 500 clicks");
    expect(text).toContain("Verified but no data in the window: 1");
  });

  it("never queries an unverified property", async () => {
    // Google returns no data for one, so asking spends a request to be told that.
    const asked: string[] = [];
    const google = fakeGoogleReader({
      searchConsole: {
        searchAnalytics: async (query) => {
          asked.push(query.siteUrl);
          return [];
        },
      },
    });

    const text = textOf(await healthCheck(args, google));

    expect(asked).not.toContain("https://unverified.example.net/");
    expect(text).toContain("Unverified, so no data can be read: 1");
  });

  it("keeps a property it could not query apart from one with no traffic", async () => {
    const google = fakeGoogleReader({
      searchConsole: {
        searchAnalytics: async (query) => {
          if (query.siteUrl === "sc-domain:example.com") {
            throw new UpstreamApiError("Google Search Console", 503);
          }
          return [];
        },
      },
    });

    const text = textOf(await healthCheck(args, google));

    expect(text).toContain("Could not be queried on this run: 1");
    expect(text).toContain("=== NOT EVALUATED (1) ===");
  });
});
