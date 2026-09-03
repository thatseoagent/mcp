import { describe, expect, it, vi } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { createSingleFlightCache } from "@/lib/single-flight";
import { runInFreshFetchScope } from "@/lib/fetch-scope";

/** A loader that never settles until told, so overlap can be arranged exactly. */
function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe("concurrent callers share one load", () => {
  /**
   * The case the old cache could not handle, and the reason this module exists.
   * A Site Refresh starts twelve subtasks in one tick, so every one of them
   * reached the read before any reached the write and all twelve missed.
   */
  it("runs the loader once for twelve callers arriving in the same tick", async () => {
    const cache = createSingleFlightCache<string>();
    const gate = deferred<string>();
    const load = vi.fn(() => gate.promise);

    const callers = Array.from({ length: 12 }, () => cache.run("/", load));
    gate.resolve("html");

    expect(await Promise.all(callers)).toEqual(Array(12).fill("html"));
    expect(load).toHaveBeenCalledTimes(1);
  });

  it("serves a resolved value without loading again", async () => {
    const cache = createSingleFlightCache<string>();
    const load = vi.fn(async () => "html");

    expect(await cache.run("/", load)).toBe("html");
    expect(await cache.run("/", load)).toBe("html");
    expect(load).toHaveBeenCalledTimes(1);
  });

  it("keeps different keys apart", async () => {
    const cache = createSingleFlightCache<string>();
    const load = vi.fn(async () => "html");

    await cache.run("/a", load);
    await cache.run("/b", load);
    expect(load).toHaveBeenCalledTimes(2);
  });
});

describe("failures are not cached", () => {
  /**
   * A cached rejection would lock a URL out for the whole window, so one blip
   * during a refresh would fail every later subtask that wanted the same page.
   */
  it("lets the next caller retry after a rejection", async () => {
    const cache = createSingleFlightCache<string>();
    const load = vi
      .fn()
      .mockRejectedValueOnce(new Error("network"))
      .mockResolvedValueOnce("html");

    await expect(cache.run("/", load)).rejects.toThrow("network");
    expect(await cache.run("/", load)).toBe("html");
    expect(load).toHaveBeenCalledTimes(2);
  });

  it("still gives every concurrent caller of a failing load the same rejection", async () => {
    const cache = createSingleFlightCache<string>();
    const gate = deferred<string>();
    const load = vi.fn(() => gate.promise);

    const callers = [cache.run("/", load), cache.run("/", load)];
    // Attach handlers before rejecting so neither is an unhandled rejection.
    const settled = Promise.allSettled(callers);
    gate.reject(new Error("network"));

    expect((await settled).map((r) => r.status)).toEqual(["rejected", "rejected"]);
    expect(load).toHaveBeenCalledTimes(1);
  });

  /**
   * Eviction is by identity, not by key. A failure settles after another caller
   * may already have started a fresh attempt under the same key; deleting
   * blindly would throw away the attempt that is still running.
   */
  it("does not evict a newer attempt when an older one fails", async () => {
    const cache = createSingleFlightCache<string>();
    const first = deferred<string>();
    const failing = cache.run("/", () => first.promise);

    const rejected = failing.catch(() => "handled");
    first.reject(new Error("network"));
    await rejected;

    const second = vi.fn(async () => "html");
    const inflight = cache.run("/", second);
    // A third caller must join the second attempt, not start a third.
    expect(await cache.run("/", second)).toBe("html");
    expect(await inflight).toBe("html");
    expect(second).toHaveBeenCalledTimes(1);
  });
});

