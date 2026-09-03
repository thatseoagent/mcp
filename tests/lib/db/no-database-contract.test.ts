import { describe, it, expect, afterEach, vi } from "vitest";
import { listSites, findSite, registerSite, rememberGoogleProperty, NoDatabaseError } from "@/lib/sites";
import { startRefresh, finishRefresh, failRefresh, listRefreshes } from "@/lib/site-refresh";
import { readConfiguration, writeConfiguration } from "@/lib/db/configuration";
import { readMonths, readSeries, metricsWithHistory } from "@/lib/metric-history";
import { listPageAudits, findPageAudit, savePageAudit } from "@/lib/page-audits";
import { resetPersistence } from "@/lib/db/runtime";
import { DB_PATH_VARIABLE } from "@/lib/db/database";
import { useTempDatabase } from "../../helpers/temp-database";

/**
 * The invariant this file exists to keep: **what a repository does with no
 * database is a stated rule, not a precedent.**
 *
 * Nineteen `if (!db)` guards across five repositories returned five different
 * things — `[]`, `null`, `0`, a throw, and a silent no-op — chosen per function.
 * Every branch was on the default path of this suite, which runs with
 * `TSA_DB_PATH=off`, and not one of them was asserted: the tests that care about
 * persistence all opt in with `useTempDatabase()`.
 *
 * `db/runtime.ts` now states the rule in three parts and every guard cites it.
 * This is the table-driven test that was nineteen untested branches.
 */

afterEach(() => {
  delete process.env[DB_PATH_VARIABLE];
  resetPersistence();
  vi.restoreAllMocks();
});

/** The suite's default: no database at all. */
function withNoDatabase(): void {
  process.env[DB_PATH_VARIABLE] = "off";
  resetPersistence();
}

describe("rule 1 — the refusal belongs to the Tool", () => {
  it("names what to configure, which is the only message that can", () => {
    const error = new NoDatabaseError("TSA_DB_PATH is off");

    // A repository guard cannot say this: it does not know the reason, which is
    // what `persistenceStatus()` carries and what the Tools print.
    expect(error.message).toContain("TSA_DB_PATH is off");
    expect(error.message).toContain("needs the server's database");
    // And it points at the surface that still works, because the commonest cause
    // is an Operator who has configured nothing yet.
    expect(error.message).toContain("seo_analyze_page");
  });

  it("is what every persistence Tool throws before reaching a repository", async () => {
    // Pinned by shape rather than by calling five Tools: each imports both
    // `persistenceStatus` and `NoDatabaseError`, and a Tool that reaches a
    // repository without them is the gap this rule exists to close.
    const { readFileSync } = await import("node:fs");
    const path = await import("node:path");

    const REPOSITORY_CALLS =
      /\b(listSites|findSite|registerSite|rememberGoogleProperty|readMonths|metricsWithHistory|startRefresh|listPageAudits|findPageAudit|savePageAudit)\b/;

    const tools = [
      "get-page-audits",
      "run-page-audit",
      "run-site-audit",
      "seo-metric-trend",
      "sync-gsc-properties",
    ];

    for (const tool of tools) {
      const source = readFileSync(
        path.join(process.cwd(), "src/tools", `${tool}.ts`),
        "utf8",
      );
      expect(REPOSITORY_CALLS.test(source), tool).toBe(true);
      expect(source, tool).toContain("persistenceStatus");
      expect(source, tool).toContain("NoDatabaseError");
    }
  });
});

describe("rule 2 — a read answers with its own empty", () => {
  const reads: Array<[string, () => unknown, unknown]> = [
    ["listSites", () => listSites(), []],
    ["findSite", () => findSite("example.com"), null],
    ["listRefreshes", () => listRefreshes("site-1"), []],
    ["readConfiguration", () => readConfiguration("google.tokens"), null],
    ["readMonths", () => readMonths("site-1"), []],
    ["readSeries", () => readSeries("site-1", "clicks"), []],
    ["metricsWithHistory", () => metricsWithHistory("site-1"), []],
    ["listPageAudits", () => listPageAudits("site-1"), []],
    ["findPageAudit", () => findPageAudit("site-1", "https://example.com/"), null],
  ];

  for (const [name, read, expected] of reads) {
    it(`${name} answers empty rather than throwing`, () => {
      withNoDatabase();

      expect(read()).toEqual(expected);
    });
  }

  it("registerSite is the exception, because creation has no empty", () => {
    withNoDatabase();

    // "The Site you asked me to create" cannot come back as `null` meaning
    // anything a caller could use.
    expect(() => registerSite("example.com")).toThrow(NoDatabaseError);
  });

  it("startRefresh answers `null`, which is what tells the caller not to close", () => {
    withNoDatabase();

    expect(startRefresh("site-1")).toBeNull();
  });
});

describe("rule 3 — a write that cannot happen says so", () => {
  it("stays silent where there was nothing to write", () => {
    withNoDatabase();
    const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);

    // No Site row to attach a property to, and no previous audit to compare
    // against, so in both cases nothing was lost and nothing is owed.
    expect(() => rememberGoogleProperty("example.com", { ga4PropertyId: "1" })).not.toThrow();
    expect(savePageAudit("site-1", "https://example.com/", "a report")).toEqual({
      previous: null,
    });
    expect(stderr).not.toHaveBeenCalled();
  });

  it("says something when a refresh cannot be closed", () => {
    withNoDatabase();
    const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);

    // An id means a row was opened, which means there was a database. Failing to
    // close it now leaves the `pending` row this module's header exists to
    // prevent, and both closers used to swallow it.
    finishRefresh("refresh-1", "a report");
    failRefresh("refresh-2");

    expect(stderr).toHaveBeenCalledTimes(2);
    const written = stderr.mock.calls.map((call) => String(call[0])).join("\n");
    expect(written).toContain("refresh-1");
    expect(written).toContain("pending");
  });

  it("tells a caller whether a config write was kept", () => {
    withNoDatabase();

    expect(writeConfiguration("google.tokens", "{}")).toBe(false);
  });
});

describe("with a database, the same functions do the work", () => {
  let temp: ReturnType<typeof useTempDatabase> | null = null;

  afterEach(() => {
    temp?.dispose();
    temp = null;
  });

  it("keeps a Site, and finds it again", () => {
    temp = useTempDatabase();

    const site = registerSite("example.com");

    expect(findSite("example.com")).toMatchObject({ id: site.id });
    expect(listSites()).toHaveLength(1);
  });

  it("orders and limits refreshes in SQL, newest first", () => {
    temp = useTempDatabase();
    const site = registerSite("example.com");

    const opened = [
      startRefresh(site.id),
      startRefresh(site.id),
      startRefresh(site.id),
    ];
    expect(opened.every((row) => row !== null)).toBe(true);

    const recent = listRefreshes(site.id, 2);

    // Two rows, newest first. This used to read every refresh the Site had ever
    // had into memory and throw all but `limit` away — a function's performance
    // is part of its interface, and that one promised a limit while doing the
    // opposite of one.
    expect(recent).toHaveLength(2);
    expect(recent[0].id).toBe(opened[2]!.id);
    expect(recent[1].id).toBe(opened[1]!.id);
  });

  it("closes a refresh without a word to stderr", () => {
    temp = useTempDatabase();
    const site = registerSite("example.com");
    const refresh = startRefresh(site.id)!;
    const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);

    finishRefresh(refresh.id, "a report");

    expect(stderr).not.toHaveBeenCalled();
    expect(listRefreshes(site.id)[0]).toMatchObject({ status: "done" });
  });
});
