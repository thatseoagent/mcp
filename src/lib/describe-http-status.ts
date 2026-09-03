/**
 * What an HTTP status means for someone who asked us to audit a URL.
 *
 * A tool that gave up on a page said `Error: HTTP 404 Not Found`, which is true
 * and tells the reader nothing about what to do next. The agent relaying it had no
 * more to work with than the user did.
 *
 * A leaf module on purpose: the low-level fetchers and the **Reachability Gate**
 * describe the same statuses, and they must not describe them differently. Named
 * for the verb rather than the noun because `http-status.ts` already exists and
 * means something else — the per-URL health check behind index coverage.
 */
export function describeHttpStatus(status: number, timeoutMs?: number): string {
  if (status === 0) {
    // The **Reachability Gate** knows the budget it allowed and a reader who is
    // told the number can act on it — raise it, or go and look at a slow origin.
    // "Could not be reached at all" is what the other callers know and all they
    // can honestly say.
    return timeoutMs
      ? `The URL did not respond within ${timeoutMs / 1000}s, so nothing about it could be measured.`
      : "The URL could not be reached at all.";
  }
  if (status === 404 || status === 410) {
    return `The URL returned HTTP ${status}. There is no page here to audit — check the address, or whether it has been removed.`;
  }
  if (status === 401 || status === 403) {
    return `The URL returned HTTP ${status}. The page is behind authentication or blocking our request, so nothing about it can be measured from outside.`;
  }
  if (status === 429) {
    return "The URL returned HTTP 429. The server is rate-limiting us; retrying later should work.";
  }
  if (status >= 500) {
    return `The URL returned HTTP ${status}. The server failed to serve the page, so an audit now would describe an error page rather than the site.`;
  }
  if (status >= 400) {
    return `The URL returned HTTP ${status}, so the page could not be read.`;
  }
  return `The URL returned HTTP ${status}, which is not a readable page.`;
}
