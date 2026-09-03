import { describe, it, expect } from "vitest";
import {
  anomalies,
  biggestMovers,
  brandedSplit,
  cannibalization,
  compareWindows,
  isBranded,
  lost,
  MIN_DAYS_FOR_ANOMALY,
  quickWins,
  segmentShares,
  totalsOf,
} from "@/lib/google/gsc-analysis";
import { precedingWindow } from "@/lib/google/gsc-tool-shape";
import type { SearchAnalyticsRow } from "@/lib/google/reader";

/** A row, written the way a test wants to say it. */
function row(
  keys: string[],
  clicks: number,
  impressions: number,
  position: number,
): SearchAnalyticsRow {
  return { keys, clicks, impressions, ctr: impressions > 0 ? clicks / impressions : 0, position };
}

describe("totalling rows", () => {
  it("weights position by impressions rather than averaging it", () => {
    // A flat average gives one impression at rank 90 the same weight as ten
    // thousand at rank 3, which drags the site's average to somewhere it has
    // never been. Google's own figure is impression-weighted.
    const totals = totalsOf([row(["a"], 0, 10_000, 3), row(["b"], 0, 1, 90)]);

    expect(totals.position).toBeCloseTo(3.0087, 3);
  });

  it("recomputes CTR from the totals rather than averaging the rows'", () => {
    const totals = totalsOf([row(["a"], 1, 100, 5), row(["b"], 99, 100, 5)]);

    expect(totals.ctr).toBeCloseTo(0.5, 5);
  });

  it("does not divide by zero on an empty set", () => {
    expect(totalsOf([])).toEqual({ clicks: 0, impressions: 0, ctr: 0, position: 0 });
  });
});

describe("quick wins", () => {
  const rows = [
    // Seen a lot, just below the fold, nobody clicks. The shape.
    row(["seo audit tool"], 5, 1000, 7),
    // Same CTR, but at rank 30 — a better title changes nothing there.
    row(["deep query"], 5, 1000, 30),
    // Already converting well.
    row(["brand name"], 400, 1000, 1.2),
    // Right shape, too few impressions to be worth the work.
    row(["rare query"], 0, 12, 6),
  ];

  it("finds the query a better title could plausibly fix", () => {
    const found = quickWins(rows);

    expect(found.map((win) => win.query)).toEqual(["seo audit tool"]);
  });

  it("ranks by the size of the gap, not by impressions", () => {
    // A query with a million impressions already converting well is not an
    // opportunity.
    const found = quickWins([row(["small gap"], 19, 1000, 6), row(["big gap"], 1, 900, 6)]);

    expect(found[0].query).toBe("big gap");
  });

  it("estimates a floor rather than a forecast", () => {
    const [win] = quickWins([row(["q"], 5, 1000, 7)]);

    // 5% of 1000 is 50; 45 more than the 5 it already gets.
    expect(win.potentialClicks).toBe(45);
  });
});

describe("cannibalization", () => {
  it("finds a query with two pages clearing the floor", () => {
    const found = cannibalization([
      row(["shoes", "/a"], 10, 200, 4),
      row(["shoes", "/b"], 2, 150, 9),
      row(["boots", "/c"], 5, 100, 3),
    ]);

    expect(found).toHaveLength(1);
    expect(found[0].query).toBe("shoes");
    expect(found[0].bestPosition).toBe(4);
  });

  it("ignores two pages that each appeared a handful of times", () => {
    // Google trying things is not cannibalization, and without a floor a large
    // site reports thousands of conflicts nobody can act on.
    const found = cannibalization([row(["x", "/a"], 0, 3, 40), row(["x", "/b"], 0, 2, 55)]);

    expect(found).toEqual([]);
  });

  it("orders the competing pages by how often each appeared", () => {
    const [entry] = cannibalization([
      row(["shoes", "/quiet"], 1, 50, 8),
      row(["shoes", "/loud"], 9, 500, 3),
    ]);

    expect(entry.pages[0].page).toBe("/loud");
  });
});

