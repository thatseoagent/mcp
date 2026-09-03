/**
 * The Operator's Google tokens: stored once, refreshed from then on.
 *
 * ── What is stored, and what is not ──
 *
 * The **refresh token** is the thing that matters. It is what makes "log in once"
 * true rather than "log in every session", and Google issues it only on the
 * first consent for a given client unless asked again explicitly — which is why
 * the login command sends `prompt=consent`, and why a refresh response that
 * omits one must not overwrite the stored one with `undefined`. That single
 * mistake is the difference between a server that works for months and one that
 * demands a browser every hour.
 *
 * The **access token** is stored too, with its expiry, purely to avoid spending
 * a refresh round-trip on every Tool call. It is disposable; losing it costs one
 * request.
 *
 * ── Nothing here logs ──
 *
 * No debug output, no "token set: true", no first-eight-characters. The retired
 * implementation printed `apiKey ? (${apiKey.slice(0, 8)}...)` on every call,
 * which is a credential prefix in a log file. This module has no logging at all,
 * and that is deliberate rather than incomplete.
 */
import { CONFIG_KEYS, readConfiguration, writeConfiguration } from "../db/configuration";

export interface StoredTokens {
  /** The long-lived credential. Without it the Operator has to log in again. */
  refreshToken: string;
  /** The short-lived one, if we currently hold a usable one. */
  accessToken?: string;
  /** Epoch milliseconds. Absent when there is no access token. */
  expiresAt?: number;
}

/**
 * How early an access token is treated as expired.
 *
 * A token that expires in four seconds passes a naive check and then fails
 * mid-request, and the Tool reports that as the site's problem. Refreshing a
 * minute early costs one request an hour.
 */
export const EXPIRY_MARGIN_MS = 60_000;

/** The stored tokens, or `null` when the Operator has not logged in. */
export function readTokens(): StoredTokens | null {
  const raw = readConfiguration(CONFIG_KEYS.googleTokens);
  if (!raw) return null;

  try {
    const parsed = JSON.parse(raw) as Partial<StoredTokens>;
    // A row without a refresh token is not a login. Treating it as one would
    // send a Tool to Google with nothing to authenticate with, and the failure
    // would read as Google refusing the Operator rather than as a bad row.
    if (typeof parsed.refreshToken !== "string" || parsed.refreshToken.length === 0) return null;
    return {
      refreshToken: parsed.refreshToken,
      accessToken: typeof parsed.accessToken === "string" ? parsed.accessToken : undefined,
      expiresAt: typeof parsed.expiresAt === "number" ? parsed.expiresAt : undefined,
    };
  } catch {
    // Unparseable is the same as absent, for the caller. Nothing is logged
    // because the row's contents are the one thing that must not reach stderr.
    return null;
  }
}

/**
 * Store tokens.
 *
 * @returns whether they were stored. `false` means there is no database, and the
 *          login command has to say so rather than reporting success.
 */
export function writeTokens(tokens: StoredTokens): boolean {
  return writeConfiguration(CONFIG_KEYS.googleTokens, JSON.stringify(tokens));
}

/**
 * Record a fresh access token against the refresh token we already hold.
 *
 * The refresh token is read back and re-written rather than taken from the
 * caller, which is the guard described in the module header: a refresh response
 * that omits one must not be able to erase it.
 */
export function recordRefreshedAccessToken(accessToken: string, expiresAt: number): boolean {
  const stored = readTokens();
  if (!stored) return false;
  return writeTokens({ ...stored, accessToken, expiresAt });
}

/** Is there a stored access token still worth using? */
export function accessTokenIsUsable(tokens: StoredTokens, at = Date.now()): boolean {
  if (!tokens.accessToken || tokens.expiresAt === undefined) return false;
  return tokens.expiresAt - EXPIRY_MARGIN_MS > at;
}
