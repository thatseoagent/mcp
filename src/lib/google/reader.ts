/**
 * The one interface that represents reading Google.
 *
 * ── Why an interface at all ──
 *
 * The retired suite covered the Search Console and Analytics Tools worst, and
 * the reason was structural rather than anyone's fault: those Tools reached for
 * an ambient auth client, so testing one meant having a Google account, a
 * project, a property with data in it, and a network. Nobody does that in a unit
 * suite, so nobody tested them.
 *
 * A Tool that is *handed* what it reads from can be tested against a fixture. So
 * every Google-reading Tool takes a {@link GoogleReader} as an argument, and the
 * two implementations — {@link createGoogleReader} against the real API,
 * `fakeGoogleReader()` against fixtures — are interchangeable by construction.
 *
 * ── No ambient auth state, anywhere ──
 *
 * The retired implementation carried its OAuth client in an `AsyncLocalStorage`,
 * because on a shared serverless runtime module scope meant one user's tokens
 * answering another user's request. That hazard does not exist here: a
 * **Single-tenant** server has one Operator and no callers to isolate. Porting
 * the machinery anyway would have carried the complexity without the reason, and
 * would have left a thread-local that a future contributor could mistake for a
 * per-caller boundary that this server does not have.
 *
 * The access token is fetched per call from the token store, which refreshes it
 * when needed. Nothing is held between calls except the tokens themselves, in
 * the database, where they belong.
 *
 * ── What is deliberately not in this interface ──
 *
 * Interpretation. This is the shape of what Google returns, named in Google's
 * terms. Quick wins, cannibalization and trends are analyzers that read these
 * rows; putting them here would make every one of them untestable again for
 * exactly the reason above.
 */

// ── Search Console ───────────────────────────────────────────────────────────

/**
 * How Google names a Site on its side.
 *
 * Two shapes, and they are not interchangeable — `CONTEXT.md` is explicit about
 * it. A **Domain Property** (`sc-domain:example.com`) covers every subdomain and
 * both schemes. A **URL-Prefix Property** (`https://example.com/`) covers
 * exactly what its prefix says. Google gives an Operator whichever they set up,
 * so both are handled everywhere rather than one being normalised into the other.
 */
export interface GscProperty {
  /** The identifier Google expects back in every later call. */
  siteUrl: string;
  /** `siteOwner`, `siteFullUser`, `siteRestrictedUser`, `siteUnverifiedUser`. */
  permissionLevel: string;
}

export interface SearchAnalyticsQuery {
  siteUrl: string;
  /** `YYYY-MM-DD`, inclusive. */
  startDate: string;
  endDate: string;
  /** `query`, `page`, `country`, `device`, `date`, `searchAppearance`. */
  dimensions?: string[];
  /** `web`, `image`, `video`, `news`, `discover`, `googleNews`. */
  type?: string;
  rowLimit?: number;
  startRow?: number;
  dimensionFilterGroups?: unknown[];
  /** `auto`, `byPage`, `byProperty`, `byNewsShowcasePanel`. */
  aggregationType?: string;
}

export interface SearchAnalyticsRow {
  keys?: string[];
  clicks: number;
  impressions: number;
  ctr: number;
  position: number;
}

export interface UrlInspection {
  /** Google's own `inspectionResult`, passed through rather than reshaped. */
  inspectionResult: Record<string, unknown>;
}

export interface Sitemap {
  path?: string;
  lastSubmitted?: string;
  lastDownloaded?: string;
  isPending?: boolean;
  isSitemapsIndex?: boolean;
  type?: string;
  warnings?: string;
  errors?: string;
  contents?: Array<{ type?: string; submitted?: string; indexed?: string }>;
}

export interface SearchConsoleReader {
  listProperties(): Promise<GscProperty[]>;
  searchAnalytics(query: SearchAnalyticsQuery): Promise<SearchAnalyticsRow[]>;
  /**
   * @param siteUrl the property the URL belongs to. Google requires it: the same
   *        URL can sit under more than one property an Operator holds.
   */
  inspectUrl(siteUrl: string, inspectionUrl: string): Promise<UrlInspection>;
  listSitemaps(siteUrl: string): Promise<Sitemap[]>;
  getSitemap(siteUrl: string, feedpath: string): Promise<Sitemap>;
}

// ── Analytics ────────────────────────────────────────────────────────────────

export interface Ga4Property {
  /** `properties/123456789`, which is the form every later call wants. */
  name: string;
  displayName: string;
  /** The account it belongs to, so an Operator with many can tell them apart. */
  account?: string;
}

export interface Ga4ReportQuery {
  /** `properties/123456789` or the bare id; the reader accepts either. */
  property: string;
  dateRanges: Array<{ startDate: string; endDate: string; name?: string }>;
  dimensions?: string[];
  metrics?: string[];
  dimensionFilter?: unknown;
  metricFilter?: unknown;
  orderBys?: unknown[];
  limit?: number;
  offset?: number;
  keepEmptyRows?: boolean;
}

export interface Ga4PivotQuery extends Ga4ReportQuery {
  pivots: unknown[];
}

export interface Ga4RealtimeQuery {
  property: string;
  dimensions?: string[];
  metrics?: string[];
  limit?: number;
}

/**
 * A GA4 report, in the shape the Data API returns it.
 *
 * `rowCount` and `metadata` are carried because they are how a caller tells a
 * truncated report from a complete one, and sampled data from exact — a report
 * presented as complete when it is neither is the failure this whole codebase
 * keeps guarding against.
 */
export interface Ga4Report {
  dimensionHeaders?: Array<{ name?: string }>;
  metricHeaders?: Array<{ name?: string; type?: string }>;
  rows?: Array<{
    dimensionValues?: Array<{ value?: string }>;
    metricValues?: Array<{ value?: string }>;
  }>;
  totals?: Array<{ metricValues?: Array<{ value?: string }> }>;
  rowCount?: number;
  metadata?: Record<string, unknown>;
  propertyQuota?: Record<string, unknown>;
  kind?: string;
}

export interface Ga4Metadata {
  dimensions?: Array<{ apiName?: string; uiName?: string; description?: string; customDefinition?: boolean }>;
  metrics?: Array<{ apiName?: string; uiName?: string; description?: string; customDefinition?: boolean; type?: string }>;
}

export interface Ga4Compatibility {
  dimensionCompatibilities?: Array<{
    dimensionMetadata?: { apiName?: string };
    compatibility?: string;
  }>;
  metricCompatibilities?: Array<{
    metricMetadata?: { apiName?: string };
    compatibility?: string;
  }>;
}

export interface AnalyticsReader {
  listProperties(): Promise<Ga4Property[]>;
  runReport(query: Ga4ReportQuery): Promise<Ga4Report>;
  runPivotReport(query: Ga4PivotQuery): Promise<Ga4Report>;
  runRealtimeReport(query: Ga4RealtimeQuery): Promise<Ga4Report>;
  getMetadata(property: string): Promise<Ga4Metadata>;
  checkCompatibility(query: Ga4ReportQuery): Promise<Ga4Compatibility>;
}

/** Everything a Tool can read from Google. */
export interface GoogleReader {
  searchConsole: SearchConsoleReader;
  analytics: AnalyticsReader;
}
