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
