import { describe, it, expect, afterEach, vi } from "vitest";
import { sql } from "drizzle-orm";
import { database, resetPersistence, toolCache } from "@/lib/db/runtime";
import { DB_DISABLED, DB_PATH_VARIABLE } from "@/lib/db/database";
import { cacheKeyFor, NO_CACHE } from "@/lib/db/tool-cache";
import { withCache } from "@/lib/with-cache";
import { toolError, toolText } from "@/lib/tool-result";
import { useTempDatabase } from "../../helpers/temp-database";

let temp: ReturnType<typeof useTempDatabase> | null = null;

afterEach(() => {
  temp?.dispose();
  temp = null;
  delete process.env[DB_PATH_VARIABLE];
  resetPersistence();
  vi.restoreAllMocks();
});

describe("the cache key", () => {
  it("never lets one domain serve another's result", () => {
    // The bug this exists to prevent, and the reason every argument goes into
    // the key: two Sites' calls to one Tool differ only in an argument.
    const a = cacheKeyFor({ toolName: "seo_geo_score", args: { url: "https://foo.com/" } });
    const b = cacheKeyFor({ toolName: "seo_geo_score", args: { url: "https://bar.com/" } });

    expect(a).not.toBe(b);
  });

  it("keeps two Tools with identical arguments apart", () => {
    // `{ url }` is the whole argument list of eight Tools here. Without the name
    // in the key they would share one entry.
    const geo = cacheKeyFor({ toolName: "seo_geo_score", args: { url: "https://foo.com/" } });
    const eeat = cacheKeyFor({ toolName: "seo_eeat_score", args: { url: "https://foo.com/" } });

    expect(geo).not.toBe(eeat);
  });

  it("treats two spellings of one call as one key", () => {
    // Otherwise the same question asked twice is two entries and two crawls of
    // somebody's site.
    const a = cacheKeyFor({ toolName: "t", args: { a: 1, b: { x: 1, y: 2 } } });
    const b = cacheKeyFor({ toolName: "t", args: { b: { y: 2, x: 1 }, a: 1 } });

    expect(a).toBe(b);
  });

  it("does not treat array order as noise", () => {
    // Order is meaningful in an argument list a caller wrote out.
    const a = cacheKeyFor({ toolName: "t", args: { categories: ["seo", "performance"] } });
    const b = cacheKeyFor({ toolName: "t", args: { categories: ["performance", "seo"] } });

    expect(a).not.toBe(b);
  });

  it("ignores an argument that was not supplied", () => {
    const omitted = cacheKeyFor({ toolName: "t", args: { url: "https://foo.com/" } });
    const undefinedValue = cacheKeyFor({
      toolName: "t",
      args: { url: "https://foo.com/", strategy: undefined },
    });

    expect(omitted).toBe(undefinedValue);
  });
});

describe("the cache against a real database", () => {
  it("returns what was written", () => {
    temp = useTempDatabase();
    const cache = toolCache();
    const lookup = { toolName: "t", args: { url: "https://foo.com/" }, domain: "foo.com" };

    cache.write(lookup, "the answer");

    expect(cache.read(lookup)).toBe("the answer");
  });

  it("misses on a different domain even after a write", () => {
    temp = useTempDatabase();
    const cache = toolCache();

    cache.write({ toolName: "t", args: { url: "https://foo.com/" }, domain: "foo.com" }, "foo");

    expect(cache.read({ toolName: "t", args: { url: "https://bar.com/" } })).toBeNull();
  });

  it("does not return an expired entry", () => {
    temp = useTempDatabase();
    const cache = toolCache();
    const lookup = { toolName: "t", args: { url: "https://foo.com/" } };

    cache.write(lookup, "stale", -1);

    expect(cache.read(lookup)).toBeNull();
  });

  it("replaces rather than conflicting when the same call is written twice", () => {
    // Without the `on conflict` clause a second write after expiry hits the
    // unique index and throws, turning a cache miss into a Tool failure.
    temp = useTempDatabase();
    const cache = toolCache();
    const lookup = { toolName: "t", args: { url: "https://foo.com/" } };

    cache.write(lookup, "first");
    cache.write(lookup, "second");

    expect(cache.read(lookup)).toBe("second");
    const [{ n }] = database()!.all<{ n: number }>(sql`select count(*) as n from tool_cache`);
    expect(n).toBe(1);
  });

  it("drops expired entries and keeps live ones", () => {
    temp = useTempDatabase();
    const cache = toolCache();

    cache.write({ toolName: "t", args: { url: "a" } }, "gone", -1);
    cache.write({ toolName: "t", args: { url: "b" } }, "kept");

    expect(cache.evictExpired()).toBe(1);
    expect(cache.read({ toolName: "t", args: { url: "b" } })).toBe("kept");
  });

  it("drops everything held for one Site and nothing else", () => {
    // What the stored `domain` column is for: a hash cannot answer "what do you
    // have cached for this Site?".
    temp = useTempDatabase();
    const cache = toolCache();

    cache.write({ toolName: "t", args: { url: "https://foo.com/" }, domain: "foo.com" }, "foo");
    cache.write({ toolName: "t", args: { url: "https://bar.com/" }, domain: "bar.com" }, "bar");

    expect(cache.evictDomain("foo.com")).toBe(1);
    expect(cache.read({ toolName: "t", args: { url: "https://bar.com/" } })).toBe("bar");
  });
});

