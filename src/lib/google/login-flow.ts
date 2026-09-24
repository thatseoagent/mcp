/**
 * The consent round trip, separated from the command that prints it.
 *
 * ── Why an ephemeral server, and why it has to stop ──
 *
 * ADR-0002: Google retired the out-of-band copy-paste flow in 2022, so the
 * consent redirect needs somewhere to land, and for a program with no website
 * that somewhere is `localhost`. This starts a server, waits for exactly one
 * request, and shuts down.
 *
 * "And shuts down" is an acceptance criterion rather than housekeeping. A
 * listener left running after a login is an unauthenticated HTTP endpoint on the
 * Operator's machine that accepts an OAuth code — which is the one thing this
 * whole flow exists to receive. It closes on the success path, on every failure
 * path, and on the timeout.
 *
 * ── The port is fixed, and it is not the MCP port ──
 *
 * Always 3738, so the redirect URI is the same on every login: it can be named
 * in the docs, recognised in the browser's address bar, and allowed through a
 * firewall. A "Desktop app" client would accept any loopback port, so this is
 * not something Google needs registered.
 *
 * Not 3737, though. The Operator usually logs in with the server already
 * running — that is how they find out a Tool needs the login — and on the MCP
 * port the login would find its own server in the way. One up from it, so the
 * two are easy to remember together.
 *
 * ── `state` is checked ──
 *
 * The listener is on loopback, but any page the Operator's browser visits can
 * issue a request to `127.0.0.1`. Without `state`, whatever arrives first with a
 * `code` parameter gets exchanged. The value is compared before anything is sent
 * to Google.
 */
import { createServer, type Server } from "node:http";
import { randomBytes } from "node:crypto";
import type { OAuth2Client } from "google-auth-library";

/** How long the Operator gets to finish consenting before the server gives up. */
const CONSENT_TIMEOUT_MS = 5 * 60 * 1000;

/** The port the listener binds. See "The port is fixed" above. */
export const CALLBACK_PORT = 3738;

/** The path Google is told to redirect to. */
const CALLBACK_PATH = "/callback";

export interface ConsentListener {
  /** The URI Google is told to redirect to. Needed to build the consent URL. */
  redirectUri: string;
  /** The opaque value Google must echo back. Compared before anything is exchanged. */
  state: string;
  /** Resolves with the authorization code, or rejects with a reason. */
  code: Promise<string>;
  /** Stop listening. Safe to call more than once. */
  stop(): void;
}

/** What the browser is left showing. Plain text: there is no page to style. */
const CLOSING_PAGE = (message: string) =>
  `<!doctype html><meta charset="utf-8"><title>That SEO Agent</title>` +
  `<body style="font:16px system-ui;padding:3rem;max-width:34rem">` +
  `<p>${message}</p><p>You can close this tab and go back to your terminal.</p>`;

/**
 * Start the listener, hand back its redirect URI, and resolve once the code
 * arrives.
 *
 * The redirect URI is returned *before* the code because it is needed to build
 * the consent URL — the caller opens the browser between the two.
 */
