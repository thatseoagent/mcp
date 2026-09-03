import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  CrawlBudgetError,
  MAX_REQUESTS_PER_ORIGIN,
  MIN_REQUEST_GAP_MS,
  paceRequestTo,
  resetCrawlPacing,
} from "@/lib/crawl-pacing";

/**
 * What this proves is a promise made to somebody else's server, so the
 * assertions are about wall-clock spacing and about the refusal, not about the
 * shape of the internal Map.
 */

beforeEach(() => {
  resetCrawlPacing();
});

describe("crawl pacing", () => {
  it("lets the first request to an origin start immediately", async () => {
    const started = Date.now();
    await paceRequestTo("https://example.com/");
    expect(Date.now() - started).toBeLessThan(MIN_REQUEST_GAP_MS);
  });

  it("spaces consecutive requests to the same origin", async () => {
    const started = Date.now();
    await paceRequestTo("https://example.com/a");
    await paceRequestTo("https://example.com/b");
    await paceRequestTo("https://example.com/c");

    // Three starts, so two gaps. Compared against the gap rather than an exact
    // total because the timer only guarantees "at least".
    expect(Date.now() - started).toBeGreaterThanOrEqual(2 * MIN_REQUEST_GAP_MS);
  });

  it("spaces concurrent requests too, not just sequential ones", async () => {
    // The case the counter exists for: three callers that all read the clock
    // before any of them has written to it. A slot is claimed synchronously, so
    // they queue instead of all deciding they may go now.
    const started = Date.now();
    await Promise.all([
      paceRequestTo("https://example.com/a"),
      paceRequestTo("https://example.com/b"),
      paceRequestTo("https://example.com/c"),
    ]);

    expect(Date.now() - started).toBeGreaterThanOrEqual(2 * MIN_REQUEST_GAP_MS);
  });

  it("does not make one site wait on another", async () => {
    await paceRequestTo("https://example.com/a");

    const started = Date.now();
    await paceRequestTo("https://other.example/a");

    expect(Date.now() - started).toBeLessThan(MIN_REQUEST_GAP_MS);
  });

  it("refuses once an origin's window budget is spent, naming the origin", async () => {
    // Fake timers keep the budget's own gap from making this test take half a
    // minute. The clock is pinned to a window boundary on purpose: the budget is
    // a fixed window, so where "now" happens to fall inside one decides whether
    // 300 requests land in a single window or straddle two. Starting at the
    // boundary is the only phase that makes this assertion mean one thing.
    vi.useFakeTimers();
    vi.setSystemTime(0);
    try {
      const spend = (async () => {
        for (let i = 0; i <= MAX_REQUESTS_PER_ORIGIN; i++) {
          await paceRequestTo(`https://example.com/${i}`);
        }
      })();
      const settled = spend.then(
        () => null,
        (error: unknown) => error,
      );
      await vi.advanceTimersByTimeAsync(MAX_REQUESTS_PER_ORIGIN * MIN_REQUEST_GAP_MS);
      const error = await settled;

      expect(error).toBeInstanceOf(CrawlBudgetError);
      expect((error as CrawlBudgetError).message).toContain("example.com");
    } finally {
      vi.useRealTimers();
    }
  });

  it("lets a URL it cannot parse through, leaving the refusal to the SSRF guard", async () => {
    await expect(paceRequestTo("not a url")).resolves.toBeUndefined();
  });
});
