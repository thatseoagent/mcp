/**
 * Google's Web Risk Lookup API: is this URL on Google's unsafe-site lists?
 *
 * ── Why this and not Search Console ──
 *
 * Search Console's Security Issues report is what an Operator would open to see
 * whether Google has flagged their site for malware or phishing, and it has no
 * API: the Search Console API exposes Search Analytics, sitemaps, URL
 * inspection and the site list, and nothing about security issues. Asking
 * Google's threat lists directly about each URL is the only programmatic way to
 * see what that report would show. It is not the same reading — the report is
 * about the property and can carry Google's explanation; a lookup is about one
 * URL at one moment — and the Tool says so.
 *
 * ── Why this and not Safe Browsing ──
 *
 * The Safe Browsing API reads the same lists and is free, and its terms rule it
 * out: "The Safe Browsing API is for non-commercial use only. If you need to use
 * APIs to detect malicious URLs for commercial purposes – meaning 'for sale or
 * revenue-generating purposes' – refer to the Web Risk API."
 * (https://developers.google.com/safe-browsing/v4). An SEO consultant checking a
 * client's site is the commercial case that sentence is about.
 *
 * ── Facts this module relies on, and where they are stated ──
 *
 * - `GET https://webrisk.googleapis.com/v1/uris:search?uri=…&threatTypes=…`,
 *   one URI per request, `threatTypes` repeated.
 *   https://docs.cloud.google.com/web-risk/docs/reference/rest/v1/uris/search
 * - A match is `{"threat": {"threatTypes": [...], "expireTime": "…"}}`; no match
 *   is the empty object `{}`. "The URL must be valid (see RFC 2396) but it
 *   doesn't need to be canonicalized."
 *   https://docs.cloud.google.com/web-risk/docs/lookup-api
 * - The four list types, SOCIAL_ENGINEERING_EXTENDED_COVERAGE among them.
 *   https://docs.cloud.google.com/web-risk/docs/reference/rest/v1/ThreatType
 * - The extended list is "categorized with a slightly lower confidence than the
 *   other list types, and therefore [has] a slightly higher chance of being a
 *   false positive", and its matches "might not trigger a red warning screen" in
 *   browsers. https://docs.cloud.google.com/web-risk/docs/extended-coverage
 * - `expireTime`: "Clients must not cache this response past this timestamp to
 *   avoid false positives." Which is why the Tool does not sit behind the Tool
 *   cache; see `web-risk-check.ts`.
 * - Pricing: 1–100,000 lookups a month free, then $0.50 per 1,000, and the
 *   project needs billing enabled. https://cloud.google.com/web-risk/pricing,
 *   https://docs.cloud.google.com/web-risk/docs/quickstart
 * - "The information returned by the Web Risk must not be redistributed", and
 *   "some risky sites may not be identified, and some safe sites may be
 *   classified in error." https://docs.cloud.google.com/web-risk/docs/overview
 *
 * ── The key ──
 *
 * `GOOGLE_CLOUD_API_KEY`, not `PAGESPEED_API_KEY`. A Google Cloud key would
 * technically work for both once both APIs were enabled, and `crux-history.ts`
 * reuses the PageSpeed key on exactly that argument. The argument stops at
 * billing: PageSpeed and CrUX need no billing account, Web Risk requires one,
 * and enabling billing on a project is a consent to be charged that the Operator
 * gave for neither of the free APIs. A separate variable keeps "I configured
 * PageSpeed" from ever meaning "I agreed to pay for Web Risk".
 *
 * Sent as the `x-goog-api-key` header rather than `?key=`, which Google
 * recommends because the query parameter "includes your API key in the URL,
 * exposing your key to theft through URL scans".
 * https://docs.cloud.google.com/docs/authentication/api-keys-use
 */
import { callApi, type ThirdPartyService } from "./third-party-api";
import type { ConfigRequirement } from "./required-config";
import { isRecord } from "./type-guards";

