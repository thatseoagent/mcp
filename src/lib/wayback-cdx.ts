/**
 * The Internet Archive's Wayback CDX API: what the archive holds for a URL or a
 * part of a site.
 *
 * The CDX server is the archive's index — one row per capture, with the time, the
 * status the site answered, the MIME type and a digest of the payload. It answers
 * questions nothing else this server reads can: when a URL first appeared, when
 * it started redirecting or answering 404, and which URLs a site used to have.
 *
 * ── What a row is evidence of ──
 *
 * **A capture, not the site's history.** The archive crawls selectively, some
 * sites ask to be excluded, and most pages are captured at irregular intervals
 * or never. So a first capture is "no later than", a gap between captures is
 * silence rather than downtime, and a URL the archive never captured may well
 * have existed. Every sentence the Tool prints is written to that rule, and it is
 * the reason the empty answer is an answer: "the archive has nothing" is a fact
 * about the archive.
 *
 * ── Facts about the server this is written to (read 2026-09-24) ──
 *
 * - `output=json` returns an array of arrays whose first row names the fields,
 *   and `[]` — no header — when nothing matched.
 * - `collapse=digest` drops a capture whose digest equals the one before it, so
 *   each row left is a capture whose payload differed from the previous one. It
 *   collapses *adjacent* rows only: content that changes and changes back counts
 *   as three versions, which is the honest reading.
 * - `showSkipCount` and `lastSkipTimestamp`, which the CDX README documents for
 *   reading when each collapsed run ended, are ignored by the current server
 *   (its `X-be` header names a pywb backend). So the last capture of a URL is a
 *   second, cheap request — `fastLatest=true&limit=-1` — rather than something
 *   the first one can say.
 * - Collapsing with a negative `limit` (the newest N versions) took ~40 seconds
 *   on a busy URL against ~18 for the oldest N, so the version read is oldest
 *   first and a truncated one says where it stopped.
 * - The archive keys URLs in SURT form, lower-cased and with `www.` and a
 *   trailing slash dropped, so `matchType=prefix` on `/hub/` also matches
 *   `/hubspot`. The prefix read filters on the real path afterwards.
 * - When it sheds load the server answers an HTML "Temporarily Offline" page.
 *   That is read as no answer, not as data.
 *
 * No key, and no documented rate limit; the research note infers roughly sixty
 * requests a minute. Each call makes at most two requests to the archive and
 * `callApi` holds them to that.
 */
import { callApi, UpstreamUnansweredError, type ThirdPartyService } from "./third-party-api";
import { createSingleFlightCache } from "./single-flight";

/** How the archive is named in a refusal. */
export const WAYBACK_SERVICE = "The Internet Archive's Wayback CDX API";

const ENDPOINT = "https://web.archive.org/cdx/search/cdx";

const WAYBACK = {
  name: WAYBACK_SERVICE,
  // The archive is slow on busy URLs — a collapsed read of a popular home page
  // took 18 seconds when this was written — so the budget is generous. It still
  // exists because Node's `fetch` has none.
  timeoutMs: 60_000,
  // INFERRED, not documented: the CDX server's README states no limit, and
  // `docs/research/api-surface-2026-09.md` §7 infers about sixty a minute from
  // how it answers. Conservative on purpose — a slow archive is the usual
  // failure here, and pressing it harder makes it slower.
  perMinute: 60,
} satisfies ThirdPartyService;

/**
 * How many content versions one read asks for. A stated reading depth, not an
 * allowance: a home page whose markup changes on every capture can have
 * thousands, and the Tool says so when this cut them off.
 */
export const VERSION_LIMIT = 1_000;

/** How many distinct URLs one prefix or domain read asks for, per status. */
export const URL_LIMIT = 1_000;

const FIELDS = ["urlkey", "timestamp", "original", "mimetype", "statuscode", "digest", "length"] as const;

/** One capture, as the index records it. */
export interface Capture {
  urlkey: string;
  /** `YYYYMMDDhhmmss`, UTC. */
  timestamp: string;
  /** The URL as it was captured, scheme and port included. */
  original: string;
  mimetype: string;
  /** The HTTP status, or `null` where the index has `-` (no status recorded). */
  status: number | null;
  digest: string;
  /** Bytes of the stored record, or `null`. */
  length: number | null;
}

/** An optional window, as the Operator gave it: `YYYY`, `YYYYMM` or `YYYYMMDD`. */
export interface Window {
  from?: string;
  to?: string;
}

export interface UrlHistory {
  /** Every capture whose payload differed from the one before it, oldest first. */
  versions: Capture[];
  /** True when {@link VERSION_LIMIT} cut the read short. */
  truncated: boolean;
  /** The newest capture in the window, whether or not its content was new. */
  latest: Capture | null;
}

const urlCache = createSingleFlightCache<UrlHistory>();
const prefixCache = createSingleFlightCache<PrefixRead>();

/**
 * What the archive holds for one URL.
 *
 * @throws {UpstreamApiError} when the archive refuses, is overloaded or times out.
 */