describe("the window", () => {
  it("loads again once the entry has aged out", async () => {
    vi.useFakeTimers();
    try {
      const cache = createSingleFlightCache<string>({ ttlMs: 1_000 });
      const load = vi.fn(async () => "html");

      expect(await cache.run("/", load)).toBe("html");
      vi.advanceTimersByTime(1_001);
      expect(await cache.run("/", load)).toBe("html");

      expect(load).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("the cache stays bounded", () => {
  it("drops the oldest keys past the limit", async () => {
    const cache = createSingleFlightCache<string>({ maxEntries: 3 });
    for (const key of ["a", "b", "c", "d", "e"]) {
      await cache.run(key, async () => key);
    }
    expect(cache.size).toBeLessThanOrEqual(3);
  });
});

/**
 * Sharing a request is only correct while every caller wants the same answer.
 * `force_refresh` is a caller saying the opposite, and before scoping it had no
 * way to say so to this layer: it skipped the database cache and was then handed
 * a response fetched a minute ago, possibly for a different user.
 */
describe("a fresh scope sees nothing and leaves nothing", () => {
  it("does not serve a shared entry to work asking for fresh data", async () => {
    const cache = createSingleFlightCache<string>();
    const load = vi.fn(async () => "html");

    await cache.run("/", load);
    await runInFreshFetchScope(() => cache.run("/", load));

    expect(load).toHaveBeenCalledTimes(2);
  });

  it("does not leak its result back to the shared scope", async () => {
    const cache = createSingleFlightCache<string>();
    const load = vi.fn(async () => "html");

    await runInFreshFetchScope(() => cache.run("/", load));
    await cache.run("/", load);

    expect(load).toHaveBeenCalledTimes(2);
  });

  /**
   * The property that keeps a forced refresh affordable: one fetch per document,
   * not one per subtask. Without it, bypassing the cache would mean going back
   * to twelve requests for one homepage.
   */
  it("still shares within the one run that asked for it", async () => {
    const cache = createSingleFlightCache<string>();
    const load = vi.fn(async () => "html");

    await runInFreshFetchScope(async () => {
      await Promise.all(Array.from({ length: 12 }, () => cache.run("/", load)));
    });

    expect(load).toHaveBeenCalledTimes(1);
  });

  it("keeps two concurrent fresh runs apart", async () => {
    const cache = createSingleFlightCache<string>();
    const load = vi.fn(async () => "html");

    await Promise.all([
      runInFreshFetchScope(() => cache.run("/", load)),
      runInFreshFetchScope(() => cache.run("/", load)),
    ]);

    expect(load).toHaveBeenCalledTimes(2);
  });

  /**
   * Scoping must not evict. One user asking for fresh data while another's
   * request is in flight would otherwise drop theirs.
   */
  it("leaves the shared entry usable afterwards", async () => {
    const cache = createSingleFlightCache<string>();
    const load = vi.fn(async () => "html");

    await cache.run("/", load);
    await runInFreshFetchScope(() => cache.run("/", load));
    await cache.run("/", load);

    // Two loads: the shared one, and the fresh one. The third call reused the
    // shared entry, which the fresh run never touched.
    expect(load).toHaveBeenCalledTimes(2);
  });
});

/**
 * The invariant this addition exists to keep: **every cache is reachable from
 * one reset.**
 *
 * Six caches lived in six modules and each exported its own `reset*`, every one
 * a pass-through to `cache.clear()`. `tests/setup.ts` cleared three of the six;
 * the other three were cleared by hand in whichever files happened to notice.
 * `tests/setup.ts` states the hazard exactly — a stale cache makes "the
 * assertion that fails about rendering, three layers away from the cause" — and
 * a cache added later inherited the leak and produced its failure elsewhere.
 *
 * The sweep is the part that makes this stick: registering at creation is only
 * true by construction as long as nothing creates a `Map` of its own.
 */
describe("every single-flight cache is reachable from one reset", () => {
  it("clears a cache the caller never named", async () => {
    const cache = createSingleFlightCache<string>();
    await cache.run("k", async () => "v");
    expect(cache.size).toBe(1);

    const { resetAllSingleFlightCaches } = await import("@/lib/single-flight");
    resetAllSingleFlightCaches();

    expect(cache.size).toBe(0);
  });

  it("clears every cache, not the most recent one", async () => {
    const first = createSingleFlightCache<string>();
    const second = createSingleFlightCache<string>();
    await Promise.all([first.run("a", async () => "1"), second.run("b", async () => "2")]);

    const { resetAllSingleFlightCaches } = await import("@/lib/single-flight");
    resetAllSingleFlightCaches();

    expect([first.size, second.size]).toEqual([0, 0]);
  });

  it("is the only cache in src/, so the registry really covers them all", () => {
    // A module holding its own `Map` of in-flight promises would be invisible to
    // the reset, which is the state this file exists to make impossible. Matched
    // on the shape, so the next one is caught the day it is written.
    const root = process.cwd();
    const OWNER = path.join("src", "lib", "single-flight.ts");

    const offenders: string[] = [];
    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir)) {
        const full = path.join(dir, entry);
        if (statSync(full).isDirectory()) {
          walk(full);
        } else if (entry.endsWith(".ts")) {
          const file = path.relative(root, full);
          if (file === OWNER) continue;
          const source = readFileSync(full, "utf8");
          if (/new Map<string,\s*(?:Inflight|\{\s*value:\s*Promise)/.test(source)) {
            offenders.push(file);
          }
        }
      }
    };
    walk(path.join(root, "src"));

    expect(offenders).toEqual([]);
  });
});
