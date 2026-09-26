/**
 * Waiting for a slot under somebody else's per-minute ceiling.
 *
 * `crawl-pacing.ts` answers "how hard may we press a stranger's site", and its
 * answer is ours: a gap we chose and a total we chose, refused outright when a
 * loop runs away. A fixed API asks a different question. Google, Wikimedia and
 * Open PageRank each publish how many requests a minute they will take, and
 * asking faster does not get more — it gets a 429 that the Operator reads as a
 * failure of the Tool. That is the "somebody else's ceiling" `CONTEXT.md`
 * describes, and the right behaviour under it is to wait for the minute to make
 * room rather than to refuse a request the provider would have answered a few
 * seconds later.
 *
 * So this is a sliding window over request starts, one per key: an ordinary call
 * never waits at all, and only the request that would exceed the minute's
 * allowance does, until the oldest start in the window ages out. The check and
 * the claim are one synchronous step, so concurrent callers cannot both take the
 * last slot. The count is per process, which is the Operator's whole server; a
 * second process on the same key shares the provider's quota without sharing
 * this, and the provider's 429 is what it meets.
 *
 * This began as `paceCrux`, written for the one API whose quota the site pace
 * sat above. It is here rather than in `third-party-api.ts` so the harness can
 * reset it without importing the fetch path (see `tests/setup.ts`).
 */

const MINUTE_MS = 60_000;

export interface CeilingLimiter {
  /**
   * Wait until one more request fits in `key`'s minute, then claim it.
   *
   * `perMinute` is passed per call rather than fixed per key because it belongs
   * to the service description, which is where a reader looks for it; every
   * caller of one key states the same number.
   */
  take(key: string, perMinute: number): Promise<void>;
  /** Forget every counted start. For tests, so one case cannot pace the next. */
  clear(): void;
}

/**
 * Every limiter this module has handed out.
 *
 * The same registry `single-flight.ts` keeps for its caches, for the same
 * reason: `resetCruxPacing` was reset by hand in the three test files that
 * happened to need it, and a window left full by one file made the next one wait
 * a minute for a quota the tests themselves had spent. Registering at creation
 * makes {@link resetAllCeilingLimiters} true by construction.
 */
const limiters = new Set<CeilingLimiter>();

/**
 * Empty every limiter. For tests, so one case cannot leak into the next.
 *
 * A limiter whose module has not been imported yet has nothing registered and
 * nothing to clear, which is why this is safe to call before any Tool loads.
 */
export function resetAllCeilingLimiters(): void {
  for (const limiter of limiters) limiter.clear();
}

export function createCeilingLimiter(): CeilingLimiter {
  /** When each request in the last minute started, oldest first, per key. */
  const windows = new Map<string, number[]>();

  const limiter: CeilingLimiter = {
    async take(key, perMinute) {
      for (;;) {
        const now = Date.now();
        const starts = windows.get(key) ?? [];
        while (starts.length > 0 && now - (starts[0] as number) >= MINUTE_MS) starts.shift();
        windows.set(key, starts);
        if (starts.length < perMinute) {
          starts.push(now);
          return;
        }
        // Until the oldest start leaves the window. Re-checked on waking rather
        // than claimed now, because a reset or a later caller may have changed
        // what the window holds in the meantime.
        const wait = MINUTE_MS - (now - (starts[0] as number)) + 1;
        await new Promise((resolve) => setTimeout(resolve, wait));
      }
    },
    clear() {
      windows.clear();
    },
  };

  limiters.add(limiter);
  return limiter;
}
