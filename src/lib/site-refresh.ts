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
import { desc, eq } from "drizzle-orm";
import { siteRefreshes, type SiteRefresh } from "./db/schema";
import { now } from "./db/instants";
import { database } from "./db/runtime";
import { logError } from "./log";

/**
 * Close a refresh, whichever way it went.
 *
 * One function for the two closers, because the only thing that differs between
 * them is the status and what else is stored — and what must not differ is what
 * happens when the write cannot be made.
 *
 * ── Why this does not stay silent ──
 *
 * Both closers were `database()?.update(...)`, which swallows. With no database
 * that is right: `startRefresh` returned `null`, so no row was opened and there
 * is nothing to close. But the same expression covers a database that existed
 * when the run began and has gone by the time it ends, and there it leaves
 * exactly the `pending` row this module's header exists to prevent — "how an
 * Operator ends up unable to tell a run that is still going from one that died
 * halfway" — with nothing said about it anywhere.
 *
 * So the caller passes the id it was given. An id means a row was opened, which
 * means there was a database; failing to close it now is an anomaly and goes to
 * stderr. See rule 3 in `db/runtime.ts`.
 */
function closeRefresh(refreshId: string, values: Partial<SiteRefresh>): void {
  const db = database();
  if (!db) {
    logError(
      `close refresh ${refreshId}`,
      new Error(
        "the database was available when this refresh was opened and is not now, so it stays 'pending'",
      ),
    );
    return;
  }

  db.update(siteRefreshes)
    .set({ ...values, completedAt: now(), updatedAt: now() })
    .where(eq(siteRefreshes.id, refreshId))
    .run();
}

/**
 * Open a refresh, or `null` when there is no database.
 *
 * A read-shaped answer for a write, and deliberately: `null` is what tells the
 * caller not to bother closing anything. Rule 2 in `db/runtime.ts`.
 */
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
  closeRefresh(refreshId, { status: "done", contextJson: report });
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
  closeRefresh(refreshId, { status: "failed" });
}

/**
 * A Site's refreshes, newest first.
 *
 * Ordered and limited in SQL. It used to be `.orderBy(startedAt).all()` followed
 * by `.slice(-limit).reverse()`, which read every refresh row the Site has ever
 * had into memory and threw all but twenty away. A function's performance is part
 * of its interface, and that one promised "newest first, limit 20" while doing
 * the opposite of a limit. `page-audits.ts` already did it in SQL.
 *
 * Rule 2 in `db/runtime.ts`: a read answers with its own empty.
 */
export function listRefreshes(siteId: string, limit = 20): SiteRefresh[] {
  const db = database();
  if (!db) return [];

  return db
    .select()
    .from(siteRefreshes)
    .where(eq(siteRefreshes.siteId, siteId))
    .orderBy(desc(siteRefreshes.startedAt))
    .limit(limit)
    .all();
}
