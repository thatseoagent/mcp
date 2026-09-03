import { describe, it, expect, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { resetPersistence } from "@/lib/db/runtime";
import { DB_PATH_VARIABLE } from "@/lib/db/database";
import {
  EXPIRY_MARGIN_MS,
  accessTokenIsUsable,
  readTokens,
  recordRefreshedAccessToken,
  writeTokens,
} from "@/lib/google/tokens";
import { useTempDatabase } from "../../helpers/temp-database";

let temp: ReturnType<typeof useTempDatabase> | null = null;

afterEach(() => {
  temp?.dispose();
  temp = null;
  delete process.env[DB_PATH_VARIABLE];
  resetPersistence();
});

describe("storing the Google tokens", () => {
  it("survives a restart", async () => {
    // The whole promise of the login command: log in once, not once per session.
    temp = useTempDatabase();

    expect(writeTokens({ refreshToken: "refresh-1" })).toBe(true);

    // A restart, as far as this process is concerned: the connection is dropped
    // and the same file is opened again.
    resetPersistence();

    expect(readTokens()).toEqual({
      refreshToken: "refresh-1",
      accessToken: undefined,
      expiresAt: undefined,
    });
  });

  it("never lets a refresh erase the refresh token", async () => {
    // The single mistake that turns a server working for months into one that
    // demands a browser every hour: Google's refresh response does not repeat
    // the refresh token, so a write that took it from the response would store
    // `undefined`.
    temp = useTempDatabase();
    writeTokens({ refreshToken: "refresh-1", accessToken: "old", expiresAt: 1 });

    recordRefreshedAccessToken("new-access", Date.now() + 3_600_000);

    expect(readTokens()!.refreshToken).toBe("refresh-1");
    expect(readTokens()!.accessToken).toBe("new-access");
  });

  it("refuses to record a refresh when nobody has logged in", async () => {
    temp = useTempDatabase();

    expect(recordRefreshedAccessToken("access", Date.now() + 1000)).toBe(false);
    expect(readTokens()).toBeNull();
  });

  it("reads a row with no refresh token as no login at all", async () => {
    // Otherwise a Tool goes to Google with nothing to authenticate with, and the
    // failure reads as Google refusing the Operator rather than as a bad row.
    temp = useTempDatabase();
    const { database } = await import("@/lib/db/runtime");
    const { configuration } = await import("@/lib/db/schema");
    const { now } = await import("@/lib/db/instants");

    database()!
      .insert(configuration)
      .values({ key: "google.tokens", value: JSON.stringify({ accessToken: "x" }), updatedAt: now() })
      .run();

    expect(readTokens()).toBeNull();
  });

  it("reads an unparseable row as no login at all", async () => {
    temp = useTempDatabase();
    const { database } = await import("@/lib/db/runtime");
    const { configuration } = await import("@/lib/db/schema");
    const { now } = await import("@/lib/db/instants");

    database()!
      .insert(configuration)
      .values({ key: "google.tokens", value: "not json", updatedAt: now() })
      .run();

    expect(readTokens()).toBeNull();
  });

  it("says nothing was stored when there is no database", () => {
    // The login command depends on this: reporting success after discarding the
    // tokens would leave an Operator who authorized in their browser with
    // nothing to show for it.
    process.env[DB_PATH_VARIABLE] = "off";
    resetPersistence();

    expect(writeTokens({ refreshToken: "refresh-1" })).toBe(false);
  });
});

describe("deciding whether an access token is still usable", () => {
  const soon = { refreshToken: "r", accessToken: "a", expiresAt: Date.now() + 5_000 };

  it("treats a token expiring within the margin as unusable", () => {
    // A token with four seconds left passes a naive check and then fails
    // mid-request, and the Tool reports that as the site's problem.
    expect(accessTokenIsUsable(soon)).toBe(false);
  });

  it("accepts one comfortably in the future", () => {
    expect(
      accessTokenIsUsable({ refreshToken: "r", accessToken: "a", expiresAt: Date.now() + 10 * EXPIRY_MARGIN_MS }),
    ).toBe(true);
  });

  it("treats a missing access token as unusable rather than as an error", () => {
    expect(accessTokenIsUsable({ refreshToken: "r" })).toBe(false);
  });
});

describe("nothing writes a token anywhere it could be read", () => {
  /**
   * Asserted against the source rather than by capturing output, because the
   * failure this guards against is a debug line added later "just to check" —
   * the retired implementation printed the first eight characters of its API key
   * on every call. A test that only exercised today's happy path would not
   * notice one being added tomorrow.
   */
  const modules = ["src/lib/google/tokens.ts", "src/lib/db/configuration.ts", "src/lib/google/oauth.ts"];

  for (const module of modules) {
    it(`${module} contains no logging at all`, () => {
      const source = readFileSync(path.resolve(process.cwd(), module), "utf8");
      // Comments talk about logging, so the check is for calls.
      expect(source).not.toMatch(/console\.\w+\(/);
      expect(source).not.toMatch(/process\.std(out|err)\.write\(/);
      expect(source).not.toMatch(/logError\(/);
    });
  }
});
