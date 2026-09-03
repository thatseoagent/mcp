/**
 * How far a shared HTTP request reaches.
 *
 * Deduplicating fetches is only correct while every caller wants the same
 * answer. `force_refresh` is a caller saying the opposite: go and look again.
 * It bypasses the Tool Cache in the database, and before this it had no way to
 * say the same thing to the 60-second HTTP cache underneath — so a user asking
 * for fresh data could be handed markup fetched a minute ago for someone else.
 *
 * That was true before the cache started working, and almost never happened
 * because the cache almost never hit. Making it hit reliably made the bug
 * reliable too.
 *
 * A scope is a token mixed into every cache key. Requests in different scopes
 * cannot see each other's entries, so a fresh scope means real fetches — while
 * the twelve subtasks *inside* that one refresh still share, which is the whole
 * point of the cache. Nothing is evicted, so one user asking for fresh data
 * never drops another user's in-flight request.
 *
 * Modelled on the Per-request Auth Context in `lib/google/client.ts`, and for
 * the same stated reason: deep helpers need request-level facts without
 * threading a parameter through every analyzer signature.
 */

import { AsyncLocalStorage } from "node:async_hooks";

const scopeStorage = new AsyncLocalStorage<string>();

/**
 * The shared scope, used whenever nobody asked for anything fresher.
 *
 * A constant rather than a random default: outside a scope, callers should share
 * with each other, which is the ordinary case an agent turn wants.
 */
const SHARED = "shared";

let counter = 0;

/**
 * Run `fn` where no cached response is visible and nothing it fetches will be
 * visible to anyone outside.
 *
 * The token is a counter, not a timestamp or a random value: this module is
 * imported by pure analyzers, and `Date.now()`/`Math.random()` are the two calls
 * this codebase keeps out of that layer.
 */
export function runInFreshFetchScope<T>(fn: () => Promise<T>): Promise<T> {
  return scopeStorage.run(`fresh-${++counter}`, fn);
}

/** The current scope's token, for a cache to mix into its key. */
export function currentFetchScope(): string {
  return scopeStorage.getStore() ?? SHARED;
}
