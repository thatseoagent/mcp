import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { resetPersistence } from "@/lib/db/runtime";

/**
 * A real SQLite database on a real temporary file, migrated, for one test.
 *
 * Real rather than mocked, because what these tests are actually checking is the
 * behaviour of the schema: a unique index, a cascade, an `on conflict` clause,
 * an expiry comparison. A mocked query builder asserts that we called it the way
 * we meant to and says nothing about whether SQLite agrees — which is precisely
 * where a dialect port goes wrong.
 *
 * A file rather than `:memory:` for the same reason one layer up: the migrator
 * runs against a file on an Operator's disk, and "does first run create the
 * database" is a question `:memory:` cannot answer.
 */
export function useTempDatabase(): { dir: string; path: string; dispose(): void } {
  const dir = mkdtempSync(path.join(tmpdir(), "tsa-db-"));
  const file = path.join(dir, "test.sqlite");

  process.env.TSA_DB_PATH = file;
  // Any database opened earlier in this process was opened against a different
  // path. Forgetting this is how a test passes while writing to its neighbour's
  // file.
  resetPersistence();

  return {
    dir,
    path: file,
    dispose() {
      resetPersistence();
      delete process.env.TSA_DB_PATH;
      rmSync(dir, { recursive: true, force: true });
    },
  };
}
