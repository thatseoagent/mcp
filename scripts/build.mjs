/**
 * `xmcp build` wrapped so a compile error fails the command.
 *
 * The bundler reports errors and then exits 0, writing `dist/http.js` anyway. A
 * `TS2339` in the SSRF guard reached the built artifact that way and nothing
 * anywhere went red — not the build, not `tsc --noEmit` (which resolves a
 * different lib set), not `test:e2e`, whose `pnpm build && …` saw a zero and
 * carried on.
 *
 * Synchronous because there is no reason not to be, not as a fix for anything.
 * Worth saying because the history suggests otherwise: this was rewritten twice
 * chasing a flake where `dist/http.js` appeared and vanished a few hundred
 * milliseconds later, failing about one run in three. Neither rewrite helped,
 * because the cause was outside this file — a leftover `xmcp dev` watcher whose
 * rebuild wipes `dist/`. If the flake comes back, look for stray watchers with
 * `ps aux | grep xmcp` before touching this script again.
 *
 * Delete this once xmcp exits non-zero on its own.
 */
import { spawnSync } from "node:child_process";
import { build as esbuild } from "esbuild";
import { writeHomePage } from "./build-home-page.mjs";
import { fileURLToPath } from "node:url";
import { existsSync } from "node:fs";
import path from "node:path";

// The local bin directly, not via a shell: resolving "xmcp" against the caller's
// PATH finds nothing, and "command not found" is not the failure this reports.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const bin = path.join(root, "node_modules", ".bin", "xmcp");

// Before the bundler, because `xmcp.config.ts` names `src/home.html` as the page
// to serve at `/` and cannot generate it itself — it is compiled in a sandbox
// with no `node:fs`. Committed as well as generated, like `drizzle/`, so the
// path always resolves on a fresh clone.
writeHomePage();

const result = spawnSync(bin, ["build"], { cwd: root, encoding: "utf8" });

/**
 * The login command, bundled separately.
 *
 * xmcp builds one thing — the MCP server — so the CLI needs its own step. It is
 * TypeScript for the same reason everything else is: it shares `required-config`,
 * the schema, the token store and the scope descriptions with the server, and a
 * plain-JavaScript copy of any of those would be a second source of truth for a
 * credential path.
 *
 * `better-sqlite3` is external here for the reason `xmcp.config.ts` records: it
 * is a native module and bundling it breaks its own binding lookup.
 */
async function buildLoginCommand() {
  await esbuild({
    entryPoints: [path.join(root, "src/cli/login.ts")],
    outfile: path.join(root, "dist/login.cjs"),
    bundle: true,
    platform: "node",
    target: "node24",
    // CommonJS, and the `.cjs` extension so Node does not have to guess. ESM
    // output turns `require("better-sqlite3")` into esbuild's shim, which throws
    // `Dynamic require ... is not supported` — the native module cannot be
    // bundled and cannot be imported as ESM either, so the bundle around it has
    // to be CommonJS.
    format: "cjs",
    external: ["better-sqlite3"],
    banner: { js: "#!/usr/bin/env node" },
    logLevel: "silent",
  });
}

const output = (result.stdout ?? "") + (result.stderr ?? "");
process.stderr.write(output);

let cliError = null;
try {
  await buildLoginCommand();
} catch (error) {
  cliError = error;
}

if (cliError) {
  process.stderr.write(`\nCould not build the login command: ${cliError.message ?? cliError}\n`);
  process.exitCode = 1;
} else if (result.error) {
  process.stderr.write(`\nCould not run the bundler: ${result.error.message}\n`);
  process.exitCode = 1;
} else if (result.status) {
  process.exitCode = result.status;
} else {
  // The bundler colours its summary, so "compiled with 1 error" arrives as
  // "compiled with \x1b[1m\x1b[31m1 error". Strip the escapes before matching.
  // eslint-disable-next-line no-control-regex
  const plain = output.replace(/\x1b\[[0-9;]*m/g, "");

  if (/compiled with \d+ error/i.test(plain)) {
    process.stderr.write("\nBuild reported compile errors; failing despite exit code 0.\n");
    process.exitCode = 1;
  } else if (!existsSync(path.join(root, "dist", "http.js"))) {
    // The exact file, not "some .js": a stale artifact from an earlier build
    // satisfies a looser check even when this build wrote nothing.
    process.stderr.write("\nBuild finished but wrote no dist/http.js.\n");
    process.exitCode = 1;
  }
}