export const WEB_RISK_KEY_REQUIREMENT: ConfigRequirement = {
  variable: "GOOGLE_CLOUD_API_KEY",
  purpose:
    "call Google's Web Risk API, the commercial-use service that says whether Google lists a " +
    "URL as malware, phishing or unwanted software",
  howToGet:
    "Create an API key at https://console.cloud.google.com/apis/credentials in a Google Cloud " +
    "project that has billing enabled, and enable the Web Risk API " +
    "(https://console.cloud.google.com/apis/library/webrisk.googleapis.com) for that project. " +
    "Web Risk needs billing on the project even inside its free tier: the first 100,000 " +
    "lookups a month are free, then $0.50 per 1,000 (https://cloud.google.com/web-risk/pricing). " +
    "PAGESPEED_API_KEY is deliberately not used for this, so that the free PageSpeed key never " +
    "sits on a billed project by accident.",
};

const ENDPOINT = "https://webrisk.googleapis.com/v1/uris:search";

const WEB_RISK = {
  name: "Google's Web Risk API",
  key: { requirement: WEB_RISK_KEY_REQUIREMENT, in: "header", header: "x-goog-api-key" },
  // A lookup is a hash-list read on Google's side and answers in well under a
  // second; the ceiling exists because Node's `fetch` has none.
  timeoutMs: 15_000,
  // "SearchUris requests per minute: 6000", the project default
  // (https://docs.cloud.google.com/web-risk/quotas, read 2026-09-24). Far above
  // anything a Tool asks, so it never waits in practice; stated so the number
  // is the provider's rather than a default standing in for it.
  perMinute: 6_000,
} satisfies ThirdPartyService;

export type ThreatType =
  | "MALWARE"
  | "SOCIAL_ENGINEERING"
  | "UNWANTED_SOFTWARE"
  | "SOCIAL_ENGINEERING_EXTENDED_COVERAGE";

/**
 * Every list a lookup is asked against, in the order Google's enum lists them.
 *
 * The extended list is included because it is where most phishing is caught —
 * "up to 90%" better coverage, by Google's account — and its lower confidence is
 * reported rather than hidden by leaving it out: a site flagged only there is
 * told exactly that.
 */
export const THREAT_TYPES: readonly ThreatType[] = [
  "MALWARE",
  "SOCIAL_ENGINEERING",
  "UNWANTED_SOFTWARE",
  "SOCIAL_ENGINEERING_EXTENDED_COVERAGE",
];

/** One URL's answer. */
export type WebRiskVerdict =
  | { url: string; flagged: false }
  | {
      url: string;
      flagged: true;
      /** The lists it is on, as Google names them. Only the four above are kept. */
      threatTypes: ThreatType[];
      /** When Google says the match stops being valid, RFC 3339, or `null` if absent. */
      expireTime: string | null;
    };

/**
 * Look one URL up against every list.
 *
 * @throws {MissingConfigError} when no key is configured, before any request.
 * @throws {UpstreamApiError} when the API answers with anything but a verdict,
 *         or does not answer in time.
 */
export async function lookupWebRisk(url: string): Promise<WebRiskVerdict> {
  const { body } = await callApi(WEB_RISK, {
    url: ENDPOINT,
    query: { uri: url, threatTypes: [...THREAT_TYPES] },
  });
  return readVerdict(url, body);
}

/**
 * The response, read defensively and separated from the fetch so it can be
 * tested against the documented payloads.
 *
 * A body that is not an object, or an object without `threat`, is "not
 * flagged": `{}` is the documented no-match answer, and the API has no other
 * way of saying a URL is clean. A `threat` whose types are all unrecognised is
 * still a match — Google put the URL on *a* list — so it is reported as flagged
 * with no named list rather than dropped into "clean".
 *
 * Exported for that test alone.
 */
export function readVerdict(url: string, payload: unknown): WebRiskVerdict {
  const threat = isRecord(payload) && isRecord(payload.threat) ? payload.threat : null;
  if (!threat) return { url, flagged: false };

  const listed = Array.isArray(threat.threatTypes) ? threat.threatTypes : [];
  const threatTypes = THREAT_TYPES.filter((type) => listed.includes(type));
  const expireTime = typeof threat.expireTime === "string" ? threat.expireTime : null;
  return { url, flagged: true, threatTypes, expireTime };
}