export async function awaitConsent(): Promise<ConsentListener> {
  const state = randomBytes(16).toString("hex");
  let settled = false;
  let resolveCode: (code: string) => void;
  let rejectCode: (error: Error) => void;
  const code = new Promise<string>((resolve, reject) => {
    resolveCode = resolve;
    rejectCode = reject;
  });
  // A rejection nobody is waiting on must not take the process down. The command
  // can stop waiting for legitimate reasons — a check further down threw, the
  // Operator hit Ctrl-C — and the five-minute timeout still fires afterwards.
  // Attaching a no-op handler here does not swallow anything: the caller's own
  // `await` is a second handler and still sees the rejection.
  code.catch(() => {});

  const stop = () => {
    // `closeAllConnections` as well as `close`: the browser holds the callback
    // connection open, and `close` alone waits for it — so the process would sit
    // there after reporting success.
    server.closeAllConnections?.();
    server.close();
  };

  const finish = (outcome: { code: string } | { error: Error }) => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    stop();
    if ("code" in outcome) resolveCode(outcome.code);
    else rejectCode(outcome.error);
  };

  const timer = setTimeout(() => {
    finish({
      error: new Error(
        `No response from Google within ${CONSENT_TIMEOUT_MS / 60_000} minutes. ` +
          `Nothing was changed; run the command again when you are ready to authorize.`,
      ),
    });
  }, CONSENT_TIMEOUT_MS);
  // The timer must not be the reason the process stays alive: the server already
  // holds it open, and once the server closes the command should be free to exit.
  timer.unref?.();

  const server: Server = createServer((request, response) => {
    // No keep-alive. The port is the same on every login, so a socket the
    // browser kept from a previous one would be reused against a server that is
    // no longer there.
    response.setHeader("connection", "close");
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    if (url.pathname !== CALLBACK_PATH) {
      response.writeHead(404).end();
      return;
    }

    const error = url.searchParams.get("error");
    if (error) {
      // Google's own word for what happened — `access_denied` when the Operator
      // clicked cancel. Forwarded because the Operator is the one who caused it
      // and it is not sensitive.
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      response.end(CLOSING_PAGE(`Authorization was not completed (${error}).`));
      finish({ error: new Error(`Google returned "${error}", so nothing was authorized.`) });
      return;
    }

    if (url.searchParams.get("state") !== state) {
      // Not the request we are waiting for. Answered blandly and *not* treated
      // as a failure of the login: a stray request from some other page in the
      // browser must not be able to cancel the Operator's consent.
      response.writeHead(400, { "content-type": "text/html; charset=utf-8" });
      response.end(CLOSING_PAGE("This request did not come from the login that is in progress."));
      return;
    }

    const received = url.searchParams.get("code");
    if (!received) {
      response.writeHead(400, { "content-type": "text/html; charset=utf-8" });
      response.end(CLOSING_PAGE("Google's redirect carried no authorization code."));
      finish({ error: new Error("Google's redirect carried no authorization code.") });
      return;
    }

    response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    response.end(CLOSING_PAGE("Authorized. That SEO Agent can now read your Google data."));
    finish({ code: received });
  });

  // Loopback only. A login listener reachable from the LAN would accept a code
  // from anywhere on the network.
  server.listen(CALLBACK_PORT, "127.0.0.1");

  // Awaited rather than returned with a lazily-read port: the redirect URI is
  // the first thing the caller needs, and a handle whose URI is only valid
  // "soon" is a handle every caller has to remember to wait on.
  //
  // A failure to bind rejects *here* and nowhere else. Routing it through
  // `finish` as well would reject `code`, which at that point no caller holds —
  // an unhandled rejection reported instead of the real error.
  await new Promise<void>((resolve, reject) => {
    server.once("listening", resolve);
    server.once("error", (error: NodeJS.ErrnoException) => {
      clearTimeout(timer);
      if (error.code !== "EADDRINUSE") {
        reject(error);
        return;
      }
      // The likeliest owner is another login still waiting in some other
      // terminal. Named, because a bare EADDRINUSE reads like a bug.
      reject(
        new Error(
          `Port ${CALLBACK_PORT} on 127.0.0.1 is already in use, and the login needs it ` +
            `to receive Google's redirect. If another login is still waiting in a different ` +
            `terminal, finish or cancel that one; otherwise stop whatever holds the port.`,
        ),
      );
    });
  });

  // From here on the caller holds `code`, so a later error belongs to it.
  server.on("error", (error) => finish({ error }));

  return {
    redirectUri: `http://127.0.0.1:${CALLBACK_PORT}${CALLBACK_PATH}`,
    state,
    code,
    stop,
  };
}

/**
 * Exchange the code for tokens.
 *
 * Separated so the command's error handling has one place to catch: a bad code,
 * a clock skew, a revoked client all surface here.
 */
export async function exchangeCode(
  client: OAuth2Client,
  code: string,
): Promise<{ refreshToken: string; accessToken?: string; expiresAt?: number }> {
  const { tokens } = await client.getToken(code);

  if (!tokens.refresh_token) {
    // The one outcome that looks like success and is not. Without a refresh
    // token the Operator is authorized for an hour and then silently is not.
    throw new Error(
      "Google did not return a refresh token, so this login would stop working within " +
        "the hour. This usually means the OAuth client is not of type \"Desktop app\", " +
        "or that a previous grant is still active — remove this app at " +
        "https://myaccount.google.com/permissions and run the command again.",
    );
  }

  return {
    refreshToken: tokens.refresh_token,
    accessToken: tokens.access_token ?? undefined,
    expiresAt: tokens.expiry_date ?? undefined,
  };
}
