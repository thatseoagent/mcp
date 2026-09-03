/**
 * A Tool's result, kept so repeating an analysis does not re-crawl the site.
 *
 * ── What the key has to contain, and the bug that says so ──
 *
 * The retired cache keyed on the Tool name and a hash of its arguments, scoped
 * by user. There is no user here, and dropping that scope without thinking is
 * how one Site's report gets served for another's: `seo_geo_score` for
 * `foo.com` and for `bar.com` differ only in an argument, so an argument the
 * hash misses is two Sites sharing one answer. **Every argument goes into the
 * key**, and there is a test whose whole job is to prove two domains never
 * collide.
 *
 * The domain is *also* stored as its own column. Not for lookup — the hash does
 * that — but because a hash cannot answer "what do you have cached for this
 * Site?", which is what an Operator asks and what a Site's invalidation needs.
 *
 * ── Why an interface with a no-op implementation ──
 *
 * See `database.ts`. A server with no database still runs every credential-free
 * Tool, and expressing that as `if (db)` at each call site is twenty chances to
 * forget one. {@link NO_CACHE} answers every lookup with a miss and discards
 * every write, so a Tool cannot tell the difference and does not check.
 *
 * ── Freshness is the caller's, expiry is ours ──
 *
 * A caller that wants new data says so with `forceRefresh`, which **bypasses the
 * entry without deleting it**: another caller's concurrent read of the same key
 * is still correct, and dropping the row would make one "give me fresh data"
 * request slow down everyone else's next one. This is the same distinction
 * `fetch-scope.ts` draws one layer down, for the same reason.
 */
import { createHash } from "node:crypto";
import { and, eq, gt, lt } from "drizzle-orm";
import { toolCache } from "./schema";
import { inMs, now } from "./instants";
import type { Database } from "./database";

/** How long an entry stays usable when the caller does not say. */
export const DEFAULT_TTL_MS = 60 * 60 * 1000;

export interface CacheLookup {
  /** The Tool asking, so two Tools with identical arguments do not share a row. */
  toolName: string;
  /** Everything the Tool was called with. All of it — see the module header. */
  args: unknown;
  /** The Site this is about, where the arguments name one. Stored, not keyed. */
  domain?: string | null;
}

export interface ToolCache {
  /** The stored result, or `null` on a miss, an expired entry, or no database. */
  read(lookup: CacheLookup): string | null;
  /** Keep a result. Silently does nothing when there is no database. */
  write(lookup: CacheLookup, result: string, ttlMs?: number): void;
  /** Drop expired entries. Returns how many went. */
  evictExpired(): number;
  /** Drop everything held for one Site. */
  evictDomain(domain: string): number;
}

/**
 * The key two calls share when they are the same call.
 *
 * The Tool name is included even though a hash of the arguments would usually
 * differ anyway: `{ url }` is the entire argument list of eight Tools here, so
 * without the name they would be one cache entry between them.
 *
 * Arguments are canonicalised before hashing, so `{ a: 1, b: 2 }` and
 * `{ b: 2, a: 1 }` are one key. Two spellings of one call would otherwise be two
 * entries and two crawls of somebody's site.
 */
export function cacheKeyFor(lookup: CacheLookup): string {
  const canonical = JSON.stringify(canonicalise(lookup.args));
  return createHash("sha256").update(`${lookup.toolName} ${canonical}`).digest("hex");
}

/** Object keys sorted, recursively. Arrays keep their order, which is meaningful. */
function canonicalise(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalise);
  if (value === null || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([k, v]) => [k, canonicalise(v)]),
  );
}

/** The cache, backed by the Operator's SQLite file. */
export function createToolCache(db: Database): ToolCache {
  return {
    read(lookup) {
      const key = cacheKeyFor(lookup);
      const [hit] = db
        .select({ resultJson: toolCache.resultJson })
        .from(toolCache)
        // Expiry is part of the query rather than checked afterwards, so an
        // expired row can never be returned by a path that forgot to look.
        .where(and(eq(toolCache.cacheKey, key), gt(toolCache.expiresAt, now())))
        .limit(1)
        .all();
      return hit?.resultJson ?? null;
    },

    write(lookup, result, ttlMs = DEFAULT_TTL_MS) {
      const key = cacheKeyFor(lookup);
      db.insert(toolCache)
        .values({
          toolName: lookup.toolName,
          cacheKey: key,
          resultJson: result,
          domain: lookup.domain ?? null,
          expiresAt: inMs(ttlMs),
          createdAt: now(),
        })
        // The same call arriving twice replaces rather than conflicts. Without
        // this, a second write after expiry hits the unique index and throws —
        // turning a cache miss into a Tool failure.
        .onConflictDoUpdate({
          target: toolCache.cacheKey,
          set: { resultJson: result, expiresAt: inMs(ttlMs), createdAt: now() },
        })
        .run();
    },

    evictExpired() {
      return db.delete(toolCache).where(lt(toolCache.expiresAt, now())).run().changes;
    },

    evictDomain(domain) {
      return db.delete(toolCache).where(eq(toolCache.domain, domain)).run().changes;
    },
  };
}

/**
 * The cache a server without a database has.
 *
 * Every read is a miss and every write is discarded, which is exactly right: the
 * Tool's answer is unchanged, it just costs a fetch every time. Nothing here
 * throws and nothing logs, because a cold install is not an error condition and
 * a warning per Tool call would be noise about a state the Operator chose.
 */
export const NO_CACHE: ToolCache = {
  read: () => null,
  write: () => {},
  evictExpired: () => 0,
  evictDomain: () => 0,
};
