/**
 * A page's audit, kept so it can be compared against itself later.
 *
 * ── What makes this different from the page analysis Tools ──
 *
 * `seo_analyze_page` answers "what is wrong with this page now". It is complete
 * on its own and needs no database. What it cannot answer is "is this better
 * than before I changed it", which is the question an Operator actually has
 * after doing the work — and answering it needs the previous audit to still
 * exist.
 *
 * So a page audit is stored, one row per URL per Site, and re-auditing a URL
 * **replaces** its row rather than appending. That is deliberate and it is the
 * one decision here worth arguing about: a full version history per URL grows
 * without bound on a site with thousands of pages, and the comparison an
 * Operator asks for is against the *last* audit, not against an arbitrary older
 * one. The previous rendering is returned by {@link savePageAudit} so the Tool
 * can show the difference at the moment it matters, which is the moment it
 * replaces it.
 */
import { and, desc, eq } from "drizzle-orm";
import { pageAudits, type PageAudit } from "./db/schema";
import { now } from "./db/instants";
import { database } from "./db/runtime";
import { InvalidInputError } from "./invalid-input-error";

/**
 * The URL, as it will be stored.
 *
 * The fragment goes because it never reaches the server, so two URLs differing
 * only by one are one page. Everything else is kept: a query string can be the
 * whole difference between two pages, and normalising it away would silently
 * merge their audits.
 */
export function normaliseAuditUrl(input: string): string {
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    throw new InvalidInputError(`"${input}" is not a URL this server can audit.`);
  }
  if (!/^https?:$/.test(url.protocol)) {
    throw new InvalidInputError("A page audit needs an http or https URL.");
  }
  url.hash = "";
  return url.toString();
}

/** Every audit stored for a Site, most recently updated first. */
export function listPageAudits(siteId: string, limit = 50): PageAudit[] {
  // Rule 2 in `db/runtime.ts`: past the Tool's refusal, a read answers with its
  // own empty.
  const db = database();
  if (!db) return [];

  return db
    .select()
    .from(pageAudits)
    .where(eq(pageAudits.siteId, siteId))
    .orderBy(desc(pageAudits.updatedAt))
    .limit(limit)
    .all();
}

/** The stored audit for one URL, or `null`. */
export function findPageAudit(siteId: string, url: string): PageAudit | null {
  // Rule 2 in `db/runtime.ts`: past the Tool's refusal, a read answers with its
  // own empty.
  const db = database();
  if (!db) return null;

  const [row] = db
    .select()
    .from(pageAudits)
    .where(and(eq(pageAudits.siteId, siteId), eq(pageAudits.url, normaliseAuditUrl(url))))
    .limit(1)
    .all();

  return row ?? null;
}

/**
 * Store an audit, returning the one it replaced.
 *
 * The previous row is read before the write, because after it there is nothing
 * to compare against — and the comparison is the reason this table exists.
 */
export function savePageAudit(
  siteId: string,
  url: string,
  report: string,
): { previous: PageAudit | null } {
  // A write, so rule 3 in `db/runtime.ts` — the silent half. Nothing was saved
  // and there was no previous audit to compare against either, so `previous:
  // null` is the whole truth rather than a stand-in for one. Unlike
  // `site-refresh`'s closers, this is never reached holding an id that proves a
  // database existed a moment ago.
  const db = database();
  if (!db) return { previous: null };

  const normalised = normaliseAuditUrl(url);
  const previous = findPageAudit(siteId, normalised);

  db.insert(pageAudits)
    .values({
      siteId,
      url: normalised,
      contextJson: report,
      createdAt: previous?.createdAt ?? now(),
      updatedAt: now(),
    })
    .onConflictDoUpdate({
      target: [pageAudits.siteId, pageAudits.url],
      // `createdAt` is deliberately not touched: it is when this page was first
      // audited, which is the one date that says how long the record goes back.
      set: { contextJson: report, updatedAt: now() },
    })
    .run();

  return { previous };
}

export type { PageAudit };
