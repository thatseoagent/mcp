import { describe, it, expect, afterEach } from "vitest";
import { existsSync } from "node:fs";
import { getTableColumns, getTableName, is, sql } from "drizzle-orm";
import { SQLiteTable } from "drizzle-orm/sqlite-core";
import { database, persistenceStatus, resetPersistence } from "@/lib/db/runtime";
import { DB_DISABLED, DB_PATH_VARIABLE } from "@/lib/db/database";
import * as schema from "@/lib/db/schema";
import { sites } from "@/lib/db/schema";
import { now } from "@/lib/db/instants";
import { useTempDatabase } from "../../helpers/temp-database";

let temp: ReturnType<typeof useTempDatabase> | null = null;

afterEach(() => {
  temp?.dispose();
  temp = null;
  delete process.env[DB_PATH_VARIABLE];
  resetPersistence();
});

/**
 * Every column the schema declares, read off the schema itself.
 *
 * Derived rather than listed by hand, so adding a field to `schema.ts` extends
 * this check automatically instead of needing a second edit here that whoever
 * added the field would not think to make.
 */
const DECLARED_COLUMNS: Record<string, string[]> = (() => {
  const declared: Record<string, string[]> = {};
  for (const exported of Object.values(schema)) {
    // `is()` does the narrowing. A hand-written type predicate cannot: the table
    // type is generic, and a predicate naming the unparameterised form is not
    // assignable to it.
    if (!is(exported, SQLiteTable)) continue;
    declared[getTableName(exported)] = Object.values(getTableColumns(exported)).map(
      (column) => column.name,
    );
  }
  return declared;
})();

/** Every table the schema declares. A migration that misses one is the bug. */
const TABLES = [
  "sites",
  "site_refreshes",
  "site_metric_history",
  "site_metric_monthly",
  "page_audits",
  "tool_cache",
  "configuration",
];

describe("opening the database", () => {
  it("creates the file and applies migrations on first run, with no manual command", () => {
    temp = useTempDatabase();

    expect(existsSync(temp.path)).toBe(false);

    const db = database();

    expect(db).not.toBeNull();
    expect(existsSync(temp.path)).toBe(true);
  });

  it("creates all seven tables", () => {
    temp = useTempDatabase();
    const db = database()!;

    const rows = db.all<{ name: string }>(
      sql`select name from sqlite_master where type = 'table'`,
    );
    const names = rows.map((row) => row.name);

    for (const table of TABLES) expect(names).toContain(table);
  });

  it("is idempotent: opening an existing database applies nothing and loses nothing", () => {
    temp = useTempDatabase();

    database()!
      .insert(sites)
      .values({
        domain: "example.com",
        registrableDomain: "example.com",
        createdAt: now(),
        updatedAt: now(),
      })
      .run();

    // A second open of the same file, as every restart after the first is.
    resetPersistence();
    const rows = database()!.select().from(sites).all();

    expect(rows).toHaveLength(1);
    expect(rows[0].domain).toBe("example.com");
  });

  it("enforces foreign keys, which SQLite does not do by default", () => {
    // Every `references()` in the schema is decoration until the pragma runs,
    // including the `on delete set null` that lets metric history outlive the
    // refresh it came from.
    temp = useTempDatabase();
    const db = database()!;

    const [enabled] = db.all<{ foreign_keys: number }>(sql`pragma foreign_keys`);

    expect(enabled.foreign_keys).toBe(1);
  });

  it("starts without a database when persistence is switched off", () => {
    process.env[DB_PATH_VARIABLE] = DB_DISABLED;
    resetPersistence();

    expect(database()).toBeNull();
  });

  it("says why persistence is unavailable, not just that it is", () => {
    // A Tool that refuses has to tell the Operator something they can act on,
    // and "you switched it off" is a different sentence from "the file could not
    // be opened".
    process.env[DB_PATH_VARIABLE] = DB_DISABLED;
    resetPersistence();

    const status = persistenceStatus();

    expect(status.available).toBe(false);
    expect(status.reason).toContain(DB_PATH_VARIABLE);
  });

  it("reports availability and the path when there is one", () => {
    temp = useTempDatabase();
    database();

    const status = persistenceStatus();

    expect(status.available).toBe(true);
    expect(status.path).toBe(temp.path);
    expect(status.reason).toBeNull();
  });
});

describe("the migration and the schema agree", () => {
  it("has a column for every field the schema declares", () => {
    // The one drift this layout allows. `drizzle/` is generated from
    // `schema.ts` by a command a person has to remember to run, so a schema edit
    // committed without regenerating leaves the code expecting a column the
    // database does not have — and the failure surfaces at runtime, on an
    // Operator's machine, as a SQL error inside a Tool. This is the test that
    // fails instead. If it goes red, run `pnpm db:generate`.
    temp = useTempDatabase();
    const db = database()!;

    for (const [table, columns] of Object.entries(DECLARED_COLUMNS)) {
      const actual = db
        .all<{ name: string }>(sql.raw(`pragma table_info(${table})`))
        .map((row) => row.name);

      for (const column of columns) {
        expect(actual, `${table}.${column}`).toContain(column);
      }
    }
  });
});

describe("one instant encoding", () => {
  it("stores every instant as integer milliseconds", () => {
    // The dialect port's load-bearing decision. A column that quietly took an
    // ISO string instead would sort wrong against its neighbours and compare a
    // string to a number across tables.
    temp = useTempDatabase();
    const db = database()!;
    const when = new Date("2026-01-02T03:04:05.678Z");

    db.insert(sites)
      .values({
        domain: "example.com",
        registrableDomain: "example.com",
        createdAt: when,
        updatedAt: when,
      })
      .run();

    const [raw] = db.all<{ created_at: unknown }>(sql`select created_at from sites`);

    expect(typeof raw.created_at).toBe("number");
    expect(raw.created_at).toBe(when.getTime());
    // And round-trips as a Date, so no caller has to know the encoding.
    expect(db.select().from(sites).all()[0].createdAt).toEqual(when);
  });

  it("uses the same encoding in the table that carries a default", () => {
    // `configuration.updated_at` defaults in SQL rather than in JavaScript, which
    // is the one place a second convention could enter without anyone noticing.
    temp = useTempDatabase();
    const db = database()!;

    db.run(sql`insert into configuration (key, value) values ('probe', 'x')`);
    const [row] = db.all<{ updated_at: unknown }>(
      sql`select updated_at from configuration where key = 'probe'`,
    );

    expect(typeof row.updated_at).toBe("number");
    // Milliseconds, not seconds: a seconds value would land in 1970 when read
    // back as milliseconds, which is the failure this asserts against.
    expect(row.updated_at as number).toBeGreaterThan(Date.parse("2020-01-01"));
  });
});
