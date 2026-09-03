/**
 * Opening the database, or doing without one.
 *
 * ── The two states, and why the second one is not an error ──
 *
 * The credential-free Tools need nothing persisted. They read a site's public
 * surface and answer, and they are the cold-install on-ramp — an Operator who
 * has configured nothing can still run all eighteen of them. So a server that
 * cannot open a database has to **start anyway**, with caching off and the
 * history Tools refusing per ADR-0003, rather than refusing to boot over
 * infrastructure most of its surface does not use.
 *
 * That is the whole reason this returns a nullable handle instead of throwing.
 *
 * ── Why a no-op rather than a branch ──
 *
 * The alternative shape is `if (db) { … }` at every call site. Twenty of those is
 * twenty chances to forget one, and the one that gets forgotten throws on a
 * cold install — the exact configuration this design exists to protect. So the
 * absence of a database is represented by an object that answers every question
 * with "nothing cached", and callers never ask whether there is one.
 *
 * ── Migrations run at startup ──
 *
 * No manual command, because a command an Operator has to know about is a
 * command they will not run. Drizzle's migrator is idempotent: it records what
 * it has applied in its own table and applies only what is missing, so first run
 * creates every table and every run after it is a no-op.
 */
import BetterSqlite3 from "better-sqlite3";
import { drizzle, type BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { existsSync, mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as schema from "./schema";
import { loadEnvFile } from "../env-file";
import { logError } from "../log";

export type Database = BetterSQLite3Database<typeof schema>;

/**
 * Where the file lives, and the one thing an Operator may point elsewhere.
 *
 * `TSA_DB_PATH` exists for tests and for an Operator whose install directory is
 * read-only. `off` disables persistence outright, which is a real thing to want:
 * it is how you get the credential-free surface and nothing else.
 */
export const DB_PATH_VARIABLE = "TSA_DB_PATH";

/** Relative to the package root, which is what ADR-0001 pins. */
const DEFAULT_DB_FILE = "db/thatseoagent.sqlite";

/** The value of `TSA_DB_PATH` that means "run without persistence". */
export const DB_DISABLED = "off";

/**
 * The package root, found by looking for the migrations rather than by counting
 * directories up from here.
 *
 * Counting is what this did first, and it is wrong for at least one of the two
 * places this module runs from: `src/lib/db/` in the test suite and inside
 * `dist/http.js` in production, where the bundler decides what `import.meta.url`
 * means. Getting it wrong is not loud — `migrate()` throws, `openDatabase()`
 * catches, and the server runs happily with persistence silently off.
 *
 * So it searches for the thing it actually needs. If `drizzle/meta/_journal.json`
 * is not above us, no amount of arithmetic would have found it.
 */
/**
 * Where this module is, in whichever module system it was compiled into.
 *
 * This file ends up in two bundles: the ESM server bundle, where
 * `import.meta.url` is the only answer, and the CommonJS login CLI, where it is
 * `undefined` and `__dirname` is the answer. Reading only one of them worked in
 * one bundle and produced `path` argument must be of type string in the other —
 * caught by `openDatabase()`, reported as "the database could not be opened",
 * with the real cause three frames down in a log nobody reads.
 *
 * `typeof` rather than a direct read, because an undeclared identifier is only
 * safe to touch through it.
 */
function thisDirectory(): string {
  if (typeof __dirname === "string") return __dirname;
  return path.dirname(fileURLToPath(import.meta.url));
}

function packageRoot(): string {
  let dir = thisDirectory();

  for (let hop = 0; hop < 8; hop++) {
    if (existsSync(path.join(dir, "drizzle", "meta", "_journal.json"))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }

  // Nothing found. Returning the last candidate rather than throwing keeps the
  // failure on the path that already reports it: `openDatabase()` will fail to
  // migrate and say the database could not be opened, which is true and is a
  // sentence an Operator can act on.
  return dir;
}

/** Where the database would be, without opening it. Exported for diagnostics. */
function databasePath(): string | null {
  // Through the same loader every other variable goes through, so `.env` is the
  // one file an Operator configures.
  loadEnvFile();
  const configured = process.env[DB_PATH_VARIABLE]?.trim();
  if (configured === DB_DISABLED) return null;
  if (configured) return path.resolve(configured);
  return path.join(packageRoot(), DEFAULT_DB_FILE);
}

export interface OpenDatabase {
  db: Database;
  path: string;
  close(): void;
}

/**
 * Open the database and bring it up to date, or explain why not.
 *
 * The reason is returned rather than thrown for the same purpose the nullable
 * handle serves: the caller's job is to carry on without persistence, and it
 * still needs something to tell an Operator who asks why history is unavailable.
 */
export function openDatabase(): { open: OpenDatabase } | { open: null; reason: string } {
  const file = databasePath();
  if (file === null) {
    return { open: null, reason: `persistence is switched off (${DB_PATH_VARIABLE}=${DB_DISABLED})` };
  }

  try {
    mkdirSync(path.dirname(file), { recursive: true });

    const connection = new BetterSqlite3(file);
    // Foreign keys are OFF by default in SQLite, per connection. Every
    // `references()` in the schema is decoration until this runs — including the
    // `on delete set null` that lets metric history outlive the refresh it came
    // from, which is the one cascade rule the design actually depends on.
    connection.pragma("foreign_keys = ON");
    // WAL so a long read cannot block a write. One process, but a crawl holding a
    // read transaction while a refresh writes is a real shape here.
    connection.pragma("journal_mode = WAL");

    const db = drizzle(connection, { schema });
    migrate(db, { migrationsFolder: path.join(packageRoot(), "drizzle") });

    return { open: { db, path: file, close: () => connection.close() } };
  } catch (error) {
    logError(`open the database at ${file}`, error);
    return {
      open: null,
      // The path, not the driver's message: the path is what an Operator can act
      // on, and the driver's text is not ours to publish.
      reason: `the database at ${file} could not be opened (its error has been logged to stderr)`,
    };
  }
}
