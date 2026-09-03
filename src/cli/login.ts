/**
 * `thatseoagent-mcp-login` — the command an Operator runs once.
 *
 * Prints what is about to be asked for and why, opens the browser, receives
 * Google's redirect on an ephemeral loopback port, stores the tokens, and stops
 * listening. From then on the server refreshes internally and the Operator does
 * not come back here.
 *
 * ── Order of the checks ──
 *
 * The database is checked **before** the browser opens, and that ordering is the
 * whole point of doing it explicitly: an Operator who has just granted a
 * third-party program read access to their search and analytics data, and is
 * then told the tokens could not be saved, has been made to give away something
 * for nothing. The same goes for the client credentials — a consent screen that
 * cannot complete its token exchange is worse than never opening.
 *
 * ── Where the credentials come from ──
 *
 * `.env`, through the same loader the server uses. That is the whole point of
 * the file: this command and the server are different processes, usually started
 * from different terminals, and `export` reaches only the one you typed it in.
 * The failure that produces looks like the login not having worked.
 *
 * ── Nothing here prints a token ──
 *
 * Not the refresh token, not the access token, not a prefix of either, not a
 * "token set: true". The output says which account state changed and nothing
 * about its contents.
 */
import { spawn } from "node:child_process";
import { persistenceStatus } from "../lib/db/runtime";
import { describeScopes } from "../lib/google/scopes";
import { awaitConsent, exchangeCode } from "../lib/google/login-flow";
import { consentUrl, createOAuthClient, GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET } from "../lib/google/oauth";
import { readTokens, writeTokens } from "../lib/google/tokens";
import { requireConfig } from "../lib/required-config";

function say(...lines: string[]): void {
  for (const line of lines) process.stdout.write(`${line}\n`);
}

/**
 * Open the Operator's browser, or tell them to.
 *
 * Best-effort: a headless machine, an SSH session or a locked-down desktop all
 * fail here, and none of them is a reason to abandon the login. The URL is
 * always printed, so a failure to launch degrades to copy-and-paste rather than
 * to a dead end.
 */
function openBrowser(url: string): void {
  const command =
    process.platform === "darwin" ? "open" : process.platform === "win32" ? "start" : "xdg-open";
  try {
    const child = spawn(command, [url], {
      stdio: "ignore",
      detached: true,
      shell: process.platform === "win32",
    });
    child.on("error", () => {});
    child.unref();
  } catch {
    // Printed below regardless.
  }
}

async function main(): Promise<void> {
  say("", "=== That SEO Agent: Google login ===", "");

  // 1. Somewhere to put the tokens.
  const status = persistenceStatus();
  if (!status.available) {
    throw new Error(
      `There is nowhere to store the login: ${status.reason}. ` +
        `Tokens live in the server's database, so this command cannot run without one. ` +
        `Remove TSA_DB_PATH from your .env to use the default under db/, or point it ` +
        `at a writable file.`,
    );
  }

  // 2. Credentials to log in *with*. `requireConfig` throws a message naming the
  //    variable and the Desktop-app client type, which is the one setup mistake
  //    that produces a confusing Google error page later.
  requireConfig(GOOGLE_CLIENT_ID);
  requireConfig(GOOGLE_CLIENT_SECRET);

  const replacing = readTokens() !== null;
  if (replacing) {
    say(
      "This server already has a Google login. Completing this one replaces it,",
      "which is how you switch accounts — the browser will ask which account to use.",
      "",
    );
  }

  say(...describeScopes(), "");

  const listener = await awaitConsent();
  try {
    const client = createOAuthClient(listener.redirectUri);
    const url = consentUrl(client, listener.state);

    say("Opening your browser. If nothing happens, open this URL yourself:", "", `  ${url}`, "");
    openBrowser(url);
    say("Waiting for you to authorize...");

    const code = await listener.code;
    const tokens = await exchangeCode(client, code);

    // Written before anything is reported as done. `writeTokens` returns false
    // only if the database vanished between the check above and now, which is
    // unlikely and still not something to report as a success.
    if (!writeTokens(tokens)) {
      throw new Error("The tokens could not be written to the database, so nothing was saved.");
    }

    say(
      "",
      replacing ? "Logged in. The previous login has been replaced." : "Logged in.",
      "",
      "The Search Console and Analytics Tools will work from now on; the server refreshes",
      "this access on its own and you will not need to run this again.",
      "",
    );
  } finally {
    // On every path, including the ones that threw. See `login-flow.ts` for why
    // a listener left running is the thing this must not do.
    listener.stop();
  }
}

main().catch((error: unknown) => {
  // To stderr, and without a stack: every message this command can fail with is
  // written for the Operator, and a trace would bury it.
  process.stderr.write(`\n${error instanceof Error ? error.message : String(error)}\n\n`);
  process.exitCode = 1;
});
