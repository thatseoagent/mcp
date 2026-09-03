import { describe, it, expect, afterEach, vi } from "vitest";
import gscListProperties, { handler } from "@/tools/gsc-list-properties";
import { fakeGoogleReader, FAKE_GSC_PROPERTIES } from "@/lib/google/fake-reader";
import { resetPersistence } from "@/lib/db/runtime";

/**
 * The sample Tool #9 exists to prove: built on the injected reader, and tested
 * against fixtures with no Google account, no project and no network.
 */

afterEach(() => {
  resetPersistence();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

const textOf = (result: Awaited<ReturnType<typeof handler>>): string =>
  result.content.map((part) => part.text).join("\n");

const run = (google = fakeGoogleReader()) => handler({ force_refresh: undefined }, google);

describe("gsc_list_properties against the test reader", () => {
  it("lists every property with its permission level", async () => {
    const text = textOf(await run());

    for (const property of FAKE_GSC_PROPERTIES) {
      expect(text).toContain(property.siteUrl);
      expect(text).toContain(property.permissionLevel);
    }
  });

  it("tells a Domain Property from a URL-Prefix Property", async () => {
    // Not interchangeable, and the practical difference is what the Operator is
    // choosing between: one covers every subdomain, the other exactly its prefix.
    const text = textOf(await run());

    expect(text).toMatch(/sc-domain:example\.com\n\s+Kind: Domain Property/);
    expect(text).toMatch(/https:\/\/shop\.example\.com\/\n\s+Kind: URL-Prefix Property/);
  });

  it("says how many properties can actually return data", async () => {
    // An Operator whose only property is unverified would otherwise read the
    // count as good news.
    const text = textOf(await run());

    expect(text).toContain("Readable properties: 3");
    expect(text).toContain("2 can actually return data");
    expect(text).toContain("no data can be read for this property");
  });

  it("treats an account with no properties as an answer, not an error", async () => {
    const result = await run(fakeGoogleReader({ searchConsole: { listProperties: async () => [] } }));

    expect(result.isError).toBeUndefined();
    const text = textOf(result);
    expect(text).toContain("can read no Search Console properties");
    // And points at the two things that actually cause it.
    expect(text).toContain("search.google.com/search-console");
    expect(text).toContain("switch accounts");
  });

  it("does not invent a note for a permission level Google has not published yet", async () => {
    const result = await run(
      fakeGoogleReader({
        searchConsole: {
          listProperties: async () => [{ siteUrl: "sc-domain:new.example", permissionLevel: "siteFutureUser" }],
        },
      }),
    );

    expect(textOf(result)).toContain("unrecognised level; treat with caution");
  });
});

describe("gsc_list_properties without the Google login", () => {
  it("is still callable and refuses with the login command", async () => {
    // ADR-0003: the Tool stays listed and answers with text an agent can relay.
    // Nothing is stubbed here — the real reader is used, and it has no tokens.
    vi.stubEnv("GOOGLE_CLIENT_ID", "client-id");
    vi.stubEnv("GOOGLE_CLIENT_SECRET", "client-secret");

    const result = await gscListProperties({});

    expect(result.isError).toBe(true);
    expect(result.content.map((part) => part.text).join("\n")).toContain(
      "thatseoagent-mcp-login",
    );
  });
});
