/**
 * {@link GoogleReader} against fixtures: no network, no Google account.
 *
 * ── Why this ships in `src/` rather than in `tests/` ──
 *
 * It is the other half of the interface's contract. `reader.ts` says what the
 * shapes are; this says what a *plausible* instance of each shape looks like,
 * and the two have to be edited together. Living beside the interface makes that
 * obvious, and means a Tool's test does not have to invent a property list from
 * scratch to assert one line of output.
 *
 * It is also the answer to why the retired suite covered these Tools worst: a
 * test needed an account, a project, a verified property and data in it. Here it
 * needs an object literal.
 *
 * ── What a fixture is allowed to be ──
 *
 * Plausible, and **not tidy**. The defaults below carry the shapes that break
 * naive Tools: a Domain Property *and* a URL-Prefix Property, because Google
 * gives an Operator whichever they set up; a row with no `keys`, because an
 * unfiltered query returns one; an inspection verdict that is not `PASS`. A
 * fixture where everything is well-formed tests the happy path and hides the
 * rest.
 *
 * Every method can be overridden per test, and **no default is empty**. That is
 * the property this file exists to hold: an unstubbed call returning `[]` lets a
 * test pass while asserting nothing, so a test that forgot to stub a method it
 * depends on would look like a test that verified something.
 *
 * This paragraph used to say that an unspecified method "throws — never returns
 * empty", which was never true of any of the eleven and contradicted the
 * argument for the defaults ten lines below: a test that only cares about
 * `listProperties` says so and inherits sensible answers for the rest. Throwing
 * and returning a rich fixture are two different ways to close the same hole,
 * and this file chose the second one on purpose. `fake-reader.test.ts` pins that
 * it stays closed.
 */
import type {
  Ga4Annotation,
  Ga4Compatibility,
  Ga4DataStream,
  Ga4FunnelReport,
  Ga4KeyEvent,
  Ga4Metadata,
  Ga4PropertyDetails,
  Ga4Property,
  Ga4Report,
  GoogleReader,
  GscProperty,
  SearchAnalyticsRow,
  Sitemap,
  UrlInspection,
} from "./reader";

/** Both property shapes, because both reach the Tools. */
export const FAKE_GSC_PROPERTIES: GscProperty[] = [
  { siteUrl: "sc-domain:example.com", permissionLevel: "siteOwner" },
  { siteUrl: "https://shop.example.com/", permissionLevel: "siteFullUser" },
  // An Operator can hold a property they cannot read data for. A Tool that
  // reports this one as available is wrong about Property Access.
  { siteUrl: "https://unverified.example.net/", permissionLevel: "siteUnverifiedUser" },
];

/**
 * What an unfiltered query returns: one row, with no `keys`, holding the
 * property's totals.
 *
 * Kept separate because it is a different answer to a different question, and a
 * fake that returned the keyed rows below for a dimensionless query would let a
 * Tool read a single query's clicks as the whole site's — which is exactly the
 * mistake the real API's shape invites.
 */
export const FAKE_SITE_TOTAL_ROW: SearchAnalyticsRow = {
  clicks: 494,
  impressions: 13920,
  ctr: 0.0355,
  position: 7.9,
};

export const FAKE_SEARCH_ANALYTICS_ROWS: SearchAnalyticsRow[] = [
  { keys: ["seo audit tool"], clicks: 120, impressions: 4300, ctr: 0.0279, position: 8.4 },
  { keys: ["free seo checker"], clicks: 64, impressions: 9100, ctr: 0.007, position: 14.2 },
  { keys: ["example.com"], clicks: 310, impressions: 520, ctr: 0.596, position: 1.2 },
];

export const FAKE_URL_INSPECTION: UrlInspection = {
  inspectionResult: {
    indexStatusResult: {
      verdict: "PASS",
      coverageState: "Submitted and indexed",
      robotsTxtState: "ALLOWED",
      indexingState: "INDEXING_ALLOWED",
      lastCrawlTime: "2026-08-20T04:11:00Z",
      googleCanonical: "https://example.com/page",
      userCanonical: "https://example.com/page",
    },
    mobileUsabilityResult: { verdict: "PASS" },
    richResultsResult: { verdict: "PASS", detectedItems: [] },
  },
};

export const FAKE_SITEMAPS: Sitemap[] = [
  {
    path: "https://example.com/sitemap.xml",
    lastSubmitted: "2026-08-01T00:00:00Z",
    lastDownloaded: "2026-08-28T02:00:00Z",
    isPending: false,
    isSitemapsIndex: true,
    type: "sitemapIndex",
    warnings: "2",
    errors: "0",
    contents: [{ type: "web", submitted: "412", indexed: "398" }],
  },
];

