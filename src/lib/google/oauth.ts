/**
 * The OAuth client, and the one credential an Operator has to create themselves.
 *
 * ── Why the Operator brings their own client ──
 *
 * ADR-0002: the login command receives Google's redirect on `localhost`, because
 * Google retired the out-of-band copy-paste flow in 2022 and a localhost
 * redirect is the only route left for a program with no website. That requires
 * an OAuth client of type **Desktop app** — the only type Google permits a
 * localhost redirect for — and a Desktop-app client is something each Operator
 * creates in their own Google Cloud project.
 *
 * This is not a limitation to route around. It is what keeps the arrangement
 * honest: the Operator's data is read by the Operator's own client, under
 * quotas billed to their own project, and nothing here holds a credential that
 * could reach anyone else's account.
 *
 * ── The "secret" is not one ──
 *
 * Google issues a client secret for Desktop-app clients and its own
 * documentation says plainly that it cannot be kept secret in an installed
 * application. It is required by the token endpoint, so it is required here; it
 * is not a thing this server is protecting.
 */
import { OAuth2Client } from "google-auth-library";
import { MissingConfigError, requireConfig, type ConfigRequirement } from "../required-config";
import { SCOPE_URLS } from "./scopes";
import {
  accessTokenIsUsable,
  readTokens,
  recordRefreshedAccessToken,
  type StoredTokens,
} from "./tokens";

/** Where an Operator creates the client, said once. */
const CONSOLE_STEPS =
  "In Google Cloud Console, go to APIs & Services > Credentials, create an OAuth " +
  "client ID, and choose the application type **Desktop app** — that type is what " +
  "permits the localhost redirect this login uses. Enable the Search Console API and " +
  "the Google Analytics Data API for the same project.";

export const GOOGLE_CLIENT_ID: ConfigRequirement = {
  variable: "GOOGLE_CLIENT_ID",
  purpose: "identify this server to Google when you log in",
  howToGet: CONSOLE_STEPS,
};

export const GOOGLE_CLIENT_SECRET: ConfigRequirement = {
  variable: "GOOGLE_CLIENT_SECRET",
  purpose: "complete the OAuth token exchange with Google",
  howToGet:
    "It is shown beside the client ID you created. Google's own documentation notes " +
    "that a Desktop-app secret cannot be kept confidential; it is required by the " +
    "token endpoint rather than protecting anything.",
};

/**
 * The message a Tool shows when nobody has logged in.
 *
 * A `MissingConfigError` like any other, so it travels through the same seam and
 * reaches the agent as readable text rather than as a transport failure. The
 * "variable" it names is the command, because that is the thing the Operator
 * actually has to run — telling them to set `google.tokens` by hand would be
 * true and useless.
 */
export const GOOGLE_LOGIN: ConfigRequirement = {
  variable: "the Google login",
  purpose: "read your Search Console and Analytics data",
  howToGet: "Run `thatseoagent-mcp-login` (or `pnpm login` from a clone) and authorize in the browser.",
};

/** An OAuth client built from the Operator's credentials. */
export function createOAuthClient(redirectUri?: string): OAuth2Client {
  return new OAuth2Client({
    clientId: requireConfig(GOOGLE_CLIENT_ID),
    clientSecret: requireConfig(GOOGLE_CLIENT_SECRET),
    redirectUri,
  });
}

/**
 * The consent URL to open in the Operator's browser.
 *
 * `state` is required rather than optional: the listener that receives the
 * redirect compares it before exchanging anything, and a consent URL built
 * without one would produce a callback that listener always rejects. Making the
 * caller pass it is what keeps the two halves in step.
 */
export function consentUrl(client: OAuth2Client, state: string): string {
  return client.generateAuthUrl({
    state,
    // Offline is what makes Google issue a refresh token at all; without it the
    // Operator would be logging in again within the hour.
    access_type: "offline",
    scope: [...SCOPE_URLS],
    // Asked for explicitly, because Google issues a refresh token only on first
    // consent otherwise. An Operator re-running login to switch accounts, or
    // after their token was revoked, would otherwise complete the flow
    // successfully and end up with nothing durable.
    prompt: "consent",
  });
}

/**
 * An access token that is valid right now.
 *
 * Refreshes silently when the stored one has expired, and stores the result so
 * the next Tool call does not repeat the round-trip. Throws
 * {@link MissingConfigError} naming the login command when nobody has logged in
 * — which is the ADR-0003 refusal, arriving from the one place that can tell.
 */
export async function accessToken(): Promise<string> {
  const stored = readTokens();
  if (!stored) throw new MissingConfigError(GOOGLE_LOGIN);

  if (accessTokenIsUsable(stored)) return stored.accessToken!;

  return refreshAccessToken(stored);
}

async function refreshAccessToken(stored: StoredTokens): Promise<string> {
  const client = createOAuthClient();
  client.setCredentials({ refresh_token: stored.refreshToken });

  const { token } = await client.getAccessToken();
  if (!token) throw new MissingConfigError(GOOGLE_LOGIN);

  // `expiry_date` is what the library records after a refresh. Falling back to
  // an hour rather than treating it as absent: an unknown expiry that reads as
  // "expired" would refresh on every single call.
  const expiresAt = client.credentials.expiry_date ?? Date.now() + 3_600_000;
  recordRefreshedAccessToken(token, expiresAt);

  return token;
}

/** Has the Operator logged in? For diagnostics, not as a gate. */
export function googleIsConfigured(): boolean {
  return readTokens() !== null;
}
