import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import BetterSqlite3 from "better-sqlite3";
import { MCP_URL } from "../../src/lib/server-address";

/**
 * First run creates the database, with no manual command.
 *
 * `tests/e2e/http-server.test.ts` runs the same server with persistence switched
 * off, which is the cold-install claim. This is the other direction: an Operator
 * who has not been told anything about migrations starts the server, and the file
 * and its tables are simply there afterwards.
 *
 * Requires `pnpm build` first; run via `pnpm test:e2e`.
 */

const LAUNCHER = path.resolve(__dirname, "../../scripts/start.mjs");

let server: ChildProcess;
let dir: string;
let dbFile: string;
let stderr = "";
let id = 0;

async function rpc(method: string, params: unknown = {}) {
  const response = await fetch(MCP_URL, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: ++id, method, params }),
  });

  const text = await response.text();
  const data = text
    .split("\n")
    .filter((line) => line.startsWith("data:"))
    .pop()
    ?.slice("data:".length);

  return JSON.parse(data ?? text);
}

beforeAll(async () => {
  dir = mkdtempSync(path.join(tmpdir(), "tsa-e2e-db-"));
  dbFile = path.join(dir, "nested", "thatseoagent.sqlite");

  // Deliberately inside a directory that does not exist yet: an Operator's first
  // run has no `db/` either, and creating the parent is part of "no manual
  // command".
  expect(existsSync(path.dirname(dbFile))).toBe(false);

  server = spawn(process.execPath, [LAUNCHER], {
    env: {
      PATH: process.env.PATH ?? "",
      HOME: process.env.HOME ?? "",
      TSA_DB_PATH: dbFile,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  server.stderr?.on("data", (chunk: Buffer) => (stderr += chunk.toString()));

  const deadline = Date.now() + 20_000;
  for (;;) {
    if (server.exitCode !== null) {
      throw new Error(`server exited with ${server.exitCode}:\n${stderr}`);
    }
    if (Date.now() > deadline) throw new Error(`server never answered:\n${stderr}`);
    try {
      const res = await rpc("initialize", {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "persistence", version: "0" },
      });
      if (res?.result?.serverInfo?.name === "thatseoagent-mcp") return;
    } catch {
      // Not listening yet.
    }
    await new Promise((r) => setTimeout(r, 150));
  }
}, 30_000);

afterAll(() => {
  server?.kill();
  rmSync(dir, { recursive: true, force: true });
});

/** One Tool call over the wire, which is what brings the database into being. */
async function callRobotsValidator() {
  const res = await rpc("tools/call", {
    name: "seo_robots_validator",
    arguments: { url: "https://www.wikipedia.org/" },
  });
  expect(res.error).toBeUndefined();
  expect(res.result.isError).toBeFalsy();
  return res.result.content.map((c: { text: string }) => c.text).join("\n");
}

describe("first run", () => {
  it("creates the database file, and the directory holding it, with no manual command", async () => {
    // The database is opened on first use rather than at boot, which is what
    // lets the credential-free surface run with none at all. So the Tool call
    // comes first: an Operator's first run is a Tool call, not an idle process.
    await callRobotsValidator();

    expect(existsSync(dbFile)).toBe(true);
  }, 30_000);

  it("keeps the Tool's answer, so the next identical call costs the site nothing", async () => {
    const first = await callRobotsValidator();
    const second = await callRobotsValidator();

    expect(second).toBe(first);

    // Read the Operator's own file, rather than trusting that the answer looked
    // the same: two live fetches of a stable robots.txt would also match.
    const db = new BetterSqlite3(dbFile, { readonly: true });
    try {
      const row = db
        .prepare("select tool_name, domain from tool_cache where tool_name = ?")
        .get("seo_robots_validator") as { tool_name: string; domain: string } | undefined;

      expect(row).toBeDefined();
      // The registrable domain, not the hostname: `www.wikipedia.org` and
      // `wikipedia.org` are one Site.
      expect(row!.domain).toBe("wikipedia.org");
    } finally {
      db.close();
    }
  }, 60_000);

  it("says nothing about the database on the way up", () => {
    // A migration that had to complain would be complaining to an Operator who
    // was never told migrations existed.
    expect(stderr).not.toMatch(/could not be opened/);
  });
});