export const FAKE_GA4_PROPERTIES: Ga4Property[] = [
  { name: "properties/123456789", displayName: "example.com — GA4", account: "Example Ltd" },
  { name: "properties/987654321", displayName: "shop.example.com — GA4", account: "Example Ltd" },
];

export const FAKE_GA4_REPORT: Ga4Report = {
  dimensionHeaders: [{ name: "sessionDefaultChannelGroup" }],
  metricHeaders: [{ name: "sessions", type: "TYPE_INTEGER" }],
  rows: [
    { dimensionValues: [{ value: "Organic Search" }], metricValues: [{ value: "8421" }] },
    { dimensionValues: [{ value: "Direct" }], metricValues: [{ value: "2110" }] },
    { dimensionValues: [{ value: "Referral" }], metricValues: [{ value: "634" }] },
  ],
  totals: [{ metricValues: [{ value: "11165" }] }],
  rowCount: 3,
  // Both flags Google sets, because a report presented as complete when it is
  // sampled or thresholded is the failure this codebase keeps guarding against.
  metadata: { currencyCode: "EUR", timeZone: "Europe/Madrid", dataLossFromOtherRow: false },
};

export const FAKE_GA4_METADATA: Ga4Metadata = {
  dimensions: [
    { apiName: "sessionDefaultChannelGroup", uiName: "Session default channel group" },
    { apiName: "customUser:plan", uiName: "Plan", customDefinition: true },
  ],
  metrics: [
    { apiName: "sessions", uiName: "Sessions", type: "TYPE_INTEGER" },
    { apiName: "keyEvents", uiName: "Key events", type: "TYPE_INTEGER" },
  ],
};

export const FAKE_GA4_COMPATIBILITY: Ga4Compatibility = {
  dimensionCompatibilities: [
    { dimensionMetadata: { apiName: "sessionDefaultChannelGroup" }, compatibility: "COMPATIBLE" },
  ],
  metricCompatibilities: [
    { metricMetadata: { apiName: "sessions" }, compatibility: "COMPATIBLE" },
    { metricMetadata: { apiName: "adRevenue" }, compatibility: "INCOMPATIBLE" },
  ],
};

export const FAKE_GA4_FUNNEL: Ga4FunnelReport = {
  funnelTable: {
    dimensionHeaders: [{ name: "funnelStepName" }],
    metricHeaders: [
      { name: "activeUsers", type: "TYPE_INTEGER" },
      { name: "funnelStepCompletionRate", type: "TYPE_FLOAT" },
      { name: "funnelStepAbandonments", type: "TYPE_INTEGER" },
    ],
    rows: [
      {
        dimensionValues: [{ value: "1. Landing" }],
        metricValues: [{ value: "1200" }, { value: "0.31" }, { value: "828" }],
      },
      {
        dimensionValues: [{ value: "2. Pricing" }],
        metricValues: [{ value: "372" }, { value: "0.12" }, { value: "327" }],
      },
      {
        dimensionValues: [{ value: "3. Sign up" }],
        metricValues: [{ value: "45" }, { value: "0" }, { value: "0" }],
      },
    ],
  },
};

/**
 * A property set up the way properties usually are: default retention of two
 * months, which is the setting most worth noticing, and one web stream.
 */
export const FAKE_GA4_PROPERTY_DETAILS: Ga4PropertyDetails = {
  name: "properties/123456789",
  displayName: "example.com — GA4",
  timeZone: "Europe/Madrid",
  currencyCode: "EUR",
  industryCategory: "TECHNOLOGY",
  serviceLevel: "GOOGLE_ANALYTICS_STANDARD",
  propertyType: "PROPERTY_TYPE_ORDINARY",
  createTime: "2023-03-14T09:00:00Z",
};

export const FAKE_GA4_DATA_STREAMS: Ga4DataStream[] = [
  {
    name: "properties/123456789/dataStreams/555",
    type: "WEB_DATA_STREAM",
    displayName: "example.com",
    webStreamData: { measurementId: "G-EXAMPLE123", defaultUri: "https://example.com" },
  },
];

export const FAKE_GA4_KEY_EVENTS: Ga4KeyEvent[] = [
  { eventName: "purchase", countingMethod: "ONCE_PER_EVENT", custom: false },
  { eventName: "generate_lead", countingMethod: "ONCE_PER_SESSION", custom: true },
];

export const FAKE_GA4_ANNOTATIONS: Ga4Annotation[] = [
  {
    title: "New pricing page",
    description: "Launched the redesigned pricing page",
    annotationDate: { year: 2026, month: 8, day: 12 },
  },
  {
    title: "Consent banner rollout",
    annotationDateRange: {
      startDate: { year: 2026, month: 7, day: 1 },
      endDate: { year: 2026, month: 7, day: 3 },
    },
    systemGenerated: false,
  },
];