describe("the cache when there is no database", () => {
  it("misses every read and swallows every write", () => {
    process.env[DB_PATH_VARIABLE] = DB_DISABLED;
    resetPersistence();
    const cache = toolCache();

    expect(cache).toBe(NO_CACHE);
    cache.write({ toolName: "t", args: {} }, "ignored");
    expect(cache.read({ toolName: "t", args: {} })).toBeNull();
  });
});

describe("withCache", () => {
  it("serves a repeated call without running the handler again", () => {
    temp = useTempDatabase();
    const handler = vi.fn(async () => toolText("computed"));
    const wrapped = withCache({ toolName: "t", domainOf: () => "foo.com" }, handler);

    return (async () => {
      const first = await wrapped({ url: "https://foo.com/" } as never);
      const second = await wrapped({ url: "https://foo.com/" } as never);

      expect(first).toEqual(second);
      expect(handler).toHaveBeenCalledTimes(1);
    })();
  });

  it("runs the handler again when the Operator forces a refresh", async () => {
    temp = useTempDatabase();
    const handler = vi.fn(async () => toolText("computed"));
    const wrapped = withCache({ toolName: "t" }, handler);

    await wrapped({ url: "https://foo.com/" } as never);
    await wrapped({ url: "https://foo.com/", force_refresh: true } as never);

    expect(handler).toHaveBeenCalledTimes(2);
  });

  it("keeps the forced result where the next ordinary call will find it", async () => {
    // `force_refresh` is stripped before keying. Leaving it in would give the
    // same question two entries, so the fresh answer would never be found by the
    // ordinary call it exists to speed up.
    temp = useTempDatabase();
    const handler = vi.fn(async () => toolText("computed"));
    const wrapped = withCache({ toolName: "t" }, handler);

    await wrapped({ url: "https://foo.com/", force_refresh: true } as never);
    await wrapped({ url: "https://foo.com/" } as never);

    expect(handler).toHaveBeenCalledTimes(1);
  });

  it("never caches a failure", async () => {
    // An error is a fact about this moment. Caching it would hold a site's audit
    // hostage to one bad minute and make its own retry advice false.
    temp = useTempDatabase();
    const handler = vi.fn(async () => toolError("the server was down"));
    const wrapped = withCache({ toolName: "t" }, handler);

    await wrapped({ url: "https://foo.com/" } as never);
    await wrapped({ url: "https://foo.com/" } as never);

    expect(handler).toHaveBeenCalledTimes(2);
  });

  it("still answers correctly with no database, just without saving anything", async () => {
    process.env[DB_PATH_VARIABLE] = DB_DISABLED;
    resetPersistence();
    const handler = vi.fn(async () => toolText("computed"));
    const wrapped = withCache({ toolName: "t" }, handler);

    const first = await wrapped({ url: "https://foo.com/" } as never);
    const second = await wrapped({ url: "https://foo.com/" } as never);

    expect(first).toEqual(second);
    expect(handler).toHaveBeenCalledTimes(2);
  });
});
