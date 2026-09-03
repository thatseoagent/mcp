/**
 * {@link GoogleReader} against the real Google APIs.
 *
 * ── Plain `fetch`, not `googleapis` ──
 *
 * The retired product depended on `googleapis`, which is generated from Google's
 * discovery documents and carries every API Google publishes — tens of
 * megabytes for the five endpoints below. These are ordinary JSON endpoints
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
  AnalyticsReader,
  Ga4Compatibility,
  Ga4Metadata,
  Ga4PivotQuery,
  Ga4Property,
  Ga4RealtimeQuery,
  Ga4Report,
  Ga4ReportQuery,
  GoogleReader,
  GscProperty,
  SearchAnalyticsQuery,
  SearchAnalyticsRow,
  SearchConsoleReader,
  Sitemap,
  UrlInspection,
} from "./reader";

const SEARCH_CONSOLE = "https://searchconsole.googleapis.com";
const ANALYTICS_DATA = "https://analyticsdata.googleapis.com/v1beta";
const ANALYTICS_ADMIN = "https://analyticsadmin.googleapis.com/v1beta";

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
      const { siteUrl, ...rest } = query;
      const data = await call<{ rows?: SearchAnalyticsRow[] }>(
        GSC_SERVICE,
        `${SEARCH_CONSOLE}/webmasters/v3/sites/${pathSafe(siteUrl)}/searchAnalytics/query`,
        rest,
      );
      // No rows is a real answer — the property has no data for that window —
      // and is deliberately not distinguished from an absent key here. A caller
      // that needs to say "we could not ask" reads the thrown error instead.
      return data.rows ?? [];
    },

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
  return { searchConsole: searchConsole(), analytics: analytics() };
}
