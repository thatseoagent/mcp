/**
 * Sites: the domains this Operator analyses.
 *
 * ── No owner, and no limit ──
 *
 * `CONTEXT.md`: "A Site has no owner: every Site in the database belongs to the
 * Operator running the server." There is no `user_id` in the table, and **no
 * code anywhere counts Sites** — the case this is built for is a freelance SEO
 * holding a dozen clients, and a count is the first thing a limit would need.
 * There is no flag that switches a Site off either: every registered Site is
 * readable by every Tool, always.
 *
 * ── What is stored, and what is emphatically not ──
 *
 * A Site records the domain, its registrable form, and **where to look** on
 * Google's side. It does not record whether the Operator may look: `gscSiteUrl`
 * is a convenience cache and never an authority. Property Access is asked of
 * Google every time — see `property-access.ts` — because an Operator who gains
 * or loses access in Search Console has to see that reflected without running
 * anything.
 *
 * That distinction is the one this module exists to hold. A stored boolean
 * called `hasAccess` would be an entitlement, and an entitlement is a claim
 * about permission that outlives the permission.
 */
import { eq } from "drizzle-orm";
import { getDomain } from "tldts";
import { sites, type Site } from "./db/schema";
import { now } from "./db/instants";
import { database } from "./db/runtime";
import { InvalidInputError } from "./invalid-input-error";

/**
 * The domain, as it will be stored.
 *
 * A person says `https://example.com/pricing`, `www.example.com` and
 * `example.com` meaning one thing, so all three land on one row. The scheme, the
 * path and a leading `www.` all go; anything else in the hostname stays, because
 * `blog.example.com` genuinely is a different Site from `example.com` and the
 * Operator may want both.
 */
export function normaliseDomain(input: string): string {
  const trimmed = input.trim();
  if (trimmed.length === 0) throw new InvalidInputError("A domain is required.");

  let hostname = trimmed;
  try {
    hostname = new URL(/^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`).hostname;
  } catch {
    throw new InvalidInputError(`"${input}" is not a domain this server can read.`);
  }

  const lowered = hostname.toLowerCase().replace(/^www\./, "");
  if (!getDomain(lowered)) {
    throw new InvalidInputError(
      `"${input}" is not a registrable domain. Pass something like example.com.`,
    );
  }
  return lowered;
}

/** The eTLD+1 of a domain, which is how two spellings of one property group. */
export function registrableDomainOf(domain: string): string {
  return getDomain(domain) ?? domain;
}

/**
 * Thrown when a Site operation is asked for on a server with no database.
 *
 * A `MissingConfigError` would be the obvious choice, and it is wrong: this is
 * not a variable somebody forgot to set. It is `TSA_DB_PATH=off`, or a file that
 * could not be opened, and the sentence has to say which — which is what
 * `persistenceStatus()` carries and what the Tools print.
 */
export class NoDatabaseError extends Error {
  constructor(reason: string) {
    super(
      `This needs the server's database, and there is none: ${reason}. ` +
        `Sites, audit history and page audits all live there. The credential-free Tools ` +
        `— seo_analyze_page, crawl_site, seo_geo_score and the rest — work without it.`,
    );
    this.name = "NoDatabaseError";
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/** Every Site, oldest first, which is the order they were registered in. */
export function listSites(): Site[] {
  // Rule 2 in `db/runtime.ts`: past the Tool's refusal, a read answers with its
  // own empty.
  const db = database();
  if (!db) return [];
  return db.select().from(sites).all();
}

/** The Site for a domain, or `null`. The domain is normalised first. */
export function findSite(domain: string): Site | null {
  // Rule 2 in `db/runtime.ts`: past the Tool's refusal, a read answers with its
  // own empty.
  const db = database();
  if (!db) return null;
  const normalised = normaliseDomain(domain);
  const [row] = db.select().from(sites).where(eq(sites.domain, normalised)).limit(1).all();
  return row ?? null;
}

/**
 * Register a domain as a Site, or return the one already registered.
 *
 * Idempotent, which is what makes it safe for `run_site_audit` to call on every
 * run: an Operator naming a domain twice has one Site with one history, not two
 * rows splitting it. The retired product held four domains registered twice for
 * exactly this reason.
 */
export function registerSite(domain: string): Site {
  const db = database();
  // Rule 2's exception, in `db/runtime.ts`: "the Site you asked me to create"
  // has no empty answer, so this is the one repository function that throws.
  // The Tool that calls it has already refused with the *reason*; this is the
  // guard behind that, and its message is deliberately generic.
  if (!db) throw new NoDatabaseError("persistence is unavailable");

  const normalised = normaliseDomain(domain);
  const existing = findSite(normalised);
  if (existing) return existing;

  db.insert(sites)
    .values({
      domain: normalised,
      registrableDomain: registrableDomainOf(normalised),
      createdAt: now(),
      updatedAt: now(),
    })
    // A concurrent registration of the same domain is not an error; it is the
    // same intent arriving twice.
    .onConflictDoNothing({ target: sites.domain })
    .run();

  const created = findSite(normalised);
  if (!created) throw new Error(`The Site for ${normalised} could not be read back after writing.`);
  return created;
}

/**
 * Remember which Google Property a Site's data lives under.
 *
 * A pointer, not a permission. Writing it says "this is where to look"; whether
 * the Operator may look is asked of Google on every read.
 */
export function rememberGoogleProperty(
  domain: string,
  property: { gscSiteUrl?: string | null; ga4PropertyId?: string | null },
): void {
  const db = database();
  // Rule 3 in `db/runtime.ts`, the silent half: there is no Site row to attach a
  // property to either, so nothing was lost and nothing is owed. Unlike
  // `site-refresh`'s closers, this is never reached holding an id that proves a
  // database existed a moment ago.
  if (!db) return;

  db.update(sites)
    .set({
      ...(property.gscSiteUrl !== undefined ? { gscSiteUrl: property.gscSiteUrl } : {}),
      ...(property.ga4PropertyId !== undefined ? { ga4PropertyId: property.ga4PropertyId } : {}),
      updatedAt: now(),
    })
    .where(eq(sites.domain, normaliseDomain(domain)))
    .run();
}

export type { Site };