describe("comparing two windows", () => {
  it("includes a key present in only one window", () => {
    // The interesting case, not an edge case to drop.
    const movements = compareWindows([row(["new"], 5, 100, 8)], [row(["gone"], 9, 200, 4)]);

    expect(movements.map((movement) => movement.key).sort()).toEqual(["gone", "new"]);
  });

  it("refuses to invent a position change for a key that was absent", () => {
    // Subtracting from zero would report a query that just appeared at rank 12
    // as having fallen twelve places.
    const [movement] = compareWindows([row(["new"], 5, 100, 12)], []);

    expect(Number.isNaN(movement.positionChange)).toBe(true);
  });

  it("finds what disappeared, busiest first", () => {
    const movements = compareWindows(
      [],
      [row(["big"], 50, 900, 3), row(["small"], 1, 25, 12), row(["noise"], 0, 4, 40)],
    );

    // `noise` never cleared the floor, so its absence is not a finding.
    expect(lost(movements).map((movement) => movement.key)).toEqual(["big", "small"]);
  });

  it("ranks movers by how much they moved, either way", () => {
    const movements = compareWindows(
      [row(["up"], 40, 500, 4), row(["down"], 2, 300, 9)],
      [row(["up"], 10, 400, 6), row(["down"], 60, 800, 3)],
    );

    expect(biggestMovers(movements)[0].key).toBe("down");
  });
});

describe("the preceding window", () => {
  it("is exactly the same length, both ends inclusive", () => {
    // A comparison window a day shorter inflates every delta — a bug the retired
    // product shipped.
    const before = precedingWindow("2026-08-01", "2026-08-28");

    expect(before).toEqual({ startDate: "2026-07-04", endDate: "2026-07-31" });
  });
});

describe("anomalies", () => {
  const steady = (days: number, clicks: number) =>
    Array.from({ length: days }, (_, i) => row([`2026-08-${String(i + 1).padStart(2, "0")}`], clicks, 100, 5));

  it("says nothing at all on a window too short to have a baseline", () => {
    // A mean over four days is not a baseline, and a clean result from one would
    // be a confident answer built on nothing.
    expect(anomalies(steady(MIN_DAYS_FOR_ANOMALY - 1, 10))).toEqual([]);
  });

  it("finds the day that does not look like the others", () => {
    const days = steady(20, 10);
    days[7] = row(["2026-08-08"], 90, 100, 5);

    const found = anomalies(days);

    expect(found[0].date).toBe("2026-08-08");
    expect(found[0].deviations).toBeGreaterThan(2);
  });

  it("reports nothing rather than dividing by zero on a perfectly flat window", () => {
    expect(anomalies(steady(20, 10))).toEqual([]);
  });
});

describe("branded and unbranded", () => {
  it("matches on a word boundary, never a substring", () => {
    // `ex` as a brand term would otherwise claim "example", "expert" and "next".
    expect(isBranded("acme pricing", ["acme"])).toBe(true);
    expect(isBranded("acmecorp pricing", ["acme"])).toBe(false);
    expect(isBranded("next steps", ["ex"])).toBe(false);
  });

  it("survives a brand name containing regex punctuation", () => {
    expect(isBranded("what is c++ used for", ["c++"])).toBe(true);
  });

  it("splits totals into the two halves", () => {
    const split = brandedSplit(
      [row(["acme"], 100, 200, 1), row(["seo tool"], 10, 1000, 8)],
      ["acme"],
    );

    expect(split.brandedQueries).toBe(1);
    expect(split.branded.clicks).toBe(100);
    expect(split.unbranded.clicks).toBe(10);
  });
});

describe("segment shares", () => {
  it("compares each segment's CTR as a ratio of the whole", () => {
    // A two-point CTR gap means something different at 3% than at 30%.
    const shares = segmentShares([row(["MOBILE"], 10, 1000, 8), row(["DESKTOP"], 40, 1000, 8)]);

    const mobile = shares.find((share) => share.segment === "MOBILE")!;
    expect(mobile.impressionShare).toBeCloseTo(0.5, 5);
    expect(mobile.ctrRatio).toBeCloseTo(0.4, 5);
  });

  it("drops a segment with no impressions rather than dividing by zero", () => {
    const shares = segmentShares([row(["TABLET"], 0, 0, 0), row(["MOBILE"], 5, 100, 6)]);

    expect(shares.map((share) => share.segment)).toEqual(["MOBILE"]);
  });
});
