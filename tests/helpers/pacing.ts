import { expect } from "vitest";
import { MIN_REQUEST_GAP_MS } from "@/lib/crawl-pacing";

/**
 * How far under the gap an observed spacing may fall before it counts as a burst.
 *
 * The assertions below measure request starts observed from inside a `fetch`
 * stub, which is a tick or two downstream of the pacing decision, and Node's
 * timers may fire a millisecond early against `Date.now()`. A burst is ~0ms
 * apart, so a few milliseconds of slack still fails the thing being ruled out
 * without failing on timer granularity.
 */
const TIMER_SLACK_MS = 10;

/**
 * Assert that a series of observed request starts was paced rather than burst.
 *
 * Every gap, not the total: three concurrent fetches finishing at once would
 * satisfy a total, which is exactly the shape being ruled out.
 *
 * Lives here rather than in each test file because `crawl-pacing` has unit tests
 * of its own that prove nothing about whether a Tool's fetch path calls it —
 * this is the assertion that does, and it is needed by more than one caller.
 */
export function expectPacedStarts(startedAt: readonly number[]): void {
  expect(startedAt.length).toBeGreaterThan(1);
  for (let i = 1; i < startedAt.length; i++) {
    expect(startedAt[i] - startedAt[i - 1]).toBeGreaterThanOrEqual(
      MIN_REQUEST_GAP_MS - TIMER_SLACK_MS,
    );
  }
}