export function readUrlHistory(url: string, window: Window = {}): Promise<UrlHistory> {
  return urlCache.run(`${url} ${window.from ?? ""} ${window.to ?? ""}`, async () => {
    const versions = await query({
      url,
      fl: FIELDS.join(","),
      collapse: "digest",
      limit: String(VERSION_LIMIT),
      ...windowParams(window),
    });
    if (versions.length === 0) return { versions, truncated: false, latest: null };

    const [latest] = await query({
      url,
      fl: FIELDS.join(","),
      fastLatest: "true",
      limit: "-1",
      ...windowParams(window),
    });
    return {
      versions,
      truncated: versions.length >= VERSION_LIMIT,
      // The newest version is a floor on the newest capture, so a latest read that
      // came back empty — the index can lag itself by minutes — still has one.
      latest: latest ?? versions.at(-1) ?? null,
    };
  });
}

/** What a prefix or domain read found, before anything is checked live. */
export interface PrefixRead {
  /** Each distinct URL's first capture that answered 200 with HTML. */
  live: Capture[];
  /** Each distinct URL's first capture that answered 404 or 410. */
  gone: Capture[];
  /** True when {@link URL_LIMIT} cut the 200 read short. */
  liveTruncated: boolean;
  /** True when {@link URL_LIMIT} cut the 404/410 read short. */
  goneTruncated: boolean;
}

/**
 * The URLs the archive holds under a path prefix, or anywhere on a domain.
 *
 * Two reads, both collapsed to one row per URL: the URLs it saw answering 200
 * with HTML, and the ones it saw answering 404 or 410. What to make of the two —
 * which URLs died, and which to check against the live site — is the Tool's.
 *
 * @param scope `prefix`: the URL's host and path and everything under it.
 *              `domain`: the host and every subdomain.
 */
export function readPrefix(
  url: string,
  scope: "prefix" | "domain",
  window: Window = {},
): Promise<PrefixRead> {
  const key = `${scope} ${url} ${window.from ?? ""} ${window.to ?? ""}`;
  return prefixCache.run(key, async () => {
    const target = scope === "domain" ? new URL(url).hostname : url;
    const common = {
      url: target,
      matchType: scope,
      fl: FIELDS.join(","),
      collapse: "urlkey",
      limit: String(URL_LIMIT),
      ...windowParams(window),
    };
    const live = await query({ ...common, filter: ["statuscode:200", "mimetype:text/html"] });
    const gone = await query({ ...common, filter: ["statuscode:40[40]"] });
    return {
      live,
      gone,
      liveTruncated: live.length >= URL_LIMIT,
      goneTruncated: gone.length >= URL_LIMIT,
    };
  });
}

/**
 * The window as CDX parameters, passed as given. Both ends are inclusive and the
 * server widens a short one to the whole period — `to=2017` returned a capture
 * from 2017-09-14 when this was written — so no padding is needed here.
 */
function windowParams(window: Window): Record<string, string> {
  const params: Record<string, string> = {};
  if (window.from) params.from = window.from;
  if (window.to) params.to = window.to;
  return params;
}

async function query(params: Record<string, string | string[]>): Promise<Capture[]> {
  const { body, status } = await callApi(WAYBACK, {
    url: ENDPOINT,
    query: { output: "json", ...params },
  });
  return readCaptures(body, status);
}

/**
 * The rows, read by the header's field names rather than by position, and
 * separated from the fetch so it can be tested against a captured payload.
 *
 * Exported for that test alone.
 *
 * @throws {UpstreamUnansweredError} when the payload is not CDX's shape at all.
 */
export function readCaptures(payload: unknown, status = 200): Capture[] {
  if (!Array.isArray(payload)) throw UpstreamUnansweredError.unreadable(WAYBACK_SERVICE, status);
  if (payload.length === 0) return [];

  const [header, ...rows] = payload;
  if (!Array.isArray(header)) throw UpstreamUnansweredError.unreadable(WAYBACK_SERVICE, status);
  const column = (name: string) => header.indexOf(name);
  const at = (row: unknown[], name: string): string => {
    const i = column(name);
    const value = i === -1 ? undefined : row[i];
    return typeof value === "string" ? value : "";
  };

  const captures: Capture[] = [];
  for (const row of rows) {
    if (!Array.isArray(row)) continue;
    const timestamp = at(row, "timestamp");
    // A row without a well-formed timestamp cannot be placed in a history.
    if (!/^\d{14}$/.test(timestamp)) continue;
    captures.push({
      urlkey: at(row, "urlkey"),
      timestamp,
      original: at(row, "original"),
      mimetype: at(row, "mimetype"),
      status: toInt(at(row, "statuscode")),
      digest: at(row, "digest"),
      length: toInt(at(row, "length")),
    });
  }
  return captures;
}

/** `"200"` → 200; the index's `-` and anything else → `null`, never `NaN`. */
function toInt(value: string): number | null {
  return /^\d+$/.test(value) ? Number(value) : null;
}

/** `20170206212209` → `2017-02-06`. */
export function captureDate(timestamp: string): string {
  return `${timestamp.slice(0, 4)}-${timestamp.slice(4, 6)}-${timestamp.slice(6, 8)}`;
}

/** Where the Operator can see one capture for themselves. */
export function replayUrl(capture: Capture): string {
  return `https://web.archive.org/web/${capture.timestamp}/${capture.original}`;
}
