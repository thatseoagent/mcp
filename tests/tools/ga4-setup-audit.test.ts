import { describe, it, expect, afterEach, vi } from "vitest";
import { handler as setupAudit } from "@/tools/ga4-setup-audit";
import { fakeGoogleReader, FAKE_GA4_DATA_STREAMS } from "@/lib/google/fake-reader";
import { UpstreamApiError } from "@/lib/upstream-api-error";
import { resetPersistence } from "@/lib/db/runtime";

afterEach(() => {
  resetPersistence();
  vi.restoreAllMocks();
});

const textOf = (result: { content: Array<{ text: string }> }): string =>
  result.content.map((part) => part.text).join("\n");

const args = { force_refresh: undefined, propertyId: "123456789", domain: undefined };

const refuse = (status = 403) => async (): Promise<never> => {
  throw new UpstreamApiError("Google Analytics", status);
};

describe("ga4_setup_audit", () => {
  it("states two-month retention with Google's own consequence, not the common misreading", async () => {
    // The default fake keeps event data for two months. Google says retention
    // "only affects explorations and funnel reports", so claiming the standard
    // reports forget would be wrong in the direction that alarms people.
    const text = textOf(await setupAudit(args, fakeGoogleReader()));

    expect(text).toContain("Attention: Event data is kept for two months.");
    expect(text).toContain("only affects explorations and funnel reports");
    expect(text).toContain("does not affect standard aggregated reports");
    expect(text).toMatch(/=== WORTH ATTENTION ===[\s\S]*Event data is kept for two months/);
  });

  it("reads every section and says nothing is scored", async () => {
    const text = textOf(await setupAudit(args, fakeGoogleReader()));

    for (const heading of [
      "PROPERTY",
      "DATA RETENTION",
      "WEB DATA STREAMS",
      "KEY EVENTS",
      "ATTRIBUTION",
      "GOOGLE SIGNALS",
      "REPORTING IDENTITY",
      "CHANNEL GROUPS",
      "LINKS",
    ]) {
      expect(text).toContain(`=== ${heading} ===`);
    }
    expect(text).toContain("Reporting time zone: Europe/Madrid.");
    expect(text).toContain("G-EXAMPLE123");
    expect(text).toContain("nothing is scored");
    expect(text).not.toMatch(/score:|\/ ?100/i);
    expect(text).not.toContain("incomplete");
  });

  it("flags enhanced measurement settings an SEO loses data to", async () => {
    const text = textOf(await setupAudit(args, fakeGoogleReader()));

    expect(text).toContain("Attention: Enhanced measurement of site search is off for example.com.");
    expect(text).toContain("Attention: Enhanced measurement of form interactions is off for example.com.");
    expect(text).not.toContain("scrolls is off");
    // Off in GA4's toggle does not prove the event is missing.
    expect(text).toContain("Inference: the site may send the same event");
  });

  it("flags a stream whose enhanced measurement is off altogether", async () => {
    const google = fakeGoogleReader({
      analyticsAdmin: { getEnhancedMeasurement: async () => ({ streamEnabled: false }) },
    });

    const text = textOf(await setupAudit(args, google));

    expect(text).toContain("Attention: Enhanced measurement is off for example.com.");
  });

  it("notes how each key event is counted, and what the two methods mean once", async () => {
    const text = textOf(await setupAudit(args, fakeGoogleReader()));

    expect(text).toContain("purchase — counted once per event");
    expect(text).toContain("generate_lead — counted once per session");
    expect(text.match(/How counting works/g)).toHaveLength(1);
  });

  it("flags a property with no key events", async () => {
    const google = fakeGoogleReader({ analyticsAdmin: { listKeyEvents: async () => [] } });

    const text = textOf(await setupAudit(args, google));

    expect(text).toContain("Attention: No event on this property is marked as a key event.");
  });

  it("flags a property with no web stream", async () => {
    const google = fakeGoogleReader({
      analyticsAdmin: {
        listDataStreams: async () => [
          { name: "properties/123456789/dataStreams/1", type: "ANDROID_APP_DATA_STREAM", displayName: "App" },
        ],
      },
    });

    const text = textOf(await setupAudit(args, google));

    expect(text).toContain("Attention: This property has no web data stream (only 1 app stream).");
  });

  it("flags a web stream on another host when a domain is given", async () => {
    const google = fakeGoogleReader({
      analyticsAdmin: {
        listDataStreams: async () => [
          { ...FAKE_GA4_DATA_STREAMS[0], webStreamData: { measurementId: "G-OTHER", defaultUri: "https://other-site.org" } },
        ],
      },
    });

    const text = textOf(await setupAudit({ ...args, domain: "https://www.example.com/" }, google));

    expect(text).toContain("Attention: The stream example.com names other-site.org, not example.com.");
  });

  it("does not flag the same site or a subdomain of it", async () => {
    const same = textOf(await setupAudit({ ...args, domain: "www.example.com" }, fakeGoogleReader()));
    expect(same).not.toContain(", not example.com");

    const google = fakeGoogleReader({
      analyticsAdmin: {
        listDataStreams: async () => [
          { ...FAKE_GA4_DATA_STREAMS[0], webStreamData: { defaultUri: "https://blog.example.com" } },
        ],
      },
    });
    const sub = textOf(await setupAudit({ ...args, domain: "example.com" }, google));
    expect(sub).not.toContain(", not example.com");
  });

  it("flags redaction that removes the site search parameter", async () => {
    const google = fakeGoogleReader({
      analyticsAdmin: {
        getEnhancedMeasurement: async () => ({ streamEnabled: true, siteSearchEnabled: true, searchQueryParameter: "q,s" }),
        getDataRedaction: async () => ({ queryParameterRedactionEnabled: true, queryParameterKeys: ["q"] }),
      },
    });

    const text = textOf(await setupAudit(args, google));

    expect(text).toContain("Attention: Data redaction removes q, which site search reads its query from");
  });

  it("flags attribution that under-credits organic search, and a custom primary channel group", async () => {
    const google = fakeGoogleReader({
      analyticsAdmin: {
        getAttributionSettings: async () => ({ reportingAttributionModel: "GOOGLE_PAID_CHANNELS_LAST_CLICK" }),
        listChannelGroups: async () => [
          { name: "properties/123456789/channelGroups/1", displayName: "Default Channel Group", systemDefined: true },
          { name: "properties/123456789/channelGroups/2", displayName: "Our channels", primary: true },
        ],
      },
    });

    const text = textOf(await setupAudit(args, google));

    expect(text).toContain("Attention: Reporting attribution model: Ads-preferred last click.");
    expect(text).toContain("Our channels (primary)");
    expect(text).toContain("Attention: The primary channel group is a custom one.");
    expect(text).not.toContain("Default Channel Group");
  });

  it("mentions GA4's AI Assistant channel and labels the retroactivity claim as inference", async () => {
    const text = textOf(await setupAudit(args, fakeGoogleReader()));

    expect(text).toContain("AI Assistant channel since 2026-05-13");
    expect(text).toContain("inference, not a Google statement");
  });

  it("reports links as present or absent without printing the linked account", async () => {
    const text = textOf(await setupAudit(args, fakeGoogleReader()));

    expect(text).toContain("Google Ads: linked (1).");
    expect(text).toContain("BigQuery export: linked (1).");
    expect(text).not.toContain("123-456-7890");
    expect(text).not.toContain("example-analytics");
  });

  it("names what Google publishes no API for, every time", async () => {
    const text = textOf(await setupAudit(args, fakeGoogleReader()));

    expect(text).toContain("=== NOT CHECKED (2) ===");
    expect(text).toContain("Whether Search Console is linked — Google publishes no API for this.");
    expect(text).toContain("consent settings — Google publishes no API for these.");
  });

  it("flags a subproperty, whose totals are not the site's", async () => {
    const google = fakeGoogleReader({
      analyticsAdmin: {
        getProperty: async () => ({ name: "properties/123456789", propertyType: "PROPERTY_TYPE_SUBPROPERTY" }),
      },
    });

    const text = textOf(await setupAudit(args, google));

    expect(text).toContain("Attention: This is a subproperty.");
  });

  it("propagates a refusal of the property itself rather than auditing nothing", async () => {
    const google = fakeGoogleReader({ analyticsAdmin: { getProperty: refuse() } });

    await expect(setupAudit(args, google)).rejects.toBeInstanceOf(UpstreamApiError);
  });

  it("reports one v1alpha section Google refused as not checked, and says the audit is incomplete", async () => {
    const google = fakeGoogleReader({ analyticsAdmin: { getAttributionSettings: refuse(404) } });

    const result = await setupAudit(args, google);
    const text = textOf(result);

    expect(result.isError).toBeUndefined();
    expect(text).toContain("Note: this audit is incomplete.");
    expect(text).toContain("attribution is marked \"Not checked\"");
    expect(text).toMatch(/=== ATTRIBUTION ===\n.*v1alpha.*\n {2}Not checked — the reason is under NOT CHECKED below\./);
    expect(text).toContain("Google Analytics returned HTTP 404");
    // And in the one list of what this audit did not read, which counts it.
    expect(text).toContain("=== NOT CHECKED (3) ===");
    expect(text).toMatch(/^ {2}Attribution — Google Analytics returned HTTP 404/m);
    // Nothing about the missing section is presented as a finding either way.
    expect(text).not.toContain("Reporting attribution model");
    // And everything else that was read is still there.
    expect(text).toContain("Event data is kept for two months.");
    expect(text).toContain("purchase — counted once per event");
  });

  it("reports a per-stream v1alpha read Google refused as not checked for that stream", async () => {
    const google = fakeGoogleReader({ analyticsAdmin: { getEnhancedMeasurement: refuse() } });

    const text = textOf(await setupAudit(args, google));

    expect(text).toContain("Note: this audit is incomplete.");
    expect(text).toContain("enhanced measurement for example.com (v1alpha): Google Analytics returned HTTP 403");
    expect(text).not.toContain("site search is off");
    expect(text).toContain("Data redaction on example.com");
  });

  it("does not turn a failure that is not Google's refusal into a not-checked line", async () => {
    const google = fakeGoogleReader({
      analyticsAdmin: {
        getGoogleSignals: async () => {
          throw new Error("a bug");
        },
      },
    });

    await expect(setupAudit(args, google)).rejects.toThrow("a bug");
  });

  it("never asks for Measurement Protocol secrets", async () => {
    // The reader has no method for them; this pins that the Tool does not reach
    // for one through a cast either.
    const google = fakeGoogleReader();
    const reads = new Set<string>();
    const admin = new Proxy(google.analyticsAdmin, {
      get(target, key) {
        reads.add(String(key));
        return Reflect.get(target, key);
      },
    });

    await setupAudit(args, { ...google, analyticsAdmin: admin });

    expect([...reads].some((key) => /secret|measurementProtocol/i.test(key))).toBe(false);
  });
});
