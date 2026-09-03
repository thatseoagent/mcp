/**
 * The `.env` file, loaded once, wherever configuration is read from.
 *
 * ── Why a file rather than `export` ──
 *
 * Every variable this server reads is set once and then wanted by more than one
 * process: the server, the login command, and whatever terminal the Operator
 * happens to be in. `export` scopes them to a single shell, so the natural
 * sequence — export in one window, `pnpm login` there, then start the server in
 * another — leaves the server without them, and the failure looks like the login
 * not having worked. A file is the same configuration for every process that
 * reads it, and it survives closing the terminal.
 *
 * ── The shell still wins ──
 *
 * `process.loadEnvFile` does not overwrite a variable that is already set, and
 * that precedence is the right way round: a one-off
 * `GOOGLE_CLIENT_ID=… pnpm login` has to beat the file, or there is no way to try
 * a second account without editing your configuration and putting it back.
 *
 * ── Node's own loader, not a dependency and not a parser ──
 *
 * `process.loadEnvFile` has been built in since Node 20.12 and this package
 * requires 24, so there is nothing to install and no quoting rules of our own to
 * get subtly wrong.
 *
 * ── Read at most once ──
 *
 * Memoized, so a hundred `requireConfig` calls cost one `stat`. The consequence
 * is that editing `.env` needs a restart, which is true of `export` as well and
 * is the honest behaviour for a file that is read to configure a process.
 */
import { logError } from "./log";

/**
 * Which file to read, and how to switch it off.
 *
 * `off` mirrors `TSA_DB_PATH=off`: this repository's way of saying "run without
 * that". The test suite sets it, because a developer with real credentials in
 * `.env` would otherwise have them leak into tests that assert a variable is
 * *not* set — those would pass on CI and fail on the one machine that has the
 * file.
 */
export const ENV_FILE_VARIABLE = "TSA_ENV_FILE";

/** The value of {@link ENV_FILE_VARIABLE} that means "read no file". */
export const ENV_FILE_DISABLED = "off";

/** Where the file lives when nobody says otherwise. */
export const DEFAULT_ENV_FILE = ".env";

let loaded = false;

/**
 * Load `.env` into `process.env`, once.
 *
 * A missing file is the ordinary case — the whole credential-free surface needs
 * no configuration at all — so it is silent. Anything else is logged and
 * swallowed: a malformed `.env` should leave the Operator with the refusal that
 * names the variable they meant to set, not with a server that will not start.
 */
export function loadEnvFile(): void {
  if (loaded) return;
  loaded = true;

  const configured = process.env[ENV_FILE_VARIABLE]?.trim();
  if (configured === ENV_FILE_DISABLED) return;

  try {
    process.loadEnvFile(configured || DEFAULT_ENV_FILE);
  } catch (error) {
    // ENOENT means there is no file, which is not a problem to report.
    if ((error as NodeJS.ErrnoException)?.code === "ENOENT") return;
    logError(`read ${configured || DEFAULT_ENV_FILE}`, error);
  }
}

/**
 * Forget that the file was read. For tests.
 *
 * `loaded` is module state, so a case that points `TSA_ENV_FILE` at its own
 * temporary file has to clear it or `loadEnvFile()` returns without reading.
 * `env-file.test.ts` calls this four times.
 */
export function resetEnvFile(): void {
  loaded = false;
}
