import { describe, it, expect, afterEach, vi } from "vitest";
import { handler as annotations } from "@/tools/ga4-annotations";
import { fakeGoogleReader, FAKE_GA4_PROPERTY_DETAILS } from "@/lib/google/fake-reader";
import { resolveGa4Date } from "@/lib/google/ga4-tool-shape";
import { UpstreamApiError } from "@/lib/upstream-api-error";
import { InvalidInputError } from "@/lib/invalid-input-error";
import { resetPersistence } from "@/lib/db/runtime";
import type { Ga4Annotation } from "@/lib/google/reader";

afterEach(() => {
  resetPersistence();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

const textOf = (result: { content: Array<{ text: string }> }): string =>
  result.content.map((part) => part.text).join("\n");

const args = {
  force_refresh: undefined,
  propertyId: "123456789",
  startDate: undefined,
  endDate: undefined,
  days: undefined,
};

/** Noon UTC on 2026-09-24, so "today" is the same date in Madrid and in UTC. */
function atNoon() {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-09-24T12:00:00Z"));
}

const day = (year: number, month: number, date: number) => ({ year, month, day: date });

const google = (list: Ga4Annotation[]) =>
  fakeGoogleReader({ analyticsAdmin: { listAnnotations: async () => list } });

describe("ga4_annotations", () => {
  it("lists the annotations in the window, newest first, with who wrote them", async () => {
    atNoon();
    const text = textOf(
      await annotations(
        { ...args, startDate: "2026-06-01", endDate: "2026-09-01" },
        google([
          { title: "Old", annotationDate: day(2026, 6, 5) },
          { title: "Google's note", annotationDate: day(2026, 8, 20), systemGenerated: true },
          { title: "Middle", description: "Moved the blog", annotationDate: day(2026, 7, 10) },
        ]),
      ),
    );

    expect(text).toContain("Annotations in this window: 3 (newest first)");
    const order = ["Google's note", "Middle", "Old"].map((title) => text.indexOf(title));
    expect(order).toEqual([...order].sort((a, b) => a - b));
    expect(text).toContain("2026-08-20 — Google's note (written by Google)");
    expect(text).toContain("2026-07-10 — Middle (added on the property)");
    expect(text).toContain("    Moved the blog");
  });

  it("prints a range as a range, and keeps one that overlaps the window's edge", async () => {
    atNoon();
    const text = textOf(await annotations({ ...args, startDate: "2026-07-02", endDate: "2026-09-01" }, fakeGoogleReader()));

    expect(text).toContain("2026-07-01 to 2026-07-03 — Consent banner rollout");
    expect(text).toContain("2026-08-12 — New pricing page");
  });

  it("says how many annotations the window left out", async () => {
    atNoon();
    // Default window: the last 28 days, ending yesterday. Both fixtures are older.
    const text = textOf(await annotations(args, fakeGoogleReader()));

    expect(text).toContain("The window ends yesterday");
    expect(text).toContain("No annotations fall in this window.");
    expect(text).toContain("2 more annotations on this property fall outside this window.");
  });

  it("widens with `days`", async () => {
    atNoon();
    const text = textOf(await annotations({ ...args, days: 120 }, fakeGoogleReader()));

    expect(text).toContain("Window: 120daysAgo to yesterday");
    expect(text).toContain("Annotations in this window: 2");
    expect(text).not.toContain("outside this window");
  });

  it("says an empty property is an answer, not a sign nothing changed", async () => {
    const result = await annotations(args, google([]));

    expect(result.isError).toBeUndefined();
    expect(textOf(result)).toContain("This property has no annotations at all");
    expect(textOf(result)).toContain("says nothing about whether the site changed");
  });

  it("explains how to use them without calling a coincidence a cause", async () => {
    atNoon();
    const text = textOf(await annotations({ ...args, days: 120 }, fakeGoogleReader()));

    expect(text).toContain("gsc_detect_anomalies");
    expect(text).toContain("not evidence that the change caused the shift");
  });

  it("refuses a date it cannot read, by the argument's name", async () => {
    await expect(annotations({ ...args, startDate: "last week" }, fakeGoogleReader())).rejects.toThrow(
      InvalidInputError,
    );
    await expect(annotations({ ...args, startDate: "last week" }, fakeGoogleReader())).rejects.toThrow(
      /`startDate`/,
    );
  });

  it("propagates Google's refusal", async () => {
    const refusing = fakeGoogleReader({
      analyticsAdmin: {
        listAnnotations: async () => {
          throw new UpstreamApiError("Google Analytics", 403);
        },
      },
    });

    await expect(annotations(args, refusing)).rejects.toBeInstanceOf(UpstreamApiError);
  });

  it("resolves the window in the property's time zone", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    // 23:30 UTC on the 24th is already the 25th in Madrid.
    vi.setSystemTime(new Date("2026-09-24T23:30:00Z"));
    const reader = fakeGoogleReader({
      analyticsAdmin: {
        getProperty: async () => ({ ...FAKE_GA4_PROPERTY_DETAILS, timeZone: "Europe/Madrid" }),
        listAnnotations: async () => [{ title: "Launch", annotationDate: day(2026, 9, 24) }],
      },
    });

    const text = textOf(await annotations({ ...args, days: 1 }, reader));

    expect(text).toContain("Dates resolved to 2026-09-24 to 2026-09-24, in the time zone Europe/Madrid.");
    expect(text).toContain("2026-09-24 — Launch");
  });
});

describe("resolving a GA4 window date", () => {
  const now = new Date("2026-09-24T23:30:00Z");

  it("reads today in the zone given, and falls back to UTC by name", () => {
    expect(resolveGa4Date("today", "Europe/Madrid", now)).toEqual({ date: "2026-09-25", timeZone: "Europe/Madrid" });
    expect(resolveGa4Date("today", "America/Los_Angeles", now)?.date).toBe("2026-09-24");
    expect(resolveGa4Date("today", undefined, now)).toEqual({ date: "2026-09-24", timeZone: "UTC" });
    expect(resolveGa4Date("today", "Not/AZone", now)?.timeZone).toBe("UTC");
  });

  it("reads GA4's relative forms and passes a calendar date through", () => {
    expect(resolveGa4Date("yesterday", "UTC", now)?.date).toBe("2026-09-23");
    expect(resolveGa4Date("30daysAgo", "UTC", now)?.date).toBe("2026-08-25");
    expect(resolveGa4Date("2026-01-31", "UTC", now)?.date).toBe("2026-01-31");
    expect(resolveGa4Date("last week", "UTC", now)).toBeNull();
  });
});