/**
 * A reader whose methods are all stubbed unless overridden.
 *
 * Deep-partial on purpose: a test that only cares about `listProperties` says so
 * and inherits sensible answers for the rest, while a test about one method's
 * failure can make just that one throw.
 */
export type FakeGoogleReader = {
  searchConsole: Partial<GoogleReader["searchConsole"]>;
  analytics: Partial<GoogleReader["analytics"]>;
  analyticsAdmin: Partial<GoogleReader["analyticsAdmin"]>;
};

export function fakeGoogleReader(overrides: Partial<FakeGoogleReader> = {}): GoogleReader {
  // Dimensionless means "the property's totals", which is a different row
  // from any of the keyed ones. See `FAKE_SITE_TOTAL_ROW`.
  const searchAnalytics =
    overrides.searchConsole?.searchAnalytics ??
    (async (query: Parameters<GoogleReader["searchConsole"]["searchAnalytics"]>[0]) =>
      (query.dimensions?.length ?? 0) === 0 ? [FAKE_SITE_TOTAL_ROW] : FAKE_SEARCH_ANALYTICS_ROWS);

  return {
    searchConsole: {
      listProperties: async () => FAKE_GSC_PROPERTIES,
      searchAnalytics,
      // Follows whatever `searchAnalytics` answers, so a test that stubs the
      // rows once gets them through either method and cannot pass by stubbing
      // the one the Tool does not call.
      searchAnalyticsWithMetadata: async (query) => ({ rows: await searchAnalytics(query) }),
      inspectUrl: async () => FAKE_URL_INSPECTION,
      listSitemaps: async () => FAKE_SITEMAPS,
      getSitemap: async () => FAKE_SITEMAPS[0],
      ...overrides.searchConsole,
    },
    analytics: {
      listProperties: async () => FAKE_GA4_PROPERTIES,
      // Totals only when asked, as Google does ("If requested, the totaled values
      // of metrics"). The fixture sent them unconditionally, which is how three
      // Tools shipped reading a `totals` the live API never returned: every test
      // passed and `run_site_audit` recorded zero sessions on every real run.
      runReport: async (query) =>
        query.metricAggregations?.includes("TOTAL") ? FAKE_GA4_REPORT : { ...FAKE_GA4_REPORT, totals: undefined },
      runPivotReport: async () => FAKE_GA4_REPORT,
      runRealtimeReport: async () => FAKE_GA4_REPORT,
      getMetadata: async () => FAKE_GA4_METADATA,
      checkCompatibility: async () => FAKE_GA4_COMPATIBILITY,
      runFunnelReport: async () => FAKE_GA4_FUNNEL,
      ...overrides.analytics,
    },
    analyticsAdmin: {
      getProperty: async () => FAKE_GA4_PROPERTY_DETAILS,
      getDataRetention: async () => ({
        eventDataRetention: "TWO_MONTHS",
        userDataRetention: "FOURTEEN_MONTHS",
        resetUserDataOnNewActivity: true,
      }),
      listDataStreams: async () => FAKE_GA4_DATA_STREAMS,
      getEnhancedMeasurement: async () => ({
        streamEnabled: true,
        scrollsEnabled: true,
        outboundClicksEnabled: true,
        siteSearchEnabled: false,
        videoEngagementEnabled: true,
        fileDownloadsEnabled: true,
        pageChangesEnabled: true,
        formInteractionsEnabled: false,
      }),
      getDataRedaction: async () => ({ emailRedactionEnabled: true, queryParameterRedactionEnabled: false }),
      listKeyEvents: async () => FAKE_GA4_KEY_EVENTS,
      getAttributionSettings: async () => ({
        reportingAttributionModel: "PAID_AND_ORGANIC_CHANNELS_DATA_DRIVEN",
        acquisitionConversionEventLookbackWindow: "ACQUISITION_CONVERSION_EVENT_LOOKBACK_WINDOW_30_DAYS",
        otherConversionEventLookbackWindow: "OTHER_CONVERSION_EVENT_LOOKBACK_WINDOW_90_DAYS",
      }),
      getGoogleSignals: async () => ({ state: "GOOGLE_SIGNALS_DISABLED" }),
      getReportingIdentity: async () => ({ reportingIdentity: "BLENDED" }),
      listChannelGroups: async () => [
        { name: "properties/123456789/channelGroups/1", displayName: "Default Channel Group", systemDefined: true, primary: true },
      ],
      listGoogleAdsLinks: async () => [{ name: "properties/123456789/googleAdsLinks/7", target: "123-456-7890" }],
      listBigQueryLinks: async () => [{ name: "properties/123456789/bigQueryLinks/9", target: "projects/example-analytics" }],
      listAnnotations: async () => FAKE_GA4_ANNOTATIONS,
      ...overrides.analyticsAdmin,
    },
  };
}
