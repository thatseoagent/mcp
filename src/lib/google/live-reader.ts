/**
 * {@link GoogleReader} against the real Google APIs.
 *
 * ── Plain `fetch`, not `googleapis` ──
 *
 * The retired product depended on `googleapis`, which is generated from Google's
 * discovery documents and carries every API Google publishes — tens of
 * megabytes for the handful of endpoints below. These are ordinary JSON endpoints
 * behind a bearer token, and writing them out makes the surface this server
 * actually touches legible in one file instead of implied by a client library.
 *
 * The cost is that Google's response shapes are ours to describe, which is what
 * `reader.ts` is. That is a cost worth paying: those types are the contract the
 * fake implementation has to satisfy, and a generated client would have given us
 * a much larger contract than we need.
 *
 * ── Auth is per call ──
 *
 * `accessToken()` is asked on every request rather than once at construction. It
 * refreshes when the stored token has expired, so a long-running server never
 * hands out a stale one — and nothing is cached here that could go stale in the
 * first place. See `reader.ts` on why there is no ambient auth state.
 */
import { UpstreamApiError } from "../upstream-api-error";
import { accessToken } from "./oauth";
import type {
  AnalyticsAdminReader,
  AnalyticsReader,
  Ga4Annotation,
  Ga4AttributionSettings,
  Ga4ChannelGroup,
  Ga4Compatibility,
  Ga4DataRedaction,
  Ga4DataRetention,
  Ga4DataStream,
  Ga4EnhancedMeasurement,
  Ga4FunnelQuery,
  Ga4FunnelReport,
  Ga4GoogleSignals,
  Ga4KeyEvent,
  Ga4Link,
  Ga4Metadata,
  Ga4PivotQuery,
  Ga4Property,
  Ga4RealtimeQuery,
  Ga4Report,
  Ga4ReportQuery,
  Ga4PropertyDetails,
  Ga4ReportingIdentity,
  GoogleReader,
  GscProperty,
  SearchAnalyticsQuery,
  SearchAnalyticsResult,
  SearchAnalyticsRow,
  SearchConsoleReader,
  Sitemap,
  UrlInspection,
} from "./reader";

const SEARCH_CONSOLE = "https://searchconsole.googleapis.com";
const ANALYTICS_DATA = "https://analyticsdata.googleapis.com/v1beta";
const ANALYTICS_DATA_ALPHA = "https://analyticsdata.googleapis.com/v1alpha";
const ANALYTICS_ADMIN = "https://analyticsadmin.googleapis.com/v1beta";
const ANALYTICS_ADMIN_ALPHA = "https://analyticsadmin.googleapis.com/v1alpha";

/** Google's ceiling for one Search Analytics request. */
const SEARCH_ANALYTICS_PAGE = 25_000;

/** Google's default when `rowLimit` is not sent, kept so an unset limit means what it meant. */
const SEARCH_ANALYTICS_DEFAULT_LIMIT = 1_000;

/** How Google's APIs are named in a refusal, in the Operator's terms. */
const GSC_SERVICE = "Google Search Console";
const GA4_SERVICE = "Google Analytics";

/** Long enough for a wide Search Console query, short enough to be a bound. */
const REQUEST_TIMEOUT_MS = 60_000;

/**
 * One authenticated JSON request.
 *
 * `fetch` directly rather than through `http-client.ts`, and the difference is
 * the subject: that module fetches *the Operator's site* and therefore owes it
 * robots.txt compliance, pacing and an SSRF check on a caller-supplied URL. This
 * is a fixed Google endpoint reached with the Operator's own credentials. Gating
 * it on a stranger's robots.txt would be nonsense, and pacing our own quota
 * against ourselves would just make reports slower.
 */
