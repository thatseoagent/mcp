/**
 * One run of the Full Report, recorded so the next one can be compared to it.
 *
 * A refresh row exists mainly to give a set of readings something to belong to:
 * `site_metric_history` keys its idempotence on `(refresh_id, metric)`, so
 * re-running an audit against the same refresh corrects the readings rather than
 * appending a second set that would show as a change.
 *
 * It is opened before the work and closed after it, including on failure. A
 * refresh left `pending` forever is how an Operator ends up unable to tell a run
 * that is still going from one that died halfway.
 */
import { eq } from "drizzle-orm";
import { siteRefreshes, type SiteRefresh } from "./db/schema";
import { now } from "./db/instants";
import { database } from "./db/runtime";

/** Open a refresh. Returns `null` when there is no database. */
export function startRefresh(siteId: string): SiteRefresh | null {
  const db = database();
  if (!db) return null;

  const [row] = db
    .insert(siteRefreshes)
    .values({ siteId, status: "pending", startedAt: now(), updatedAt: now() })
    .returning()
    .all();

  return row ?? null;
}

/** Close a refresh, keeping the rendered report so it can be read back. */
export function finishRefresh(refreshId: string, report: string): void {
  database()
    ?.update(siteRefreshes)
    .set({ status: "done", contextJson: report, completedAt: now(), updatedAt: now() })
    .where(eq(siteRefreshes.id, refreshId))
    .run();
}

/**
 * Close a refresh that did not finish.
 *
 * The reason is deliberately *not* stored. A failure message is written for the
 * Operator reading it now, and this column is read back later out of context —
 * where a stale "Google returned HTTP 503" would look like a fact about the
 * Site. The status is what history needs; the sentence goes to the caller.
 */
export function failRefresh(refreshId: string): void {
  database()
    ?.update(siteRefreshes)
    .set({ status: "failed", completedAt: now(), updatedAt: now() })
    .where(eq(siteRefreshes.id, refreshId))
    .run();
}

/** A Site's refreshes, newest first. */
export function listRefreshes(siteId: string, limit = 20): SiteRefresh[] {
  const db = database();
  if (!db) return [];

  return db
    .select()
    .from(siteRefreshes)
    .where(eq(siteRefreshes.siteId, siteId))
    .orderBy(siteRefreshes.startedAt)
    .all()
    .slice(-limit)
    .reverse();
}
