/**
 * How fast this server is allowed to hit somebody else's site.
 *
 * The retired app counted every MCP call in a `rate_limits` row, keyed by user,
 * and refused the caller once a fixed window filled up. Two of the three things
 * that ledger protected do not exist here: there is one Operator, so there is no
 * per-user fairness to enforce, and there is no shared Google project quota to
 * exhaust on anyone else's behalf. The third one survives intact, and it is the
 * reason this module exists:
 *
 *   > Every page fetch carries `ThatSEOAgentBot`. An unthrottled loop pointed at
 *   > one domain is us hammering a stranger's server under our own name.
 *
 * That argument gets stronger, not weaker, once anyone can run this. The ledger
 * was in a database because Vercel ran many instances that had to agree; one
 * process serving one Operator does not, so the same accounting lives in a Map.
 *
 * Two limits, because they answer different questions:
 *
 *   - A **minimum gap between request starts** to one origin. This is the old
 *     crawler's 300ms `setTimeout` between batches of three, restated as a rate
 *     rather than a pause, which is why it is 100ms: three requests per 300ms is
 *     the pace that crawl actually ran at. Spacing *starts* leaves fetches
 *     overlapping, so the crawler keeps its concurrency and the origin still
 *     never sees a burst.
 *   - A **ceiling per origin per window**, which the gap alone cannot give: a gap
 *     bounds the rate but not the total, and a runaway agent loop is a caller
 *     that never stops rather than one that goes too fast.
 *
 * Per origin, not global: auditing two sites at once is not one site being
 * hammered, and a limit that made those callers wait on each other would be
 * rationing the Operator's own work rather than protecting anybody.
 */
/** Minimum spacing between two request *starts* to the same origin. */
export const MIN_REQUEST_GAP_MS = 100;

/** The window the per-origin ceiling is counted over. */
export const ORIGIN_WINDOW_MS = 60_000;

/**
 * Requests to one origin per window.
 *
 * Deliberately generous, like the ledger it replaces: it exists to stop a
 * runaway loop, not to ration normal work. The widest single request this server
 * makes is a 50-page crawl, which spends about sixty fetches counting robots.txt
 * and redirects, so an Operator working hard on one site stays far below it and
 * a loop reaches it in half a minute.
 */
export const MAX_REQUESTS_PER_ORIGIN = 300;

/**
 * Thrown when an origin's window budget is spent.
 *
 * Authored by us and safe to publish — it names the origin the caller asked
 * about and the moment the budget returns, both of which they supplied or can
 * act on. It travels as an exception rather than as a Tool result because the
 * fetch layer that raises it sits under analyzers that have no way to return
 * one.
 */
export class CrawlBudgetError extends Error {
  readonly origin: string;
  readonly resetAt: number;

  constructor(origin: string, resetAt: number) {
    const seconds = Math.max(1, Math.ceil((resetAt - Date.now()) / 1000));
    super(
      `Paused: this server has already made ${MAX_REQUESTS_PER_ORIGIN} requests to ${origin} ` +
        `in the last minute, which is as hard as it is willing to press somebody else's site. ` +
        `Try again in about ${seconds}s, or ask for fewer pages.`,
    );
    this.name = "CrawlBudgetError";
    this.origin = origin;
    this.resetAt = resetAt;
  }
}

interface OriginState {
  /** Epoch ms before which no new request to this origin may start. */
  nextStartAt: number;
  /** Start of the window `count` is counted in. */
  windowStart: number;
  count: number;
}

const origins = new Map<string, OriginState>();

/** Drop all pacing state. For tests, so one case cannot leak into the next. */
export function resetCrawlPacing(): void {
  origins.clear();
}

/**
 * Wait until it is this request's turn to reach `url`, and count it.
 *
 * Every caller's slot is claimed **synchronously**, before the wait: the
 * arithmetic below runs to completion without an `await` in it, so two
 * concurrent callers cannot read the same `nextStartAt` and both decide they may
 * go now. The sleep afterwards is just each caller honouring the slot it was
 * already given.
 *
 * A URL that does not parse is let through. The SSRF guard is what rejects
 * those, and a second opinion here could only disagree with it.
 */
export async function paceRequestTo(url: string): Promise<void> {
  let origin: string;
  try {
    origin = new URL(url).origin;
  } catch {
    return;
  }

  const now = Date.now();
  const windowStart = Math.floor(now / ORIGIN_WINDOW_MS) * ORIGIN_WINDOW_MS;
  const state = origins.get(origin) ?? { nextStartAt: 0, windowStart, count: 0 };

  if (state.windowStart !== windowStart) {
    state.windowStart = windowStart;
    state.count = 0;
  }

  state.count += 1;
  if (state.count > MAX_REQUESTS_PER_ORIGIN) {
    // Recorded before the throw, so a caller that keeps trying keeps being
    // refused rather than slipping through on a count that never grew.
    origins.set(origin, state);
    throw new CrawlBudgetError(origin, windowStart + ORIGIN_WINDOW_MS);
  }

  const startAt = Math.max(now, state.nextStartAt);
  state.nextStartAt = startAt + MIN_REQUEST_GAP_MS;
  origins.set(origin, state);

  const wait = startAt - now;
  if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
}
