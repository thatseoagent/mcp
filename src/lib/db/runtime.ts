/**
 * The one database this process has, opened once and lazily.
 *
 * Lazy rather than at import time, and that is a testability decision as much as
 * a startup one: `openDatabase()` reads `TSA_DB_PATH` and touches the filesystem,
 * and a module that did that while being imported would have chosen a path
 * before any test could point it somewhere temporary.
 *
 * Once rather than per call, because opening a SQLite connection per Tool
 * invocation would run the migrator on every request and leave a file handle
 * behind each time.
 *
 * The absence of a database is a state, not a failure — see `database.ts`. This
 * module's job is to make that state costless to the caller: {@link toolCache}
 * always returns something usable, so nothing downstream asks whether
 * persistence exists.
 */
import { openDatabase, type Database, type OpenDatabase } from "./database";
import { createToolCache, NO_CACHE, type ToolCache } from "./tool-cache";

interface Persistence {
  open: OpenDatabase | null;
  reason: string | null;
  cache: ToolCache;
}

let persistence: Persistence | null = null;

function resolve(): Persistence {
  if (persistence) return persistence;

  const result = openDatabase();
  persistence = result.open
    ? { open: result.open, reason: null, cache: createToolCache(result.open.db) }
    : { open: null, reason: result.reason, cache: NO_CACHE };

  return persistence;
}

/**
 * The database, or `null` when there is none.
 *
 * Nullable on purpose, and only the Tools that genuinely need persistence should
 * call it — they are the ones ADR-0003 requires to refuse when it is missing.
 * Everything that merely *benefits* from persistence goes through
 * {@link toolCache} and never sees the null.
 *
 * ── What a repository does with the null ──
 *
 * Nineteen `if (!db)` guards across the five repositories returned five different
 * things — `[]`, `null`, `0`, a throw, and a silent no-op — chosen per function
 * with no rule written down. The rule is:
 *
 * 1. **The refusal belongs to the Tool, not the repository.** Every Tool that
 *    needs persistence calls {@link persistenceStatus} first and throws
 *    `NoDatabaseError` with the reason, which is the only message that can name
 *    what to configure. `get_page_audits`, `run_page_audit`, `run_site_audit`,
 *    `seo_metric_trend` and `sync_gsc_properties` all do. So a repository guard
 *    is defence in depth and is not the sentence an Operator reads.
 * 2. **A read answers with its own empty**, because a caller past the Tool's
 *    refusal is asking a question the schema can answer emptily: no Sites, no
 *    audits, no history. `registerSite` is the exception and throws, because
 *    "the Site you asked me to create" has no empty.
 * 3. **A write that cannot happen says so to stderr and returns.** Silence is
 *    right when there was nothing to write — `startRefresh` returned `null`, so
 *    no row was opened — and wrong when a database that existed has gone, which
 *    is how `site-refresh` could leave the `pending` row its own header exists to
 *    prevent. `logError` is the honest middle: the Operator cannot act on it
 *    inline, and the Tool's answer should not change, but it must not vanish.
 *
 * Every guard in the repositories cites this list. A new one has a rule to
 * follow rather than a precedent to pick from.
 */
export function database(): Database | null {
  return resolve().open?.db ?? null;
}

/** The Tool cache. Always usable; a no-op when there is no database. */
export function toolCache(): ToolCache {
  return resolve().cache;
}

/**
 * Whether persistence is available, and if not, what to tell the Operator.
 *
 * The reason is the whole point: a Tool that refuses has to say something more
 * useful than "no database", and the sentence differs between "you switched it
 * off" and "the file could not be opened".
 */
export function persistenceStatus(): { available: boolean; path: string | null; reason: string | null } {
  const state = resolve();
  return {
    available: state.open !== null,
    path: state.open?.path ?? null,
    reason: state.reason,
  };
}

/**
 * Close and forget the database.
 *
 * For tests, so one case cannot leak a connection or a temporary file into the
 * next, and so a test that changes `TSA_DB_PATH` is actually obeyed.
 */
export function resetPersistence(): void {
  persistence?.open?.close();
  persistence = null;
}
