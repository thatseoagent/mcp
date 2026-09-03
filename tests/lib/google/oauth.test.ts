import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";

/**
 * Refreshing, and refusing, without a Google account.
 *
 * `google-auth-library` is replaced wholesale: what is being tested is this
 * project's decisions around it — when to refresh, what to keep, and what an
 * Operator who has not logged in is told — not Google's OAuth implementation.
 */

const getAccessToken = vi.fn();
const setCredentials = vi.fn();
let credentials: { expiry_date?: number } = {};

vi.mock("google-auth-library", () => ({
  OAuth2Client: class {
    setCredentials = setCredentials;
    getAccessToken = getAccessToken;
    get credentials() {
      return credentials;
    }
    generateAuthUrl = (options: Record<string, unknown>) =>
      `https://accounts.google.com/o/oauth2/v2/auth?${new URLSearchParams(
        Object.entries(options).map(([k, v]) => [k, String(v)]),
      )}`;
  },
}));

import { resetPersistence } from "@/lib/db/runtime";
import { DB_PATH_VARIABLE } from "@/lib/db/database";
import { MissingConfigError } from "@/lib/required-config";
import { accessToken, googleIsConfigured } from "@/lib/google/oauth";
import { readTokens, writeTokens } from "@/lib/google/tokens";
import { useTempDatabase } from "../../helpers/temp-database";

let temp: ReturnType<typeof useTempDatabase> | null = null;

beforeEach(() => {
  vi.stubEnv("GOOGLE_CLIENT_ID", "client-id");
  vi.stubEnv("GOOGLE_CLIENT_SECRET", "client-secret");
  credentials = {};
  getAccessToken.mockReset();
  setCredentials.mockReset();
});

afterEach(() => {
  temp?.dispose();
  temp = null;
  delete process.env[DB_PATH_VARIABLE];
  resetPersistence();
  vi.unstubAllEnvs();
});

describe("getting an access token", () => {
  it("refuses with the login command when nobody has logged in", async () => {
    // ADR-0003: the Tool cannot do its whole job, so it says what to do about
    // it. Naming the command rather than the storage key, because the command is
    // the thing the Operator can actually run.
    temp = useTempDatabase();

    await expect(accessToken()).rejects.toBeInstanceOf(MissingConfigError);
    await expect(accessToken()).rejects.toThrow(/thatseoagent-mcp-login/);
  });

  it("uses a stored access token that is still good, without going to Google", async () => {
    temp = useTempDatabase();
    writeTokens({
      refreshToken: "refresh-1",
      accessToken: "still-good",
      expiresAt: Date.now() + 3_600_000,
    });

    expect(await accessToken()).toBe("still-good");
    expect(getAccessToken).not.toHaveBeenCalled();
  });

  it("refreshes silently when the stored one has expired", async () => {
    // The criterion this exists for: a Tool must not fail on an expired access
    // token. The Operator logged in weeks ago and knows nothing about expiry.
    temp = useTempDatabase();
    writeTokens({ refreshToken: "refresh-1", accessToken: "stale", expiresAt: Date.now() - 1 });
    credentials = { expiry_date: Date.now() + 3_600_000 };
    getAccessToken.mockResolvedValue({ token: "fresh" });

    expect(await accessToken()).toBe("fresh");
    expect(setCredentials).toHaveBeenCalledWith({ refresh_token: "refresh-1" });
  });

  it("stores the refreshed token so the next call does not repeat the round trip", async () => {
    temp = useTempDatabase();
    writeTokens({ refreshToken: "refresh-1", accessToken: "stale", expiresAt: Date.now() - 1 });
    credentials = { expiry_date: Date.now() + 3_600_000 };
    getAccessToken.mockResolvedValue({ token: "fresh" });

    await accessToken();
    await accessToken();

    expect(getAccessToken).toHaveBeenCalledTimes(1);
    expect(readTokens()!.accessToken).toBe("fresh");
  });

  it("keeps the refresh token when Google's response omits one", async () => {
    temp = useTempDatabase();
    writeTokens({ refreshToken: "refresh-1", expiresAt: Date.now() - 1 });
    credentials = { expiry_date: Date.now() + 3_600_000 };
    getAccessToken.mockResolvedValue({ token: "fresh" });

    await accessToken();

    expect(readTokens()!.refreshToken).toBe("refresh-1");
  });

  it("assumes an hour when Google does not say when the token expires", async () => {
    // Treating an unknown expiry as "expired" would refresh on every call, which
    // spends a request per Tool invocation for no reason.
    temp = useTempDatabase();
    writeTokens({ refreshToken: "refresh-1", expiresAt: Date.now() - 1 });
    credentials = {};
    getAccessToken.mockResolvedValue({ token: "fresh" });

    await accessToken();

    expect(readTokens()!.expiresAt).toBeGreaterThan(Date.now() + 3_000_000);
  });

  it("refuses with the login command when the refresh itself yields nothing", async () => {
    // A revoked grant looks like this. The Operator has to log in again, and
    // that is what they are told — not that Google failed.
    temp = useTempDatabase();
    writeTokens({ refreshToken: "revoked", expiresAt: Date.now() - 1 });
    getAccessToken.mockResolvedValue({ token: null });

    await expect(accessToken()).rejects.toBeInstanceOf(MissingConfigError);
  });
});

describe("googleIsConfigured", () => {
  it("is false with no login and true with one", () => {
    temp = useTempDatabase();

    expect(googleIsConfigured()).toBe(false);

    writeTokens({ refreshToken: "refresh-1" });

    expect(googleIsConfigured()).toBe(true);
  });
});
