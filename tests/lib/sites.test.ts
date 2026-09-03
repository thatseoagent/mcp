import { describe, it, expect, afterEach } from "vitest";
import { sql } from "drizzle-orm";
import {
  findSite,
  listSites,
  normaliseDomain,
  registerSite,
  rememberGoogleProperty,
} from "@/lib/sites";
import { InvalidInputError } from "@/lib/invalid-input-error";
import { database, resetPersistence } from "@/lib/db/runtime";
import { DB_PATH_VARIABLE } from "@/lib/db/database";
import { useTempDatabase } from "../helpers/temp-database";

let temp: ReturnType<typeof useTempDatabase> | null = null;

afterEach(() => {
  temp?.dispose();
  temp = null;
  delete process.env[DB_PATH_VARIABLE];
  resetPersistence();
});

describe("normalising a domain", () => {
  it("collapses the spellings a person means as one site", () => {
    for (const input of [
      "example.com",
      "www.example.com",
      "https://example.com",
      "https://www.example.com/pricing?a=1",
      "  EXAMPLE.com  ",
    ]) {
      expect(normaliseDomain(input), input).toBe("example.com");
    }
  });

  it("keeps a subdomain, because that really is a different Site", () => {
    // An Operator may legitimately want `example.com` and `blog.example.com` as
    // separate Sites with separate histories.
    expect(normaliseDomain("blog.example.com")).toBe("blog.example.com");
  });

  it("refuses something that is not a registrable domain", () => {
    expect(() => normaliseDomain("localhost")).toThrow(InvalidInputError);
    expect(() => normaliseDomain("")).toThrow(InvalidInputError);
  });
});

describe("registering a Site", () => {
  it("persists it", () => {
    temp = useTempDatabase();

    const site = registerSite("https://www.example.com/pricing");

    expect(site.domain).toBe("example.com");
    expect(site.registrableDomain).toBe("example.com");
    expect(findSite("example.com")?.id).toBe(site.id);
  });

  it("is idempotent, so one domain never splits its history across two rows", () => {
    // The retired product held four domains registered twice, each splitting
    // that domain's audit history and freshness window.
    temp = useTempDatabase();

    const first = registerSite("example.com");
    const second = registerSite("https://www.example.com/");

    expect(second.id).toBe(first.id);
    expect(listSites()).toHaveLength(1);
  });

  it("holds as many Sites as an Operator wants", () => {
    // A freelance SEO with a dozen clients is the case this is built for. There
    // is no limit, and nothing to enforce one with.
    temp = useTempDatabase();

    for (let i = 0; i < 25; i++) registerSite(`client-${i}.example`);

    expect(listSites()).toHaveLength(25);
  });

  it("has no owner column anywhere in the table", () => {
    // Not a simplification to be undone later: a `user_id` here would be the
    // first place a second tenant could hide.
    temp = useTempDatabase();
    registerSite("example.com");

    const columns = database()!
      .all<{ name: string }>(sql`pragma table_info(sites)`)
      .map((row) => row.name);

    expect(columns).not.toContain("user_id");
    expect(columns).not.toContain("owner_id");
    expect(columns).not.toContain("account_id");
  });

  it("records no entitlement, only where to look", () => {
    // Property Access is asked of Google every time. A stored boolean would be
    // a claim about permission that outlives the permission.
    temp = useTempDatabase();
    registerSite("example.com");

    const columns = database()!
      .all<{ name: string }>(sql`pragma table_info(sites)`)
      .map((row) => row.name);

    expect(columns).toContain("gsc_site_url");
    expect(columns.filter((name) => /access|granted|verified|permission/.test(name))).toEqual([]);
  });
});

describe("remembering where a Site's Google data lives", () => {
  it("stores the pointer and can clear it again", () => {
    temp = useTempDatabase();
    registerSite("example.com");

    rememberGoogleProperty("example.com", { gscSiteUrl: "sc-domain:example.com" });
    expect(findSite("example.com")?.gscSiteUrl).toBe("sc-domain:example.com");

    // Clearing matters as much as setting: a stale identifier would send the
    // next report at a property this account no longer holds.
    rememberGoogleProperty("example.com", { gscSiteUrl: null });
    expect(findSite("example.com")?.gscSiteUrl).toBeNull();
  });

  it("leaves a field alone when it is not named", () => {
    temp = useTempDatabase();
    registerSite("example.com");
    rememberGoogleProperty("example.com", { ga4PropertyId: "properties/1" });

    rememberGoogleProperty("example.com", { gscSiteUrl: "sc-domain:example.com" });

    expect(findSite("example.com")?.ga4PropertyId).toBe("properties/1");
  });
});
