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
  /**
   * `final` (Google's default) returns finalised days only. `all` adds the days
   * still being collected, and `hourly_all` is required to group by `hour` —
   * Google keeps the hourly breakdown for the last ten days.
   */
  dataState?: "final" | "all" | "hourly_all";
}

export interface SearchAnalyticsRow {
  keys?: string[];
  clicks: number;
  impressions: number;
  ctr: number;
  position: number;
}

/**
 * Rows, and what Google says about how complete they are.
 *
 * Search Console only reports the first incomplete day or hour when asked for
 * fresh data (`dataState: all` or `hourly_all`) and grouped by `date` or
 * `hour`. Absent means "none of this is partial", or that it was not asked.
 */
export interface SearchAnalyticsResult {
  rows: SearchAnalyticsRow[];
  /** `YYYY-MM-DD`, Pacific Time. Every date from this one on is still being collected. */
  firstIncompleteDate?: string;
  /** ISO-8601 with offset, Pacific Time. Every hour from this one on is still being collected. */
  firstIncompleteHour?: string;
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
  /**
   * The rows alone.
   *
   * A `rowLimit` above Google's 25,000-row page is read in pages, so the limit
   * a caller gives is the number of rows it can get back, not the page size.
   */
  searchAnalytics(query: SearchAnalyticsQuery): Promise<SearchAnalyticsRow[]>;
  /** {@link searchAnalytics}, with Google's statement of which days are still partial. */
  searchAnalyticsWithMetadata(query: SearchAnalyticsQuery): Promise<SearchAnalyticsResult>;
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
  /**
   * `["TOTAL"]` for a report whose `totals` a caller reads. Google fills
   * `totals` only when asked — "If requested, the totaled values of metrics" —
   * so a report that does not ask comes back with none, and a denominator read
   * off it is missing rather than small.
   */
  metricAggregations?: Array<"TOTAL" | "MAXIMUM" | "MINIMUM" | "COUNT">;
  limit?: number;
  offset?: number;
  keepEmptyRows?: boolean;
  /** Ask Google to report the property's quota as it stands after this request. */
  returnPropertyQuota?: boolean;
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
  propertyQuota?: Ga4PropertyQuota;
  kind?: string;
}

/** One quota's state after a request: how much it spent, and how much is left. */
export interface Ga4QuotaStatus {
  consumed?: number;
  remaining?: number;
}

/**
 * A property's Data API quota, as Google reports it.
 *
 * Every limit is per property, and exhausting any one of them refuses every
 * request to that property until it refills — the daily ones at midnight
 * Pacific, the hourly ones on a rolling basis.
 */
export interface Ga4PropertyQuota {
  tokensPerDay?: Ga4QuotaStatus;
  tokensPerHour?: Ga4QuotaStatus;
  tokensPerProjectPerHour?: Ga4QuotaStatus;
  concurrentRequests?: Ga4QuotaStatus;
  serverErrorsPerProjectPerHour?: Ga4QuotaStatus;
  potentiallyThresholdedRequestsPerHour?: Ga4QuotaStatus;
}

/**
 * One step of a funnel: the users who fired this event, in order.
 *
 * The Data API takes an arbitrary filter expression per step. Every step here is
 * one event, optionally on one page, because that is the funnel an Operator can
 * describe in a sentence — and the one a caller can get wrong in fewest ways.
 */
export interface Ga4FunnelStep {
  name: string;
  eventName: string;
  /** Restrict the step to events on pages whose path starts with this. */
  pagePathPrefix?: string;
}

export interface Ga4FunnelQuery {
  property: string;
  dateRanges: Array<{ startDate: string; endDate: string }>;
  steps: Ga4FunnelStep[];
  /** Open: a user may enter at any step. Closed (the default): only at the first. */
  isOpenFunnel?: boolean;
  /** One dimension to break the funnel table down by, e.g. `deviceCategory`. */
  breakdownDimension?: string;
}

/** The funnel table, one of the two sub-reports Google returns. */
export interface Ga4FunnelReport {
  funnelTable?: Pick<Ga4Report, "dimensionHeaders" | "metricHeaders" | "rows" | "metadata">;
  propertyQuota?: Ga4PropertyQuota;
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
  /** Data API v1alpha. Google may change its shape without a version bump. */
  runFunnelReport(query: Ga4FunnelQuery): Promise<Ga4FunnelReport>;
}

// ── Analytics configuration (Admin API) ──────────────────────────────────────
//
// How a property is set up, as opposed to what it measured. Every method here
// is a GET that `analytics.readonly` is allowed to make. Several are v1alpha,
// marked on each, because that is the only version Google publishes them in.
//
// Deliberately absent: `measurementProtocolSecrets`, which returns the secret
// value itself under the read-only scope. Nothing here needs a credential for
// somebody else's tracking, and not reading it is how none gets printed.

/** `YYYY-MM-DD`-able, the way Google writes a calendar date. */
export interface Ga4Date {
  year?: number;
  month?: number;
  day?: number;
}

