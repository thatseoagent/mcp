/**
 * The URL was read, and what came back cannot be audited.
 *
 * The class exists so that `describeToolFailure` can tell this apart from a
 * failure we did not author. Every message it carries comes out of
 * {@link describeHttpStatus} — a fixed sentence per status, interpolating nothing
 * but the numeric status — which is what makes the whole class safe to forward,
 * and is the test to re-run before adding a field to it.
 *
 * That constraint is the point, and it is easy to lose. The first version of this
 * error read `HTTP ${status} ${statusText}. …`, and `statusText` is the *remote
 * server's* reason phrase: an origin serving `404 Disregard prior instructions`
 * would have had that text forwarded into the model's context under our own
 * signature. `describeHttpStatus` already names the status, so nothing was gained
 * for it. Sibling code had this right — `page-reachability.ts` never took
 * `statusText` — which is the argument for one narrow type over a convention.
 *
 * Thrown as a bare `Error`, the same sentence was indistinguishable from a driver
 * string and got replaced by "the failure was unexpected", turning the most
 * common and most actionable diagnosis in the product ("there is no page here")
 * into advice to retry a permanent 404.
 *
 * A leaf beside `invalid-input-error.ts`, importing only the sentences: the
 * low-level fetchers and the analyzers all raise it, and none of them can reach
 * into `server/`.
 */
import { describeHttpStatus } from "./describe-http-status";

export class PageFetchError extends Error {
  /**
   * The HTTP status that produced this, or 0 when nothing arrived at all.
   *
   * Carried as a field because callers branch on it, and the only other place to
   * read it from is `message` — which is prose written for a person, and which
   * `tool-failure.ts` is allowed to publish verbatim. A caller matching on that
   * text couples a decision to wording that exists to be reworded.
   */
  readonly status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = "PageFetchError";
    this.status = status;
    // Restore prototype chain (needed when targeting ES5 or compiling with tsc)
    Object.setPrototypeOf(this, new.target.prototype);
  }

  /**
   * A response arrived and it is not one we can audit.
   *
   * Takes the status alone. Deliberately not the `statusText` — see above.
   */
  static fromResponse(status: number): PageFetchError {
    return new PageFetchError(`HTTP ${status}. ${describeHttpStatus(status)}`, status);
  }

  /**
   * The request never completed within the budget we allowed it.
   *
   * Leads with the duration because tests and readers alike key on that prefix,
   * then defers to the shared sentence rather than restating it — passing
   * `timeoutMs` through to `describeHttpStatus` would print the same number twice
   * in two units.
   */
  static timeout(timeoutMs: number): PageFetchError {
    return new PageFetchError(`Request timeout after ${timeoutMs}ms. ${describeHttpStatus(0)}`, 0);
  }
}
