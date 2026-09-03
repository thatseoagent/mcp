/**
 * The seven tables that survived the extraction.
 *
 * The retired product had twenty-three. Most of them existed to answer questions
 * a Single-tenant server cannot ask: `users`, `subscriptions`, `api_keys`,
 * `audit_logs`, `oauth_clients`, `waitlist`, `slack_connections`,
 * `shared_reports`. `CONTEXT.md` lists that vocabulary as retired, and their
 * absence here is the schema agreeing with it.
 *
 * What is left is what history needs. Nothing here identifies a caller, and
 * **no table has an owner column** — every Site belongs to whoever runs the
 * server. That is not a simplification to be undone later: a `user_id` here
 * would be the first place a second tenant could hide.
 *
 * ── The dialect port ──
 *
 * Postgres to SQLite, and four decisions travel with it:
 *
 * - **Identifiers are text UUIDs.** `bigserial` has no SQLite equivalent worth
 *   having, and the retired schema already carried a `uuid` beside every
 *   `bigserial` because the API surface needed a stable identifier that was not
 *   a guessable row count. Keeping only the UUID drops a column and a join key
 *   rather than losing anything.
 * - **Instants are integer milliseconds**, through `instant()`. See
 *   `instants.ts` for why the encoding has to be stated once.
 * - **The one JSON column is JSON-mode text.** SQLite has no `jsonb`; Drizzle's
 *   `{ mode: "json" }` over `text` gives the same round-trip.
 * - **No LATERAL.** Nothing here needs one, and the two queries that used one in
 *   the retired product are ordinary queries in this shape.
 */
import { sql } from "drizzle-orm";
import { index, sqliteTable, text, integer, real, uniqueIndex } from "drizzle-orm/sqlite-core";
import { instant } from "./instants";

/** A stable identifier that is not a guessable row count. */
const id = () =>
  text("id")
    .primaryKey()
    .$defaultFn(() => crypto.randomUUID());

/**
 * A domain the Operator analyses.
 *
 * No owner, and no limit on how many. The case this is built for is a freelance
 * SEO holding a dozen clients, so there is no column here that could ration
 * them: no owner, no counter, and no flag that switches a Site off. Every row is
 * readable by every Tool.
 */
export const sites = sqliteTable(
  "sites",
  {
    id: id(),
    /** The domain as the Operator gave it: `foo.com`, `blog.foo.com`. */
    domain: text("domain").notNull(),
    /**
     * eTLD+1 of `domain`, computed with the public suffix list.
     *
     * Stored because it is the honest answer to "are these the same site?" —
     * useful for grouping a report and for telling an Operator that
     * `www.foo.com` and `foo.com` are one property with two spellings. Nothing
     * groups by it in order to ration anything.
     */
    registrableDomain: text("registrable_domain").notNull(),
    /**
     * How Search Console names this Site, once we have asked.
     *
     * A convenience cache and **never an authority**: Property Access is
     * re-checked against Google every time. A stored value here says where to
     * look, not that the Operator may look.
     */
    gscSiteUrl: text("gsc_site_url"),
    /** The same, for Analytics. */
    ga4PropertyId: text("ga4_property_id"),
    createdAt: instant("created_at").notNull(),
    updatedAt: instant("updated_at").notNull(),
  },
  (t) => [
    // One row per domain. Production held four domains registered twice, each
    // splitting that domain's history across two rows. There is no user to scope
    // this by any more, which makes it simply unique.
    uniqueIndex("uq_sites_domain").on(t.domain),
    index("idx_sites_registrable").on(t.registrableDomain),
  ],
);

/** One run of the Full Report against a Site. */
export const siteRefreshes = sqliteTable(
  "site_refreshes",
  {
    id: id(),
    siteId: text("site_id")
      .notNull()
      .references(() => sites.id, { onDelete: "cascade" }),
    status: text("status").notNull().default("pending").$type<"pending" | "done" | "failed">(),
    /** The rendered report, kept so a finished run can be read back. */
    contextJson: text("context_json"),
    startedAt: instant("started_at").notNull(),
    completedAt: instant("completed_at"),
    updatedAt: instant("updated_at").notNull(),
  },
  (t) => [index("idx_site_refreshes_site").on(t.siteId, t.startedAt)],
);

/**
 * One reading of one metric at one moment.
 *
 * The table history is for, and the reason the database exists at all.
 */
export const siteMetricHistory = sqliteTable(
  "site_metric_history",
  {
    id: id(),
    siteId: text("site_id")
      .notNull()
      .references(() => sites.id, { onDelete: "cascade" }),
    /**
     * `set null`, not `cascade`, and this is the entire point of the table: the
     * retention sweep purges the refresh these readings came from, and the
     * readings have to outlive it. Cascade would hand the sweep the history it
     * was built to escape.
     */
    refreshId: text("refresh_id").references(() => siteRefreshes.id, { onDelete: "set null" }),
    /** Copied off the refresh, never derived from it: the row has to date itself once the FK is null. */
    capturedAt: instant("captured_at").notNull(),
    /** A dotted key, e.g. `geo.score`. */
    metric: text("metric").notNull(),
    /**
     * `null` means the section ran and could not answer — deliberately distinct
     * from the row being absent, which means the section did not run. Neither is
     * ever written as 0: a timed-out PageSpeed recorded as "performance: 0" is
     * an invented failure.
     */
    value: real("value"),
    /** Only the scored sections carry a letter. */
    grade: text("grade"),
  },
  (t) => [
    // The trend query: one metric for one Site over time.
    index("idx_site_metric_history_series").on(t.siteId, t.metric, t.capturedAt),
    // Idempotent extraction: re-running against the same refresh cannot
    // double-write. Rows whose refresh has been purged hold NULL here and are
    // exempt, which is correct — nothing writes a reading for a refresh that no
    // longer exists.
    uniqueIndex("uq_site_metric_history_refresh_metric").on(t.refreshId, t.metric),
  ],
);

