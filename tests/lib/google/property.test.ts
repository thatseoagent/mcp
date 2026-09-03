import { describe, it, expect } from "vitest";
import {
  alternateProperty,
  isFormattedSiteUrl,
  matchSiteUrl,
  resolveSiteUrl,
  withPropertyFallback,
} from "@/lib/google/property";
import { UpstreamApiError } from "@/lib/upstream-api-error";
import { InvalidInputError } from "@/lib/invalid-input-error";
import { fakeGoogleReader, FAKE_GSC_PROPERTIES } from "@/lib/google/fake-reader";

const reader = () => fakeGoogleReader().searchConsole;

describe("recognising a property identifier", () => {
  it("knows both shapes Google issues", () => {
    expect(isFormattedSiteUrl("sc-domain:example.com")).toBe(true);
    expect(isFormattedSiteUrl("https://example.com/")).toBe(true);
    expect(isFormattedSiteUrl("http://example.com/")).toBe(true);
  });

  it("does not mistake a bare domain for one", () => {
    // What an agent passes, because it is what a person said. Google has never
    // heard of it.
    expect(isFormattedSiteUrl("example.com")).toBe(false);
    expect(isFormattedSiteUrl("www.example.com")).toBe(false);
  });
});

describe("matching a bare domain against what the account holds", () => {
  it("prefers the Domain Property when both shapes exist", () => {
    // The broader of the two. An Operator who wanted the narrower one can name it.
    expect(matchSiteUrl("example.com", FAKE_GSC_PROPERTIES)).toBe("sc-domain:example.com");
  });

  it("matches a subdomain to the Domain Property that covers it", () => {
    expect(matchSiteUrl("shop.example.com", FAKE_GSC_PROPERTIES)).toBe("sc-domain:example.com");
  });

  it("returns an already-formatted identifier untouched", () => {
    // And, crucially, without a lookup: an agent that pasted one from
    // gsc_list_properties should not pay for a round trip.
    expect(matchSiteUrl("https://shop.example.com/", FAKE_GSC_PROPERTIES)).toBe(
      "https://shop.example.com/",
    );
  });

  it("finds nothing for a domain the account does not hold", () => {
    expect(matchSiteUrl("somebody-else.com", FAKE_GSC_PROPERTIES)).toBeNull();
  });
});

describe("resolving what the Operator named", () => {
  it("costs no API call for an identifier that is already formatted", async () => {
    let asked = 0;
    const counting = fakeGoogleReader({
      searchConsole: {
        listProperties: async () => {
          asked++;
          return FAKE_GSC_PROPERTIES;
        },
      },
    }).searchConsole;

    await resolveSiteUrl(counting, "sc-domain:example.com");

    expect(asked).toBe(0);
  });

  it("explains what to do when no property matches", async () => {
    // The common cause is not a typo: it is a site the Operator does not hold in
    // Search Console, and the useful next step is the credential-free surface.
    const failure = await resolveSiteUrl(reader(), "somebody-else.com").catch(
      (error: unknown) => error,
    );

    expect(failure).toBeInstanceOf(InvalidInputError);
    const message = (failure as Error).message;
    expect(message).toContain("somebody-else.com");
    expect(message).toContain("sc-domain:example.com");
    expect(message).toContain("crawl_site");
  });
});

describe("the other spelling of one Site", () => {
  it("turns a Domain Property into a URL-Prefix one and back", () => {
    expect(alternateProperty("sc-domain:example.com")).toBe("https://example.com/");
    expect(alternateProperty("https://shop.example.com/")).toBe("sc-domain:example.com");
  });
});

describe("falling back between the two shapes", () => {
  const refusal = new UpstreamApiError("Google Search Console", 403);

  it("retries with the other shape when Google refuses the first", async () => {
    // Holding a property is not the same as being able to read it: an Operator
    // can have one shape verified and the other not.
    const asked: string[] = [];

    const { result, siteUrl } = await withPropertyFallback(
      reader(),
      "sc-domain:example.com",
      async (property) => {
        asked.push(property);
        if (property.startsWith("sc-domain:")) throw refusal;
        return "the report";
      },
    );

    expect(asked).toEqual(["sc-domain:example.com", "https://example.com/"]);
    expect(result).toBe("the report");
    expect(siteUrl).toBe("https://example.com/");
  });

  it("does not retry a quota refusal", async () => {
    // Retrying a 429 spends a second request against a quota that is already
    // exhausted, and the property was never the problem.
    const asked: string[] = [];
    const quota = new UpstreamApiError("Google Search Console", 429);

    await expect(
      withPropertyFallback(reader(), "sc-domain:example.com", async (property) => {
        asked.push(property);
        throw quota;
      }),
    ).rejects.toBe(quota);

    expect(asked).toHaveLength(1);
  });

  it("does not retry a server error", async () => {
    const asked: string[] = [];
    const broken = new UpstreamApiError("Google Search Console", 503);

    await expect(
      withPropertyFallback(reader(), "sc-domain:example.com", async (property) => {
        asked.push(property);
        throw broken;
      }),
    ).rejects.toBe(broken);

    expect(asked).toHaveLength(1);
  });

  it("surfaces the original refusal when both shapes refuse", async () => {
    // The Operator asked about the property they named. A message about one they
    // never mentioned would send them looking in the wrong place.
    const second = new UpstreamApiError("Google Search Console", 403);

    const failure = await withPropertyFallback(reader(), "sc-domain:example.com", async (property) => {
      throw property.startsWith("sc-domain:") ? refusal : second;
    }).catch((error: unknown) => error);

    expect(failure).toBe(refusal);
  });
});