export interface Ga4PropertyDetails {
  name: string;
  displayName?: string;
  timeZone?: string;
  currencyCode?: string;
  industryCategory?: string;
  /** `GOOGLE_ANALYTICS_STANDARD` or `GOOGLE_ANALYTICS_360`. */
  serviceLevel?: string;
  /** `PROPERTY_TYPE_ORDINARY`, `PROPERTY_TYPE_SUBPROPERTY`, `PROPERTY_TYPE_ROLLUP`. */
  propertyType?: string;
  createTime?: string;
}

export interface Ga4DataRetention {
  /** `TWO_MONTHS`, `FOURTEEN_MONTHS`, `TWENTY_SIX_MONTHS`, `THIRTY_EIGHT_MONTHS`, `FIFTY_MONTHS`. */
  eventDataRetention?: string;
  userDataRetention?: string;
  resetUserDataOnNewActivity?: boolean;
}

export interface Ga4DataStream {
  /** `properties/123/dataStreams/456`, the form the stream-level calls want. */
  name: string;
  /** `WEB_DATA_STREAM`, `ANDROID_APP_DATA_STREAM`, `IOS_APP_DATA_STREAM`. */
  type?: string;
  displayName?: string;
  webStreamData?: { measurementId?: string; defaultUri?: string };
}

export interface Ga4EnhancedMeasurement {
  streamEnabled?: boolean;
  scrollsEnabled?: boolean;
  outboundClicksEnabled?: boolean;
  siteSearchEnabled?: boolean;
  videoEngagementEnabled?: boolean;
  fileDownloadsEnabled?: boolean;
  pageChangesEnabled?: boolean;
  formInteractionsEnabled?: boolean;
  searchQueryParameter?: string;
}

export interface Ga4DataRedaction {
  emailRedactionEnabled?: boolean;
  queryParameterRedactionEnabled?: boolean;
  queryParameterKeys?: string[];
}

export interface Ga4KeyEvent {
  eventName?: string;
  /** `ONCE_PER_EVENT` or `ONCE_PER_SESSION`. */
  countingMethod?: string;
  custom?: boolean;
  createTime?: string;
}

export interface Ga4AttributionSettings {
  reportingAttributionModel?: string;
  acquisitionConversionEventLookbackWindow?: string;
  otherConversionEventLookbackWindow?: string;
}

export interface Ga4GoogleSignals {
  /** `GOOGLE_SIGNALS_ENABLED` or `GOOGLE_SIGNALS_DISABLED`. */
  state?: string;
}

export interface Ga4ReportingIdentity {
  /** `BLENDED`, `OBSERVED` or `DEVICE_BASED`. */
  reportingIdentity?: string;
}

export interface Ga4ChannelGroup {
  name: string;
  displayName?: string;
  systemDefined?: boolean;
  primary?: boolean;
}

export interface Ga4Link {
  name: string;
  /** Google Ads customer id, or the BigQuery project, depending on the link. */
  target?: string;
}

export interface Ga4Annotation {
  title?: string;
  description?: string;
  /** One day, or… */
  annotationDate?: Ga4Date;
  /** …a range. Google sets exactly one of the two. */
  annotationDateRange?: { startDate?: Ga4Date; endDate?: Ga4Date };
  /** Written by Google rather than by a person on the property. */
  systemGenerated?: boolean;
}

export interface AnalyticsAdminReader {
  getProperty(property: string): Promise<Ga4PropertyDetails>;
  getDataRetention(property: string): Promise<Ga4DataRetention>;
  listDataStreams(property: string): Promise<Ga4DataStream[]>;
  /** v1alpha. Web streams only; `stream` is a {@link Ga4DataStream.name}. */
  getEnhancedMeasurement(stream: string): Promise<Ga4EnhancedMeasurement>;
  /** v1alpha. Web streams only. */
  getDataRedaction(stream: string): Promise<Ga4DataRedaction>;
  listKeyEvents(property: string): Promise<Ga4KeyEvent[]>;
  /** v1alpha. */
  getAttributionSettings(property: string): Promise<Ga4AttributionSettings>;
  /** v1alpha. */
  getGoogleSignals(property: string): Promise<Ga4GoogleSignals>;
  /** v1alpha. */
  getReportingIdentity(property: string): Promise<Ga4ReportingIdentity>;
  /** v1alpha. Custom groups and the system-defined one. */
  listChannelGroups(property: string): Promise<Ga4ChannelGroup[]>;
  listGoogleAdsLinks(property: string): Promise<Ga4Link[]>;
  /** v1alpha. */
  listBigQueryLinks(property: string): Promise<Ga4Link[]>;
  /** v1alpha. Every annotation on the property, oldest first. */
  listAnnotations(property: string): Promise<Ga4Annotation[]>;
}

/** Everything a Tool can read from Google. */
export interface GoogleReader {
  searchConsole: SearchConsoleReader;
  analytics: AnalyticsReader;
  analyticsAdmin: AnalyticsAdminReader;
}