/** What one month's readings summarised to, once the detail is swept. */
export const siteMetricMonthly = sqliteTable(
  "site_metric_monthly",
  {
    id: id(),
    siteId: text("site_id")
      .notNull()
      .references(() => sites.id, { onDelete: "cascade" }),
    /**
     * `YYYY-MM`, as text.
     *
     * The one column that does **not** use `instant()`, on purpose. A month is a
     * calendar grain, not a point in time: encoding it as an instant would force
     * a decision about which millisecond of which timezone it starts at, and
     * every reader would then have to undo that decision to get the month back.
     * Text sorts correctly, reads correctly in a query, and cannot be off by an
     * hour.
     */
    month: text("month").notNull(),
    /**
     * How many refreshes formed this month. A month built from one reading and
     * one built from four are not comparable, and without this nothing
     * downstream can tell.
     */
    readings: integer("readings").notNull(),
    /**
     * `{ "geo.score": { last, min, max } }`.
     *
     * The single JSON column, and bounded on purpose — one key per registered
     * metric, a count that does not grow with the Site. An *unbounded* JSON
     * column converges on a second, schemaless database; that argument does not
     * reach this one.
     */
    metrics: text("metrics", { mode: "json" }).notNull().$type<Record<string, unknown>>(),
    createdAt: instant("created_at").notNull(),
    updatedAt: instant("updated_at").notNull(),
  },
  (t) => [
    index("idx_site_metric_monthly_series").on(t.siteId, t.month),
    // One row per Site per month, so a re-run recomputes rather than duplicates.
    uniqueIndex("uq_site_metric_monthly_site_month").on(t.siteId, t.month),
  ],
);

/** A single page's audit, kept so it can be compared against itself later. */
export const pageAudits = sqliteTable(
  "page_audits",
  {
    id: id(),
    siteId: text("site_id")
      .notNull()
      .references(() => sites.id, { onDelete: "cascade" }),
    url: text("url").notNull(),
    contextJson: text("context_json"),
    createdAt: instant("created_at").notNull(),
    updatedAt: instant("updated_at").notNull(),
  },
  (t) => [
    uniqueIndex("uq_page_audits_site_url").on(t.siteId, t.url),
    index("idx_page_audits_site").on(t.siteId, t.updatedAt),
  ],
);

/**
 * A Tool's result, kept so repeating an analysis does not re-crawl the site.
 *
 * `domain` is stored beside the key rather than only inside it, so an Operator
 * can be told what is cached and a Site's entries can be dropped when its data
 * changes — neither of which is possible against an opaque hash.
 */
export const toolCache = sqliteTable(
  "tool_cache",
  {
    id: id(),
    toolName: text("tool_name").notNull(),
    /** A hash of the Tool name and its arguments. See `tool-cache.ts`. */
    cacheKey: text("cache_key").notNull(),
    resultJson: text("result_json").notNull(),
    /** The Site this entry is about, where the Tool's arguments name one. */
    domain: text("domain"),
    expiresAt: instant("expires_at").notNull(),
    createdAt: instant("created_at").notNull(),
  },
  (t) => [
    // Also the lookup index: a separate one on `cache_key` would be redundant.
    uniqueIndex("uq_tool_cache_key").on(t.cacheKey),
    // The eviction sweep's `WHERE expires_at < now()`.
    index("idx_tool_cache_expires").on(t.expiresAt),
    index("idx_tool_cache_domain").on(t.domain),
  ],
);

/**
 * Everything the server has been told about itself: Google tokens, and whatever
 * later needs to survive a restart.
 *
 * A key/value table rather than columns, because the alternative is a migration
 * every time one setting is added, and there is exactly one row per key on one
 * machine. Values are text; a caller that wants JSON encodes it.
 */
export const configuration = sqliteTable("configuration", {
  key: text("key").primaryKey(),
  value: text("value").notNull(),
  updatedAt: instant("updated_at")
    .notNull()
    .default(sql`(unixepoch() * 1000)`),
});

export type Site = typeof sites.$inferSelect;
export type SiteRefresh = typeof siteRefreshes.$inferSelect;
export type SiteMetricReading = typeof siteMetricHistory.$inferSelect;
export type SiteMetricMonth = typeof siteMetricMonthly.$inferSelect;
export type PageAudit = typeof pageAudits.$inferSelect;
export type ToolCacheEntry = typeof toolCache.$inferSelect;
