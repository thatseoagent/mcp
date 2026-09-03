import { describe, expect, it } from "vitest";
import { fakeGoogleReader } from "@/lib/google/fake-reader";
import type { GoogleReader } from "@/lib/google/reader";

/**
 * The invariant this file exists to keep: **no default answer is empty.**
 *
 * An unstubbed call returning `[]` lets a test pass while asserting nothing, so a
 * test that forgot to stub a method it depends on would look like a test that
 * verified something. Every Google Tool's test rests on this fake, and none of
 * them can see the hole from where they sit.
 *
 * It is a test rather than a comment because the comment was wrong. It claimed
 * that "any method left unspecified throws — never returns empty", which was
 * never true of any of the eleven methods and contradicted the argument for the
 * defaults ten lines below it. Throwing and returning a rich fixture are two ways
 * to close the same hole; this file chose the second and said the first.
 */

/** A date range, since every GA4 query requires one. */
const RANGE = [{ startDate: "28daysAgo", endDate: "yesterday" }];

/** Every method on the reader, called with arguments it will not look at. */
const CALLS: Array<[string, (reader: GoogleReader) => Promise<unknown>]> = [
  ["searchConsole.listProperties", (r) => r.searchConsole.listProperties()],
  [
    "searchConsole.searchAnalytics",
    (r) =>
      r.searchConsole.searchAnalytics({
        siteUrl: "sc-domain:example.com",
        startDate: "2026-08-01",
        endDate: "2026-08-28",
        dimensions: ["query"],
      }),
  ],
  [
    "searchConsole.searchAnalytics (dimensionless)",
    (r) =>
      r.searchConsole.searchAnalytics({
        siteUrl: "sc-domain:example.com",
        startDate: "2026-08-01",
        endDate: "2026-08-28",
      }),
  ],
  [
    "searchConsole.inspectUrl",
    (r) => r.searchConsole.inspectUrl("sc-domain:example.com", "https://example.com/"),
  ],
  ["searchConsole.listSitemaps", (r) => r.searchConsole.listSitemaps("sc-domain:example.com")],
  [
    "searchConsole.getSitemap",
    (r) => r.searchConsole.getSitemap("sc-domain:example.com", "/sitemap.xml"),
  ],
  ["analytics.listProperties", (r) => r.analytics.listProperties()],
  [
    "analytics.runReport",
    (r) => r.analytics.runReport({ property: "properties/1", metrics: ["sessions"], dateRanges: RANGE }),
  ],
  [
    "analytics.runPivotReport",
    (r) =>
      r.analytics.runPivotReport({
        property: "properties/1",
        metrics: ["sessions"],
        dateRanges: RANGE,
        dimensions: ["landingPage"],
        pivots: [{ fieldNames: ["landingPage"], limit: 5 }],
      }),
  ],
  [
    "analytics.runRealtimeReport",
    (r) => r.analytics.runRealtimeReport({ property: "properties/1", metrics: ["activeUsers"] }),
  ],
  ["analytics.getMetadata", (r) => r.analytics.getMetadata("properties/1")],
  [
    "analytics.checkCompatibility",
    (r) => r.analytics.checkCompatibility({ property: "properties/1", metrics: ["sessions"], dateRanges: RANGE }),
  ],
];

/** Empty in the way that matters: nothing a test could assert against. */
function isVacant(value: unknown): boolean {
  if (value === null || value === undefined) return true;
  if (Array.isArray(value)) return value.length === 0;
  if (typeof value === "object") {
    const own = Object.values(value as Record<string, unknown>);
    return own.length === 0 || own.every(isVacant);
  }
  return value === "" || value === 0;
}

describe("the test reader's defaults", () => {
  const reader = fakeGoogleReader();

  for (const [name, call] of CALLS) {
    it(`${name} answers with something a test can assert against`, async () => {
      expect(isVacant(await call(reader))).toBe(false);
    });
  }

  it("covers every method the interface declares", () => {
    const declared = [
      ...Object.keys(reader.searchConsole).map((k) => `searchConsole.${k}`),
      ...Object.keys(reader.analytics).map((k) => `analytics.${k}`),
    ];
    const exercised = new Set(CALLS.map(([name]) => name.split(" ")[0]));

    // So a method added to `GoogleReader` later cannot slip past this file.
    expect(declared.filter((name) => !exercised.has(name))).toEqual([]);
  });
});

describe("overriding one method", () => {
  it("leaves the rest answering, which is the reason for the defaults", async () => {
    const reader = fakeGoogleReader({
      searchConsole: { listProperties: async () => [{ siteUrl: "sc-domain:other.test", permissionLevel: "siteOwner" }] },
    });

    expect(await reader.searchConsole.listProperties()).toEqual([
      { siteUrl: "sc-domain:other.test", permissionLevel: "siteOwner" },
    ]);
    // A test that only cares about `listProperties` says so and inherits sensible
    // answers for the rest.
    expect(isVacant(await reader.analytics.listProperties())).toBe(false);
  });

  it("lets one method fail without disturbing the others", async () => {
    const reader = fakeGoogleReader({
      analytics: {
        runReport: async () => {
          throw new Error("quota exhausted");
        },
      },
    });

    await expect(
      reader.analytics.runReport({ property: "properties/1", metrics: ["sessions"], dateRanges: RANGE }),
    ).rejects.toThrow("quota exhausted");
    expect(isVacant(await reader.analytics.getMetadata("properties/1"))).toBe(false);
  });
});
