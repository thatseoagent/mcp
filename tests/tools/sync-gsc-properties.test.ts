import { describe, it, expect, afterEach } from "vitest";
import { handler } from "@/tools/sync-gsc-properties";
import { accessFor } from "@/lib/google/property-access";
import { fakeGoogleReader, FAKE_GSC_PROPERTIES } from "@/lib/google/fake-reader";
import { findSite, listSites, registerSite } from "@/lib/sites";
import { resetPersistence } from "@/lib/db/runtime";
import { DB_PATH_VARIABLE } from "@/lib/db/database";
import { useTempDatabase } from "../helpers/temp-database";

let temp: ReturnType<typeof useTempDatabase> | null = null;

afterEach(() => {
  temp?.dispose();
  temp = null;
  delete process.env[DB_PATH_VARIABLE];
  resetPersistence();
});

const textOf = (result: { content: Array<{ text: string }> }): string =>
  result.content.map((part) => part.text).join("\n");

const run = (domains: string[] | undefined, google = fakeGoogleReader()) =>
  handler({ force_refresh: undefined, domains }, google);

describe("deciding Property Access", () => {
  it("grants access through a Domain Property", () => {
    const access = accessFor("example.com", FAKE_GSC_PROPERTIES);

    expect(access.state).toBe("granted");
    expect(access.siteUrl).toBe("sc-domain:example.com");
  });

  it("resolves a subdomain to the Domain Property covering it", () => {
    // Both shapes reach a Site, because Google gives an Operator whichever they
    // set up.
    expect(accessFor("shop.example.com", FAKE_GSC_PROPERTIES).siteUrl).toBe(
      "sc-domain:example.com",
    );
  });

  it("resolves to a URL-Prefix Property when that is the only one", () => {
    expect(accessFor("unverified.example.net", FAKE_GSC_PROPERTIES).siteUrl).toBe(
      "https://unverified.example.net/",
    );
  });

  it("keeps 'found but unverified' apart from 'no property'", () => {
    // Not the same message: the Operator has already found the site in Search
    // Console, and one verification step away from a Full Report is not the same
    // as "add this site".
    const unverified = accessFor("unverified.example.net", FAKE_GSC_PROPERTIES);
    const absent = accessFor("somebody-else.com", FAKE_GSC_PROPERTIES);

    expect(unverified.state).toBe("unverified");
    expect(unverified.explanation).toContain("one step rather than a setup");
    expect(absent.state).toBe("absent");
    expect(absent.explanation).toContain("search.google.com/search-console");
  });
});

describe("sync_gsc_properties", () => {
  it("registers the domains it is given and reports each one's access", async () => {
    temp = useTempDatabase();

    const text = textOf(await run(["example.com", "somebody-else.com"]));

    expect(listSites().map((site) => site.domain)).toEqual([
      "example.com",
      "somebody-else.com",
    ]);
    expect(text).toContain("example.com — Full Report available");
    expect(text).toContain("somebody-else.com — no property");
  });

  it("never silently skips a Site whose property cannot be read", async () => {
    temp = useTempDatabase();

    const text = textOf(await run(["unverified.example.net"]));

    expect(text).toContain("Property found but unverified: 1");
    expect(text).toContain("unverified.example.net — property found, not verified");
  });

  it("asks Google again rather than trusting what it stored last time", async () => {
    // The criterion this Tool exists for. The first run records the property;
    // the second runs against an account that has lost it, and has to say so.
    temp = useTempDatabase();

    await run(["example.com"]);
    expect(findSite("example.com")?.gscSiteUrl).toBe("sc-domain:example.com");

    const revoked = fakeGoogleReader({ searchConsole: { listProperties: async () => [] } });
    const text = textOf(await run(undefined, revoked));

    expect(text).toContain("example.com — no property");
    // And the stale pointer is cleared, so nothing later aims at a property this
    // account no longer holds.
    expect(findSite("example.com")?.gscSiteUrl).toBeNull();
  });

  it("reports access regained without needing anything else run first", async () => {
    temp = useTempDatabase();
    registerSite("example.com");

    const noAccess = fakeGoogleReader({ searchConsole: { listProperties: async () => [] } });
    expect(textOf(await run(undefined, noAccess))).toContain("example.com — no property");

    expect(textOf(await run(undefined))).toContain("example.com — Full Report available");
  });

  it("says out loud that nothing about access was stored", async () => {
    temp = useTempDatabase();

    const text = textOf(await run(["example.com"]));

    expect(text).toContain("Nothing about access is");
    expect(text).toContain("you do not need to re-run this");
  });

  it("offers an Analytics property as a guess and labels it as one", async () => {
    // GA4 identifies a property by a number, not a domain. A wrong guess stored
    // silently would send every later report at the wrong property.
    temp = useTempDatabase();

    const text = textOf(await run(["example.com"]));

    expect(text).toContain("Analytics, possibly: properties/123456789");
    expect(text).toContain("which is a guess");
    // And it is not written to the Site.
    expect(findSite("example.com")?.ga4PropertyId).toBeNull();
  });

  it("still answers about Search Console when Analytics refuses", async () => {
    // Analytics is a suggestion here; its failure must not take down the answer
    // this Tool is actually about.
    temp = useTempDatabase();
    const google = fakeGoogleReader({
      analytics: {
        listProperties: async () => {
          throw new Error("Analytics is unavailable");
        },
      },
    });

    const result = await run(["example.com"], google);

    expect(result.isError).toBeUndefined();
    expect(textOf(result)).toContain("example.com — Full Report available");
  });

  it("tells an Operator with no Sites how to register one", async () => {
    temp = useTempDatabase();

    const text = textOf(await run(undefined));

    expect(text).toContain("No Sites are registered yet");
    expect(text).toContain("run_site_audit");
  });

  it("refuses before asking Google when there is nowhere to record a Site", async () => {
    process.env[DB_PATH_VARIABLE] = "off";
    resetPersistence();
    let asked = false;
    const google = fakeGoogleReader({
      searchConsole: {
        listProperties: async () => {
          asked = true;
          return FAKE_GSC_PROPERTIES;
        },
      },
    });

    await expect(run(["example.com"], google)).rejects.toThrow(/needs the server's database/);
    expect(asked).toBe(false);
  });
});
