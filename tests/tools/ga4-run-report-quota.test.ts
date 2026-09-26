import { describe, it, expect, afterEach, vi } from "vitest";
import { handler as runReport } from "@/tools/ga4-run-report";
import { fakeGoogleReader, FAKE_GA4_REPORT } from "@/lib/google/fake-reader";
import { resetPersistence } from "@/lib/db/runtime";
import type { Ga4PropertyQuota, Ga4ReportQuery } from "@/lib/google/reader";

afterEach(() => {
  resetPersistence();
  vi.restoreAllMocks();
});

const textOf = (result: { content: Array<{ text: string }> }): string =>
  result.content.map((part) => part.text).join("\n");

const args = {
  force_refresh: undefined,
  propertyId: "123456789",
  metrics: ["sessions"],
  dimensions: undefined,
  startDate: undefined,
  endDate: undefined,
  limit: undefined,
  offset: undefined,
};

const withQuota = (propertyQuota: Ga4PropertyQuota) =>
  fakeGoogleReader({ analytics: { runReport: async () => ({ ...FAKE_GA4_REPORT, propertyQuota }) } });

describe("ga4_run_report's quota", () => {
  it("asks Google to report the property's quota", async () => {
    let asked: Ga4ReportQuery | undefined;
    const google = fakeGoogleReader({
      analytics: {
        runReport: async (query) => {
          asked = query;
          return FAKE_GA4_REPORT;
        },
      },
    });

    await runReport(args, google);

    expect(asked?.returnPropertyQuota).toBe(true);
  });

  it("says nothing extra when there is plenty left", async () => {
    const text = textOf(
      await runReport(args, withQuota({
        tokensPerDay: { consumed: 12, remaining: 180_000 },
        tokensPerHour: { consumed: 12, remaining: 39_000 },
      })),
    );

    expect(text).not.toContain("tokens left");
    expect(text).not.toContain("quota");
  });

  it("says how much of the daily quota is left and when it refills", async () => {
    const text = textOf(
      await runReport(args, withQuota({
        tokensPerDay: { consumed: 15, remaining: 12_345 },
        tokensPerHour: { consumed: 15, remaining: 39_000 },
      })),
    );

    expect(text).toContain("12,345 tokens left of its daily Analytics Data API quota");
    expect(text).toContain("midnight Pacific Time");
    expect(text).not.toContain("hourly");
  });

  it("says how much of the hourly quota is left and that it refills within the hour", async () => {
    const text = textOf(
      await runReport(args, withQuota({
        tokensPerDay: { consumed: 15, remaining: 150_000 },
        tokensPerHour: { consumed: 15, remaining: 1_200 },
      })),
    );

    expect(text).toContain("1,200 tokens left of its hourly Analytics Data API quota");
    expect(text).toContain("within an hour");
    expect(text).not.toContain("daily");
  });

  it("reads a status with no `remaining` as none left, which is how Google writes zero", async () => {
    const text = textOf(await runReport(args, withQuota({ tokensPerDay: { consumed: 10 } })));

    expect(text).toContain("0 tokens left of its daily");
  });

  it("measures against the limit, not against what one request spent", async () => {
    // `consumed` is this request's cost and `remaining` what is left after it, so
    // consumed + remaining is not the property's limit. 19,000 left is low by any
    // reading of a 200,000-token day, even though this request spent only 10.
    const text = textOf(await runReport(args, withQuota({ tokensPerDay: { consumed: 10, remaining: 19_000 } })));

    expect(text).toContain("19,000 tokens left");
  });
});
