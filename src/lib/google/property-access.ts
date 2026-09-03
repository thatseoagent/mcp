/**
 * Whether the Operator can actually read a Site's Google Property.
 *
 * ── Asked, never remembered ──
 *
 * `CONTEXT.md`: "Property Access is verified against Google, never assumed or
 * stored as an entitlement." This module has no persistence and no cache, and
 * that absence is the design. Access changes outside this server — somebody
 * removes a user in Search Console, somebody verifies a property that was
 * pending — and a stored answer is a claim about permission that outlives the
 * permission.
 *
 * The cost is one `listProperties` call per check, which is the cheapest
 * question Google will answer and the same one `gsc_list_properties` already
 * makes.
 *
 * ── The three answers, and why "unverified" is not "no" ──
 *
 * `granted` — a property matches this Site and the Operator holds a permission
 * level that returns data.
 *
 * `unverified` — a property matches, and its permission level is
 * `siteUnverifiedUser`. Google will answer every query for it with nothing. This
 * is *not* the same as having no property: the Operator has already found the
 * site in Search Console, and one verification step away from a Full Report is a
 * different message from "add this site".
 *
 * `absent` — no property matches. Nothing is wrong with the Site; Google simply
 * has no record of this Operator holding it.
 */
import { matchSiteUrl } from "./property";
import type { GscProperty, SearchConsoleReader } from "./reader";

export type AccessState = "granted" | "unverified" | "absent";

export interface PropertyAccess {
  state: AccessState;
  /** The property this Site resolves to, when one does. */
  siteUrl: string | null;
  /** Google's own word for the permission level, when there is a property. */
  permissionLevel: string | null;
  /** What this means for the Operator, in one sentence they can act on. */
  explanation: string;
}

/** The permission levels that return no data at all. */
const NO_DATA = new Set(["siteUnverifiedUser"]);

/**
 * Check one domain against the properties Google says this account holds.
 *
 * Takes the property list rather than fetching it, so a caller checking twenty
 * Sites makes one request instead of twenty. That is a performance decision and
 * not a caching one: the list is read fresh per call to this module's caller,
 * and never stored.
 */
export function accessFor(domain: string, properties: readonly GscProperty[]): PropertyAccess {
  const siteUrl = matchSiteUrl(domain, properties);

  if (!siteUrl) {
    return {
      state: "absent",
      siteUrl: null,
      permissionLevel: null,
      explanation:
        "No Search Console property covers this domain for this Google account. Add and " +
        "verify it at https://search.google.com/search-console, or re-run the login command " +
        "if the site belongs to a different account. The credential-free Tools work on it " +
        "either way.",
    };
  }

  const property = properties.find((candidate) => candidate.siteUrl === siteUrl);
  const permissionLevel = property?.permissionLevel ?? null;

  if (permissionLevel && NO_DATA.has(permissionLevel)) {
    return {
      state: "unverified",
      siteUrl,
      permissionLevel,
      explanation:
        `The property ${siteUrl} exists but is not verified, so Google returns no data for ` +
        `it. Complete verification in Search Console — the site is already there, this is one ` +
        `step rather than a setup.`,
    };
  }

  return {
    state: "granted",
    siteUrl,
    permissionLevel,
    explanation: `Search Console data is readable through ${siteUrl}.`,
  };
}

/**
 * The same, asking Google for the list first.
 *
 * For a single check. A caller with several Sites should read the list once and
 * call {@link accessFor} per Site.
 */
export async function checkPropertyAccess(
  reader: SearchConsoleReader,
  domain: string,
): Promise<PropertyAccess> {
  return accessFor(domain, await reader.listProperties());
}
