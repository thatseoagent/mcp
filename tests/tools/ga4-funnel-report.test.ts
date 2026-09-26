import { describe, it, expect, afterEach, vi } from "vitest";
import { handler as funnel } from "@/tools/ga4-funnel-report";
import { fakeGoogleReader } from "@/lib/google/fake-reader";
import { UpstreamApiError } from "@/lib/upstream-api-error";
import { InvalidInputError } from "@/lib/invalid-input-error";
import { resetPersistence } from "@/lib/db/runtime";
import type { Ga4FunnelQuery, Ga4FunnelReport } from "@/lib/google/reader";

afterEach(() => {
  resetPersistence();
  vi.restoreAllMocks();
});

const textOf = (result: { content: Array<{ text: string }> }): string =>
  result.content.map((part) => part.text).join("\n");

const steps = [
  { name: "Landing", eventName: "page_view" },
  { name: "Pricing", eventName: "page_view", pagePathPrefix: "/pricing" },
  { name: "Sign up", eventName: "sign_up" },
];

const args = {
  force_refresh: undefined,
  propertyId: "123456789",
  startDate: undefined,
  endDate: undefined,
  steps,
  isOpenFunnel: undefined,
  breakdownDimension: undefined,
};

describe("ga4_funnel_report", () => {
  it("renders users, completion rate and abandonments per step, and the end-to-end share", async () => {
    const text = textOf(await funnel(args, fakeGoogleReader()));

    expect(text).toContain("Funnel: closed");
    expect(text).toContain("2. Pricing — event page_view on pages starting /pricing");
    expect(text).toContain("1. Landing | 1200 | 31.0% | 828");
    expect(text).toContain("2. Pricing | 372 | 12.0% | 327");
    // The last step has nowhere to complete to; its 0 is a definition.
    expect(text).toContain("3. Sign up | 45 | — (last step) | 0");
    expect(text).toContain("End to end: 45 of 1200 users who reached the first step reached the last (3.8%).");
    expect(text).toContain("v1alpha");
    expect(text).toContain("The window ends yesterday");
  });

  it("reads columns by header name, not position", async () => {
    const reordered: Ga4FunnelReport = {
      funnelTable: {
        dimensionHeaders: [{ name: "funnelStepName" }],
        metricHeaders: [
          { name: "funnelStepAbandonments" },
          { name: "funnelStepAbandonmentRate" },
          { name: "activeUsers" },
          { name: "funnelStepCompletionRate" },
        ],
        rows: [
          { dimensionValues: [{ value: "1. Landing" }], metricValues: [{ value: "60" }, { value: "0.6" }, { value: "100" }, { value: "0.4" }] },
          { dimensionValues: [{ value: "2. Sign up" }], metricValues: [{ value: "0" }, { value: "0" }, { value: "40" }, { value: "0" }] },
        ],
      },
    };
    const google = fakeGoogleReader({ analytics: { runFunnelReport: async () => reordered } });

    const text = textOf(await funnel({ ...args, steps: steps.slice(0, 2) }, google));

    expect(text).toContain("1. Landing | 100 | 40.0% | 60");
    expect(text).toContain("2. Sign up | 40 | — (last step) | 0");
  });

  it("says a column Google did not return was not reported, rather than printing a number", async () => {
    const partial: Ga4FunnelReport = {
      funnelTable: {
        dimensionHeaders: [{ name: "funnelStepName" }],
        metricHeaders: [{ name: "activeUsers" }],
        rows: [
          { dimensionValues: [{ value: "1. Landing" }], metricValues: [{ value: "100" }] },
          { dimensionValues: [{ value: "2. Sign up" }], metricValues: [{ value: "40" }] },
        ],
      },
    };
    const google = fakeGoogleReader({ analytics: { runFunnelReport: async () => partial } });

    const text = textOf(await funnel({ ...args, steps: steps.slice(0, 2) }, google));

    expect(text).toContain("1. Landing | 100 | not reported | not reported");
  });

  it("says a sampled funnel is sampled", async () => {
    const google = fakeGoogleReader({
      analytics: {
        runFunnelReport: async () => ({
          funnelTable: {
            dimensionHeaders: [{ name: "funnelStepName" }],
            metricHeaders: [{ name: "activeUsers" }],
            rows: [{ dimensionValues: [{ value: "1. Landing" }], metricValues: [{ value: "10" }] }],
            metadata: { samplingMetadatas: [{ samplesReadCount: "500", samplingSpaceSize: "1000" }] },
          },
        }),
      },
    });

    const text = textOf(await funnel(args, google));

    expect(text).toContain("GA4 sampled this report (from about 50% of the data)");
  });

  it("sends the steps, the funnel type and the breakdown, and prints the breakdown column", async () => {
    let asked: Ga4FunnelQuery | undefined;
    const google = fakeGoogleReader({
      analytics: {
        runFunnelReport: async (query) => {
          asked = query;
          return {
            funnelTable: {
              dimensionHeaders: [{ name: "funnelStepName" }, { name: "deviceCategory" }],
              metricHeaders: [{ name: "activeUsers" }, { name: "funnelStepCompletionRate" }, { name: "funnelStepAbandonments" }],
              rows: [
                { dimensionValues: [{ value: "1. Landing" }, { value: "mobile" }], metricValues: [{ value: "80" }, { value: "0.25" }, { value: "60" }] },
                { dimensionValues: [{ value: "1. Landing" }, { value: "desktop" }], metricValues: [{ value: "20" }, { value: "0.5" }, { value: "10" }] },
              ],
            },
          };
        },
      },
    });

    const text = textOf(await funnel({ ...args, isOpenFunnel: true, breakdownDimension: "deviceCategory" }, google));

    expect(asked?.property).toBe("properties/123456789");
    expect(asked?.isOpenFunnel).toBe(true);
    expect(asked?.breakdownDimension).toBe("deviceCategory");
    expect(asked?.steps).toEqual(steps);
    expect(text).toContain("Funnel: open");
    expect(text).toContain("step | deviceCategory | users | completion rate | abandonments");
    expect(text).toContain("1. Landing | mobile | 80 | 25.0% | 60");
    // Per-segment rows do not add up to an end-to-end figure.
    expect(text).not.toContain("End to end");
  });

  it("refuses fewer than two steps before asking Google", async () => {
    const runFunnelReport = vi.fn();
    const google = fakeGoogleReader({ analytics: { runFunnelReport } });

    await expect(funnel({ ...args, steps: steps.slice(0, 1) }, google)).rejects.toThrow(InvalidInputError);
    await expect(funnel({ ...args, steps: steps.slice(0, 1) }, google)).rejects.toThrow(/at least 2/);
    expect(runFunnelReport).not.toHaveBeenCalled();
  });

  it("refuses more than ten steps", async () => {
    const eleven = Array.from({ length: 11 }, (_, index) => ({ name: `Step ${index}`, eventName: "page_view" }));

    await expect(funnel({ ...args, steps: eleven }, fakeGoogleReader())).rejects.toThrow(/at most 10/);
  });

  it("says an empty funnel is about the steps, not the property", async () => {
    const google = fakeGoogleReader({ analytics: { runFunnelReport: async () => ({ funnelTable: { rows: [] } }) } });

    const result = await funnel(args, google);

    expect(result.isError).toBeUndefined();
    expect(textOf(result)).toContain("No users entered this funnel in the window.");
    expect(textOf(result)).toContain("case-sensitive");
  });

  it("warns when the Funnel quota is running low", async () => {
    const google = fakeGoogleReader({
      analytics: {
        runFunnelReport: async () => ({ funnelTable: { rows: [] }, propertyQuota: { tokensPerHour: { consumed: 30, remaining: 900 } } }),
      },
    });

    const text = textOf(await funnel(args, google));

    expect(text).toContain("900 tokens left of its hourly Analytics Data API quota for Funnel requests");
  });

  it("propagates Google's refusal", async () => {
    const google = fakeGoogleReader({
      analytics: {
        runFunnelReport: async () => {
          throw new UpstreamApiError("Google Analytics", 403);
        },
      },
    });

    await expect(funnel(args, google)).rejects.toBeInstanceOf(UpstreamApiError);
  });
});
