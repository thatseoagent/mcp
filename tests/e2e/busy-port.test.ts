import { describe, it, expect, afterEach } from "vitest";
import { spawn } from "node:child_process";
import { createServer, type Server } from "node:net";
import { existsSync, renameSync } from "node:fs";
import path from "node:path";
import { HTTP_HOST, HTTP_PORT } from "../../src/lib/server-address";

/**
 * What an Operator meets when something else already holds the port.
 *
 * xmcp answers a busy port by incrementing and serving from the next one, which
 * leaves the client configured for an address nothing is listening on — a
 * connection refused beside a perfectly healthy server, with nothing to connect
 * the two. This asserts the launcher refuses instead.
 *
 * Requires `pnpm build` first; run via `pnpm test:e2e`.
 */

const LAUNCHER = path.resolve(__dirname, "../../scripts/start.mjs");

let squatter: Server | null = null;

afterEach(async () => {
  if (squatter) {
    await new Promise((resolve) => squatter!.close(resolve));
    squatter = null;
  }
});

/** Hold the port the server wants, the way any other process would. */
function occupyPort(): Promise<void> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen({ host: HTTP_HOST, port: HTTP_PORT, exclusive: true }, () => {
      squatter = server;
      resolve();
    });
  });
}

/** Run the launcher to completion, collecting what it said and how it exited. */
function runLauncher(): Promise<{ code: number | null; stderr: string; stdout: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [LAUNCHER], {
      env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "" },
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stderr = "";
    let stdout = "";
    child.stderr?.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
    child.stdout?.on("data", (chunk: Buffer) => (stdout += chunk.toString()));

    // A launcher that started successfully would never exit, so a timeout here
    // is itself the failure: it means the refusal did not happen.
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`launcher did not exit; it started anyway.\n${stderr}${stdout}`));
    }, 15_000);

    child.on("error", reject);
    child.on("exit", (code) => {
      clearTimeout(timer);
      resolve({ code, stderr, stdout });
    });
  });
}

describe("starting with no build", () => {
  it("says what to run instead of throwing a module-resolution stack", async () => {
    // The bare `MODULE_NOT_FOUND` this replaces names a path and nothing to do
    // about it. There are two ways to reach it and both have a one-line fix.
    const dist = path.resolve(__dirname, "../../dist/http.js");
    const moved = `${dist}.moved-by-test`;

    renameSync(dist, moved);
    try {
      const { code, stderr } = await runLauncher();

      expect(code).toBe(1);
      expect(stderr).toContain("There is no build to run");
      expect(stderr).toContain("pnpm build");
      // And the surprising cause, which is the one worth naming.
      expect(stderr).toContain("pnpm dev");
    } finally {
      renameSync(moved, dist);
    }
  });
});

describe("starting on a port that is already taken", () => {
  it("refuses, naming the port and what holds it", async () => {
    if (!existsSync(path.resolve(__dirname, "../../dist/http.js"))) {
      throw new Error("Build first: dist/http.js does not exist");
    }

    await occupyPort();

    const { code, stderr } = await runLauncher();

    expect(code).toBe(1);
    expect(stderr).toContain(`Port ${HTTP_PORT}`);
    expect(stderr).toContain("already in use");
    // Either the holder is named, or the command that names it is offered —
    // `lsof` is not on every machine, and failing to identify the holder must
    // not become a failure to report the conflict.
    expect(stderr).toMatch(/It is held by:|lsof -nP/);
  });

  it("says why moving to another port would not have helped", async () => {
    // The reasoning matters more than the refusal: an Operator who does not know
    // the address is compiled in will assume the server can just be told to use
    // a different one.
    await occupyPort();

    const { stderr } = await runLauncher();

    expect(stderr).toContain("compiled into the build");
    expect(stderr).toContain("src/lib/server-address.json");
  });

  it("never starts a listener the client could not reach", async () => {
    await occupyPort();

    const { code } = await runLauncher();

    // The squatter still holds the port and the launcher is gone, so nothing of
    // ours is listening anywhere. The failure being ruled out is a live server
    // on HTTP_PORT + 1.
    expect(code).toBe(1);
    await expect(
      fetch(`http://${HTTP_HOST}:${HTTP_PORT + 1}/mcp`, { method: "POST" }),
    ).rejects.toThrow();
  });
});
