/**
 * The key/value table, read and written through named keys rather than strings.
 *
 * A `configuration` table is the shape that invites typos: `get("google_token")`
 * against a row written as `google_tokens` returns `null`, which every caller
 * reads as "not configured yet". The Operator is then told to log in again by a
 * server that already has their tokens. So the keys are a closed set declared
 * here, and nothing else may invent one.
 *
 * Values are text. A caller that wants structure encodes it — see
 * `google/tokens.ts`, which is the only one that does.
 *
 * **Nothing here is a credential store in any meaningful sense.** ADR-0002 says
 * so plainly: tokens are written unencrypted, because the file is local and
 * gitignored and a key living in the adjacent environment file would protect
 * nothing. What this module does owe is that a value never reaches a log or
 * stdout, which is why it has no debug output at all.
 */
import { eq } from "drizzle-orm";
import { configuration } from "./schema";
import { now } from "./instants";
import { database } from "./runtime";

/**
 * Every key the server stores. Adding one means adding it here.
 *
 * `google.tokens` holds the OAuth refresh and access tokens as JSON.
 *
 * There is deliberately no `google.account`. Knowing which Google account the
 * tokens belong to would mean asking for the `openid`/`email` scope, and that is
 * a third permission on the consent screen bought for a line of output the
 * Operator does not need — they were the one looking at the account chooser a
 * second earlier.
 */
export const CONFIG_KEYS = {
  googleTokens: "google.tokens",
} as const;

export type ConfigKey = (typeof CONFIG_KEYS)[keyof typeof CONFIG_KEYS];

/**
 * The stored value, or `null` when there is none — or when there is no database.
 *
 * The two cases collapse on purpose. A caller asking "am I configured?" gets the
 * same answer either way, and the one that needs to *explain* the absence asks
 * `persistenceStatus()` instead. Branching here would put an `if (db)` in every
 * caller for a distinction almost none of them draw.
 */
export function readConfiguration(key: ConfigKey): string | null {
  // Rule 2 in `db/runtime.ts`: past the Tool's refusal, a read answers with its
  // own empty.
  const db = database();
  if (!db) return null;

  const [row] = db
    .select({ value: configuration.value })
    .from(configuration)
    .where(eq(configuration.key, key))
    .limit(1)
    .all();

  return row?.value ?? null;
}

/**
 * Store a value.
 *
 * @returns whether it was stored. `false` means there is no database, and the
 *          caller has to say so — silently discarding a login would leave an
 *          Operator who authorized in their browser with nothing to show for it.
 */
export function writeConfiguration(key: ConfigKey, value: string): boolean {
  // Rule 2 in `db/runtime.ts`: past the Tool's refusal, a read answers with its
  // own empty.
  const db = database();
  // Returns `false` rather than staying silent, so a caller that needs to know
  // whether the value was kept can tell. Rule 3 in `runtime.ts`.
  if (!db) return false;

  db.insert(configuration)
    .values({ key, value, updatedAt: now() })
    .onConflictDoUpdate({ target: configuration.key, set: { value, updatedAt: now() } })
    .run();

  return true;
}

/** Forget a value. Used by login when it replaces one account with another. */
export function deleteConfiguration(key: ConfigKey): void {
  database()?.delete(configuration).where(eq(configuration.key, key)).run();
}
