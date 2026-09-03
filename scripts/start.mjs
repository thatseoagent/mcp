#!/usr/bin/env node
/**
 * The server's entry point, and the one place that refuses a busy port.
 *
 * ── Why this exists ──
 *
 * xmcp does not fail when its port is taken. It increments — `Port 3737 is in
 * use, trying 3738 instead.` — and serves happily from the new one. The
 * listening address is compiled into the bundle, so an MCP client is configured
 * with a URL that no longer points anywhere. The symptom is a connection refused
 * on the client with a perfectly healthy server running beside it, and nothing
 * on either side connects the two. Picking an unpopular port lowers the odds and
 * fixes nothing.
 *
 * ── Two checks, because one is not enough ──
 *
 * **Before**: bind the port ourselves. If that fails, nothing has started yet
 * and we can name the port and say what holds it.
 *
 * **After**: try to bind it again. This reads backwards and is the important
 * half — once our own server is listening the bind must *fail*, so a bind that
 * *succeeds* means the port is free, which means the server went somewhere else.
 * That is the exact failure the "before" check cannot see: the tiny window
 * between releasing our probe and xmcp claiming the port, where a racing process
 * gets there first. No polling of the MCP endpoint, no HTTP client, no
 * dependency — the operating system already knows the answer.
 *
 * Plain `.mjs`, run straight from disk rather than built, because a launcher
 * that has to be compiled before it can guard the compiled artifact is a
 * launcher that cannot run on a fresh clone.
 */
import { createServer } from "node:net";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/**
 * The same file the bundle was built from. A second copy of the port here is the
 * copy that eventually disagrees with the build, which produces this very bug.
 */
const { host, port, endpoint } = require(path.join(root, "src/lib/server-address.json"));

/** How long the listener is given to claim the port before we call it a failure. */
const STARTUP_GRACE_MS = 5_000;

/**
 * Is the port free right now?
 *
 * `exclusive` so the check means what it says: without it, Node's cluster-aware
 * default can share a listening socket and report free a port that is in use.
 */
function portIsFree() {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once("error", (error) => {
      if (error.code === "EADDRINUSE" || error.code === "EACCES") resolve(false);
      else reject(error);
    });
    probe.listen({ host, port, exclusive: true }, () => {
      probe.close(() => resolve(true));
    });
  });
}

/**
 * What is holding the port, in the words an Operator can act on.
 *
 * Best-effort by design: `lsof` is not everywhere and may need privileges we do
 * not have. A refusal that names the port is already actionable, so a failure to
 * identify the holder must not become a failure to report the conflict.
 */
function describeHolder() {
  try {
    const pids = execFileSync("lsof", ["-nP", `-iTCP@${host}:${port}`, "-sTCP:LISTEN", "-t"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    })
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean);

    if (pids.length === 0) return null;

    return pids
      .map((pid) => {
        try {
          const command = execFileSync("ps", ["-p", pid, "-o", "comm="], {
            encoding: "utf8",
            stdio: ["ignore", "pipe", "ignore"],
          }).trim();
          return command ? `${command} (pid ${pid})` : `pid ${pid}`;
        } catch {
          return `pid ${pid}`;
        }
      })
      .join(", ");
  } catch {
    return null;
  }
}

function refuse(lines) {
  for (const line of lines) process.stderr.write(`${line}\n`);
  process.exit(1);
}

if (!(await portIsFree())) {
  const holder = describeHolder();
  refuse([
    `Port ${port} on ${host} is already in use, so this server will not start.`,
    holder
      ? `It is held by: ${holder}.`
      : `Could not identify what holds it. Try: lsof -nP -iTCP:${port} -sTCP:LISTEN`,
    "",
    `The address is compiled into the build, so starting on a different port would`,
    `leave your MCP client pointed at http://${host}:${port}${endpoint} with nothing`,
    `serving it. Stop whatever holds the port, or change it in`,
    `src/lib/server-address.json and rebuild.`,
  ]);
}

const bundle = path.join(root, "dist/http.js");

// Checked rather than left to `import`, which fails with a bare
// `MODULE_NOT_FOUND` stack that says nothing about what to do. There are only
// two ways to get here and both have a one-line fix, so both are named.
//
// The second one is the surprising one: `xmcp dev` owns `dist/` too. It clears
// the directory and rewrites it on every change, so a `pnpm start` racing a
// watcher finds nothing — and the two would fight over the port even if it
// didn't.
if (!existsSync(bundle)) {
  refuse([
    `There is no build to run: ${path.relative(root, bundle)} does not exist.`,
    "",
    "Run `pnpm build` first.",
    "",
    "If you already did, check whether `pnpm dev` is running in another terminal —",
    "it owns dist/ as well and rewrites it on every change, so the two cannot run",
    "at the same time. Use one or the other.",
  ]);
}

await import(bundle);

// The "after" check. Deliberately not awaited before the process is considered
// up: the bundle has to be given time to bind, and exiting the moment it has not
// yet done so would refuse every normal start.
const deadline = Date.now() + STARTUP_GRACE_MS;
for (;;) {
  if (!(await portIsFree())) break; // Ours. This is the success case.

  if (Date.now() > deadline) {
    refuse([
      `The server did not claim port ${port} within ${STARTUP_GRACE_MS / 1000}s.`,
      "",
      `Something took the port between the check above and the listener starting,`,
      `and xmcp responds to that by moving to the next port rather than failing —`,
      `so this process may be serving on ${port + 1} while your client is`,
      `configured for http://${host}:${port}${endpoint}. Refusing to run in that`,
      `state, because a client cannot detect it.`,
    ]);
  }
  await new Promise((resolve) => setTimeout(resolve, 100));
}
