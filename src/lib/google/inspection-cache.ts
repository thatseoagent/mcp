/**
 * One URL Inspection per URL per window, however it is asked for.
 *
 * ── Why this exists on top of the Tool cache ──
 *
 * The Tool cache keys on a Tool's whole argument list, so it saves a repeat of
 * the *same* call. URL Inspection is not asked for that way. `gsc_inspect_url`
 * takes one URL and `gsc_bulk_url_inspection` takes a list, and the lists
 * overlap: an Operator inspects twenty URLs, adds one, and asks again. To the
 * Tool cache that is a different call, so all twenty-one go to Google.
 *
 * That matters more than an ordinary cache miss because URL Inspection is
 * **rationed**: Google allows a fixed number of inspections per property per
 * day, and unlike a slow request a spent one does not come back. An Operator who
 * re-runs a bulk inspection twice can exhaust a day's budget on a question they
 * already had the answer to.
 *
 * So the unit of caching here is the URL, not the call. Both Tools go through
 * this, and neither knows which of its URLs were actually fetched.
 *
 * ── In process, not in the database ──
 *
 * An inspection is a statement about how Google sees a URL *right now*, and
 * "right now" moves: an Operator who fixes a `noindex` and re-inspects wants the
 * new verdict, not yesterday's. An hour is long enough to cover the working
 * session that spends the budget and short enough that a fix is visible within
 * one. Persisting it would make the stale window survive restarts, which is the
 * opposite of what an Operator debugging indexing wants.
 */
import { createSingleFlightCache } from "../single-flight";
import type { SearchConsoleReader, UrlInspection } from "./reader";

/** How long one URL's verdict is reused. See the module header for why an hour. */
export const INSPECTION_TTL_MS = 60 * 60 * 1000;

const inspections = createSingleFlightCache<UrlInspection>({
  ttlMs: INSPECTION_TTL_MS,
  // A bulk inspection can carry a lot of URLs, and an Operator may work across
  // several properties in a session. Generous, and still bounded.
  maxEntries: 2_000,
});

/** Drop everything. For tests, so one case cannot leak a verdict into the next. */
export function resetInspectionCache(): void {
  inspections.clear();
}

/**
 * Inspect a URL, or reuse a verdict from this window.
 *
 * The property is part of the key as well as the URL: the same URL can sit under
 * more than one property an Operator holds, and Google's answer is scoped to the
 * property it was asked about.
 *
 * Holding the in-flight promise rather than the resolved value is what makes a
 * bulk inspection that lists one URL twice spend one inspection rather than two.
 */
export function inspectUrlOnce(
  reader: SearchConsoleReader,
  siteUrl: string,
  url: string,
): Promise<UrlInspection> {
  return inspections.run(`${siteUrl} ${url}`, () => reader.inspectUrl(siteUrl, url));
}

/** How many verdicts are held. For tests and for diagnostics. */
export function inspectionCacheSize(): number {
  return inspections.size;
}