async function call<T>(service: string, url: string, body?: unknown): Promise<T> {
  const token = await accessToken();

  const response = await fetch(url, {
    method: body === undefined ? "GET" : "POST",
    headers: {
      authorization: `Bearer ${token}`,
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });

  if (!response.ok) {
    // The status and a fixed sentence per status; Google's own error body goes to
    // stderr and never into the model's context. See `upstream-api-error.ts`.
    throw await UpstreamApiError.fromResponse(service, response);
  }

  return (await response.json()) as T;
}

/**
 * A property identifier, safe to put in a path.
 *
 * A Domain Property is `sc-domain:example.com` and a URL-Prefix Property is
 * `https://example.com/` — both contain characters that change the meaning of a
 * URL path if left raw. This is the one encoding step every Search Console call
 * below shares, and forgetting it on any of them produces a 404 that reads as
 * "you do not have this property".
 */
function pathSafe(siteUrl: string): string {
  return encodeURIComponent(siteUrl);
}

/** `properties/123` from either `properties/123` or `123`. */
function propertyPath(property: string): string {
  return property.startsWith("properties/") ? property : `properties/${property}`;
}

/**
 * One Search Analytics read, in as many pages as its `rowLimit` needs.
 *
 * Google caps a request at 25,000 rows and documents paging with `startRow`
 * until a page comes back short. Without it every caller's limit was silently
 * clipped to one page, and an analysis of a large property ran on the top slice
 * of its rows while reporting on the whole — a false all-clear with nothing on
 * the page to say so.
 *
 * A short page ends the loop, because it is Google saying there is nothing
 * after it. That also bounds a small property to one request whatever the limit.
 *
 * The metadata is the first page's: Google computes it for the query, not for a
 * page of it, and it is only present when fresh data was asked for.
 */
async function searchAnalyticsWithMetadata(query: SearchAnalyticsQuery): Promise<SearchAnalyticsResult> {
  const { siteUrl, rowLimit, startRow, ...rest } = query;
  const wanted = rowLimit ?? SEARCH_ANALYTICS_DEFAULT_LIMIT;
  const url = `${SEARCH_CONSOLE}/webmasters/v3/sites/${pathSafe(siteUrl)}/searchAnalytics/query`;

  const rows: SearchAnalyticsRow[] = [];
  let metadata: { firstIncompleteDate?: string; firstIncompleteHour?: string } | undefined;
  let offset = startRow ?? 0;

  while (rows.length < wanted) {
    const pageSize = Math.min(SEARCH_ANALYTICS_PAGE, wanted - rows.length);
    const data = await call<{
      rows?: SearchAnalyticsRow[];
      metadata?: { firstIncompleteDate?: string; firstIncompleteHour?: string };
    }>(GSC_SERVICE, url, { ...rest, rowLimit: pageSize, startRow: offset });

    // No rows is a real answer — the property has no data for that window —
    // and is deliberately not distinguished from an absent key here. A caller
    // that needs to say "we could not ask" reads the thrown error instead.
    const page = data.rows ?? [];
    metadata ??= data.metadata;
    rows.push(...page);
    offset += page.length;
    if (page.length < pageSize) break;
  }

  return {
    rows,
    ...(metadata?.firstIncompleteDate ? { firstIncompleteDate: metadata.firstIncompleteDate } : {}),
    ...(metadata?.firstIncompleteHour ? { firstIncompleteHour: metadata.firstIncompleteHour } : {}),
  };
}

function searchConsole(): SearchConsoleReader {
  return {
    async listProperties() {
      const data = await call<{ siteEntry?: GscProperty[] }>(
        GSC_SERVICE,
        `${SEARCH_CONSOLE}/webmasters/v3/sites`,
      );
      // An Operator with no properties gets an empty object, not an empty array.
      return data.siteEntry ?? [];
    },

    async searchAnalytics(query: SearchAnalyticsQuery) {
      return (await searchAnalyticsWithMetadata(query)).rows;
    },

    searchAnalyticsWithMetadata,

    async inspectUrl(siteUrl: string, inspectionUrl: string) {
      return call<UrlInspection>(GSC_SERVICE, `${SEARCH_CONSOLE}/v1/urlInspection/index:inspect`, {
        siteUrl,
        inspectionUrl,
        // Required by the API. Google's index is not language-specific for this
        // call; the parameter selects the language of the *verdict strings*.
        languageCode: "en-US",
      });
    },

    async listSitemaps(siteUrl: string) {
      const data = await call<{ sitemap?: Sitemap[] }>(
        GSC_SERVICE,
        `${SEARCH_CONSOLE}/webmasters/v3/sites/${pathSafe(siteUrl)}/sitemaps`,
      );
      return data.sitemap ?? [];
    },

    async getSitemap(siteUrl: string, feedpath: string) {
      return call<Sitemap>(
        GSC_SERVICE,
        `${SEARCH_CONSOLE}/webmasters/v3/sites/${pathSafe(siteUrl)}/sitemaps/${pathSafe(feedpath)}`,
      );
    },
  };
}

function analytics(): AnalyticsReader {
  return {
    async listProperties() {
      // Account summaries rather than the properties endpoint: the latter
      // requires an account filter, and an Operator does not necessarily know
      // their account ids. This one call returns every property they can read.
      const data = await call<{
        accountSummaries?: Array<{
          account?: string;
          displayName?: string;
          propertySummaries?: Array<{ property?: string; displayName?: string }>;
        }>;
      }>(GA4_SERVICE, `${ANALYTICS_ADMIN}/accountSummaries?pageSize=200`);

      const properties: Ga4Property[] = [];
      for (const account of data.accountSummaries ?? []) {
        for (const summary of account.propertySummaries ?? []) {
          if (!summary.property) continue;
          properties.push({
            name: summary.property,
            displayName: summary.displayName ?? summary.property,
            account: account.displayName ?? account.account,
          });
        }
      }
      return properties;
    },

    async runReport(query: Ga4ReportQuery) {
      const { property, ...rest } = query;
      return call<Ga4Report>(
        GA4_SERVICE,
        `${ANALYTICS_DATA}/${propertyPath(property)}:runReport`,
        reportBody(rest),
      );
    },

    async runPivotReport(query: Ga4PivotQuery) {
      const { property, ...rest } = query;
      return call<Ga4Report>(
        GA4_SERVICE,
        `${ANALYTICS_DATA}/${propertyPath(property)}:runPivotReport`,
        reportBody(rest),
      );
    },

    async runRealtimeReport(query: Ga4RealtimeQuery) {
      const { property, dimensions, metrics, limit } = query;
      return call<Ga4Report>(
        GA4_SERVICE,
        `${ANALYTICS_DATA}/${propertyPath(property)}:runRealtimeReport`,
        {
          dimensions: names(dimensions),
          metrics: names(metrics),
          limit,
        },
      );
    },

    async getMetadata(property: string) {
      return call<Ga4Metadata>(
        GA4_SERVICE,
        `${ANALYTICS_DATA}/${propertyPath(property)}/metadata`,
      );
    },

    async checkCompatibility(query: Ga4ReportQuery) {
      const { property, ...rest } = query;
      return call<Ga4Compatibility>(
        GA4_SERVICE,
        `${ANALYTICS_DATA}/${propertyPath(property)}:checkCompatibility`,
        reportBody(rest),
      );
    },

    async runFunnelReport(query: Ga4FunnelQuery) {
      const { property, dateRanges, steps, isOpenFunnel, breakdownDimension } = query;
      return call<Ga4FunnelReport>(
        GA4_SERVICE,
        `${ANALYTICS_DATA_ALPHA}/${propertyPath(property)}:runFunnelReport`,
        {
          dateRanges,
          funnel: {
            isOpenFunnel: isOpenFunnel ?? false,
            steps: steps.map((step) => ({ name: step.name, filterExpression: stepFilter(step) })),
          },
          ...(breakdownDimension ? { funnelBreakdown: { breakdownDimension: { name: breakdownDimension } } } : {}),
          // The table is the half an agent can read; the visualisation is the
          // same numbers laid out for a chart.
          funnelVisualizationType: "STANDARD_FUNNEL",
          returnPropertyQuota: true,
        },
      );
    },
  };
}

/**
 * A funnel step's filter: the event, and the page it happened on when one is named.
 *
 * `pagePath` rather than an event parameter, because the parameter is
 * `page_location` — a full URL — and a prefix on a path is what an Operator
 * means by "on the pricing pages".
 */
function stepFilter(step: Ga4FunnelQuery["steps"][number]) {
  const event = { funnelEventFilter: { eventName: step.eventName } };
  if (!step.pagePathPrefix) return event;
  return {
    andGroup: {
      expressions: [
        event,
        {
          funnelFieldFilter: {
            fieldName: "pagePath",
            stringFilter: { matchType: "BEGINS_WITH", value: step.pagePathPrefix },
          },
        },
      ],
    },
  };
}

/**
 * Every item of a paged Admin API list.
 *
 * Admin lists page at 200 by default and say so with `nextPageToken`. A property
 * with more key events or annotations than one page is unusual; reading only
 * the first page and presenting it as the list is the failure it would cause.
 */
async function listAll<T>(url: string, key: string): Promise<T[]> {
  const items: T[] = [];
  let pageToken: string | undefined;
  do {
    const pageUrl = new URL(url);
    pageUrl.searchParams.set("pageSize", "200");
    if (pageToken) pageUrl.searchParams.set("pageToken", pageToken);
    const data = await call<Record<string, unknown>>(GA4_SERVICE, pageUrl.toString());
    const page = data[key];
    if (Array.isArray(page)) items.push(...(page as T[]));
    pageToken = typeof data.nextPageToken === "string" && data.nextPageToken ? data.nextPageToken : undefined;
  } while (pageToken);
  return items;
}

function analyticsAdmin(): AnalyticsAdminReader {
  const beta = (property: string, rest = "") => `${ANALYTICS_ADMIN}/${propertyPath(property)}${rest}`;
  const alpha = (property: string, rest = "") => `${ANALYTICS_ADMIN_ALPHA}/${propertyPath(property)}${rest}`;

  return {
    getProperty: (property) => call<Ga4PropertyDetails>(GA4_SERVICE, beta(property)),
    getDataRetention: (property) =>
      call<Ga4DataRetention>(GA4_SERVICE, beta(property, "/dataRetentionSettings")),
    listDataStreams: (property) => listAll<Ga4DataStream>(beta(property, "/dataStreams"), "dataStreams"),
    getEnhancedMeasurement: (stream) =>
      call<Ga4EnhancedMeasurement>(GA4_SERVICE, `${ANALYTICS_ADMIN_ALPHA}/${stream}/enhancedMeasurementSettings`),
    getDataRedaction: (stream) =>
      call<Ga4DataRedaction>(GA4_SERVICE, `${ANALYTICS_ADMIN_ALPHA}/${stream}/dataRedactionSettings`),
    listKeyEvents: (property) => listAll<Ga4KeyEvent>(beta(property, "/keyEvents"), "keyEvents"),
    getAttributionSettings: (property) =>
      call<Ga4AttributionSettings>(GA4_SERVICE, alpha(property, "/attributionSettings")),
    getGoogleSignals: (property) =>
      call<Ga4GoogleSignals>(GA4_SERVICE, alpha(property, "/googleSignalsSettings")),
    getReportingIdentity: (property) =>
      call<Ga4ReportingIdentity>(GA4_SERVICE, alpha(property, "/reportingIdentitySettings")),
    listChannelGroups: (property) =>
      listAll<Ga4ChannelGroup>(alpha(property, "/channelGroups"), "channelGroups"),
    async listGoogleAdsLinks(property) {
      const links = await listAll<{ name: string; customerId?: string }>(
        beta(property, "/googleAdsLinks"),
        "googleAdsLinks",
      );
      return links.map((link): Ga4Link => ({ name: link.name, target: link.customerId }));
    },
    async listBigQueryLinks(property) {
      const links = await listAll<{ name: string; project?: string }>(
        alpha(property, "/bigQueryLinks"),
        "bigqueryLinks",
      );
      return links.map((link): Ga4Link => ({ name: link.name, target: link.project }));
    },
    listAnnotations: (property) =>
      listAll<Ga4Annotation>(alpha(property, "/reportingDataAnnotations"), "reportingDataAnnotations"),
  };
}

/**
 * Dimensions and metrics as the Data API wants them.
 *
 * The API takes `[{ name: "sessions" }]` where every caller here thinks in
 * `["sessions"]`. Converting at the boundary keeps the awkward shape in one
 * place instead of in every Tool.
 */
function names(values: string[] | undefined): Array<{ name: string }> | undefined {
  return values?.map((name) => ({ name }));
}

function reportBody(query: Omit<Ga4ReportQuery, "property"> & { pivots?: unknown[] }) {
  const { dimensions, metrics, ...rest } = query;
  return {
    ...rest,
    dimensions: names(dimensions),
    metrics: names(metrics),
  };
}

/**
 * The reader every Google Tool uses in production.
 *
 * Constructed per call rather than shared, which costs nothing — the objects
 * hold no state — and makes it impossible for one call's auth to be seen by
 * another's.
 */
export function createGoogleReader(): GoogleReader {
  return { searchConsole: searchConsole(), analytics: analytics(), analyticsAdmin: analyticsAdmin() };
}
