/**
 * Serving a Tool's answer from the database when it has been asked before.
 *
 * Wrapped around a handler rather than called inside one, for the reason
 * `define-tool.ts` gives about seams: a cache consulted by hand is a cache some
 * Tool forgets to consult, and a Tool that forgets does not fail — it just
 * quietly re-crawls somebody's site every time.
 *
 * ── What `force_refresh` has to bypass ──
 *
 * Two layers, and missing either one makes the flag a lie. The database entry is
 * the obvious one. The other is the in-process HTTP cache underneath, which
 * dedupes fetches for sixty seconds — so a caller asking for fresh data could be
 * handed markup fetched a minute ago for somebody else. `fetch-scope.ts` exists
 * for exactly this, and running the handler inside a fresh scope is what makes
 * the bypass reach all the way down.
 *
 * The entry is bypassed, **not deleted**. Another caller's concurrent read of
 * the same key is still correct, and evicting would make one Operator's refresh
 * slow down their own next call for no gain.
 *
 * ── Only successes are kept ──
 *
 * An error result is a fact about this moment — a timeout, a 503, a rate limit —
 * and caching it would hold a site's audit hostage to one bad minute. It also
 * makes the retry advice these errors carry false, which is worse than the
 * wasted call.
 */
import { z } from "zod";
import { getDomain } from "tldts";
import { runInFreshFetchScope } from "./fetch-scope";
import { toolCache } from "./db/runtime";
import { DEFAULT_TTL_MS, type CacheLookup } from "./db/tool-cache";
import type { ToolResult } from "./tool-result";

export interface CacheOptions<Args> {
  /** The Tool asking. Part of the key. */
  toolName: string;
  /**
   * The Site this call is about, read off the arguments.
   *
   * A function rather than a value because the domain is per call, not per Tool.
   * Stored beside the entry rather than keyed into it — the hash already
   * separates two Sites' calls; this is what lets an Operator be told what is
   * cached and lets one Site's entries be dropped.
   */
  domainOf?: (args: Args) => string | null;
  /** How long the answer stays usable. */
  ttlMs?: number;
}

/**
 * The argument every cacheable Tool takes, so the flag is spelled one way.
 *
 * `force_refresh` in snake_case because it is part of the MCP surface, where the
 * rest of the argument names already are.
 */
export interface Refreshable {
  force_refresh?: boolean;
}

/**
 * The `force_refresh` argument, described once.
 *
 * Spread into a Tool's schema rather than retyped, because eighteen Tools each
 * wording this differently is eighteen slightly different promises about what
 * the flag does.
 */
export const refreshable = {
  force_refresh: z
    .boolean()
    .optional()
    .describe(
      "Ignore any cached answer and read the site again. Use this after making a change " +
        "you want to see reflected; otherwise leave it off, since a cached answer costs " +
        "the site nothing.",
    ),
};

/**
 * The Site a call is about, from a URL argument.
 *
 * The registrable domain rather than the hostname, so `www.foo.com` and
 * `foo.com` are recorded as one Site — which is what an Operator means by "what
 * do you have cached for this site?".
 */
export function domainFromUrl(args: { url?: string }): string | null {
  if (!args.url) return null;
  return getDomain(args.url) ?? getDomain(`https://${args.url}`) ?? null;
}

/**
 * Wrap a handler so identical calls are answered from the database.
 *
 * Applied *inside* `defineTool`, so a failure in the cache is still rendered as
 * a Tool result rather than escaping as a transport error.
 */
export function withCache<Args extends Refreshable>(
  options: CacheOptions<Args>,
  handler: (args: Args) => Promise<ToolResult>,
): (args: Args) => Promise<ToolResult> {
  return async (args: Args) => {
    const cache = toolCache();
    // `force_refresh` is stripped from what gets keyed. It says how to answer,
    // not what is being asked, and leaving it in would give the same question
    // two entries — so the fresh answer would never be found by the next
    // ordinary call, which is the one it exists to speed up.
    const { force_refresh: forceRefresh, ...rest } = args;
    const lookup: CacheLookup = {
      toolName: options.toolName,
      args: rest,
      domain: options.domainOf?.(args) ?? null,
    };

    if (!forceRefresh) {
      const hit = cache.read(lookup);
      if (hit !== null) return JSON.parse(hit) as ToolResult;
    }

    const result = forceRefresh
      ? await runInFreshFetchScope(() => handler(args))
      : await handler(args);

    if (!result.isError) {
      cache.write(lookup, JSON.stringify(result), options.ttlMs ?? DEFAULT_TTL_MS);
    }

    return result;
  };
}
