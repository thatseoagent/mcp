import { describe, expect, it } from "vitest";
import {
  DEFAULT_VALUE,
  clicksWithoutValue,
  joinPages,
  valueWithoutReach,
  type Ga4LandingRow,
} from "@/lib/google/page-join";
import type { SearchAnalyticsRow } from "@/lib/google/reader";

function page(url: string, clicks: number, impressions = clicks * 20): SearchAnalyticsRow {
  return { keys: [url], clicks, impressions, ctr: impressions > 0 ? clicks / impressions : 0, position: 6 };
}

function landing(landingPage: string, sessions: number, engagedSessions: number, keyEvents = 0): Ga4LandingRow {
  return { landingPage, sessions, engagedSessions, keyEvents };
}

describe("joining Search Console pages to GA4 landing pages", () => {
  it("joins on the path and says how much of the clicks it covered", () => {
    const join = joinPages(
      [page("https://example.com/a/", 80), page("https://example.com/b", 20)],
      [landing("/a", 60, 30, 2), landing("/elsewhere", 5, 5)],
    );

    expect(join.joined).toHaveLength(1);
    expect(join.joined[0].path).toBe("/a");
    expect(join.joined[0].analytics.engagementRate).toBeCloseTo(0.5);
    expect(join.joinedClicks).toBe(80);
    expect(join.totalClicks).toBe(100);
    expect(join.searchOnly.map((side) => side.url)).toEqual(["https://example.com/b"]);
    expect(join.analyticsOnly.map((side) => side.path)).toEqual(["/elsewhere"]);
  });

  it("merges the spellings of one page on each side before joining", () => {
    const join = joinPages(
      [page("https://example.com/a", 10, 100), page("https://example.com/a?x=1", 5, 100)],
      [landing("/a", 10, 5, 1), landing("/a/", 10, 5, 0)],
    );

    expect(join.joined).toHaveLength(1);
    expect(join.joined[0].search.clicks).toBe(15);
    expect(join.joined[0].analytics.sessions).toBe(20);
    expect(join.joined[0].analytics.engagementRate).toBeCloseTo(0.5);
    expect(join.joined[0].analytics.keyEvents).toBe(1);
  });

  it("refuses to credit one GA4 row to two hosts that share a path", () => {
    const join = joinPages(
      [page("https://example.com/help", 30), page("https://docs.example.com/help", 10)],
      [landing("/help", 40, 20)],
    );

    expect(join.joined).toEqual([]);
    expect(join.ambiguous).toHaveLength(2);
    // Search Console did see this path, so GA4's row is not "never seen".
    expect(join.analyticsOnly).toEqual([]);
    expect(join.joinedClicks).toBe(0);
  });

  it("reads www. and the bare host as one host, not a collision", () => {
    const join = joinPages(
      [page("https://www.example.com/help", 30), page("https://example.com/help", 10)],
      [landing("/help", 40, 20)],
    );

    expect(join.ambiguous).toEqual([]);
    expect(join.joined).toHaveLength(1);
    expect(join.joined[0].search.clicks).toBe(40);
  });

  it("counts what cannot be joined on either side", () => {
    const join = joinPages([{ clicks: 3, impressions: 9, ctr: 0.3, position: 2 }], [landing("(not set)", 7, 1)]);
    expect(join.unreadable).toBe(1);
    expect(join.analyticsUnreadable).toEqual({ rows: 1, sessions: 7 });
  });
});

describe("what the join finds", () => {
  const join = joinPages(
    [
      page("https://example.com/busy-bouncy", 200, 5000),
      page("https://example.com/busy-good", 150, 4000),
      page("https://example.com/small-converter", 5, 50),
      page("https://example.com/mid", 30, 800),
    ],
    [
      landing("/busy-bouncy", 180, 30, 0),
      landing("/busy-good", 140, 110, 12),
      landing("/small-converter", 5, 4, 3),
      landing("/mid", 25, 20, 0),
    ],
  );

  it("flags pages with many clicks and low engagement, or none of the key events", () => {
    const flagged = clicksWithoutValue(join.joined, DEFAULT_VALUE, { keyEventsMeasured: true });
    expect(flagged.map((joined) => joined.path)).toEqual(["/busy-bouncy", "/mid"]);
  });

  it("does not flag missing key events when the property records none anywhere", () => {
    const flagged = clicksWithoutValue(join.joined, DEFAULT_VALUE, { keyEventsMeasured: false });
    expect(flagged.map((joined) => joined.path)).toEqual(["/busy-bouncy"]);
  });

  it("finds pages that convert and are seen less than the site's middle page", () => {
    const reach = valueWithoutReach(join.joined);
    expect(reach.median).toBe(2400);
    expect(reach.pages.map((joined) => joined.path)).toEqual(["/small-converter"]);
  });

  it("has nothing to find, and no median to divide by, when nothing joined", () => {
    expect(valueWithoutReach([])).toEqual({ pages: [], median: 0 });
  });
});
