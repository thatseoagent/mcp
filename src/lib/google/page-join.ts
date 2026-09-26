/**
 * Search Console pages joined to GA4 landing pages, by path.
 *
 * ── Why this is its own module ──
 *
 * The two APIs name one page two ways. Search Console reports the URL Google
 * showed — `https://example.com/pricing/`, scheme and host included, and on a
 * Domain Property across every subdomain. GA4's `landingPage` is a path —
 * `/pricing` — with no host at all. Joining them is a string normalisation, and
 * a normalisation written inline in a Tool is one nobody can test without a
 * Google account on each side.
 *
 * ── What the normalisation does, and does not, decide ──
 *
 * The key is `pathKey` in `url-match.ts`, which owns every rule for "the same
 * page" and says there why this one is looser than the rest: it drops the query
 * string and the fragment, the trailing slash (except on the root), and
 * percent-encoding differences, because those are the ways the same page reaches
 * the two APIs spelled differently. It keeps case: `/About` and `/about` are two
 * URLs to a server, and merging them would join two pages' numbers into one.
 *
 * It refuses one join outright. GA4's path carries no host, so on a Domain
 * Property `https://example.com/help` and `https://docs.example.com/help` both
 * arrive at `/help`, and GA4's one `/help` row cannot be split between them.
 * Those pages are reported as not joinable rather than credited to whichever
 * came first — a join that picks one is a guess presented as a measurement.
 * Two hosts are two by `hostKey`, so `www.example.com/help` and
 * `example.com/help` are one page served twice, not a collision.
 */
import { hostKey, pathKey } from "../url-match";
import type { SearchAnalyticsRow } from "./reader";

export interface Ga4LandingRow {
  landingPage: string;
  sessions: number;
  engagedSessions: number;
  keyEvents: number;
}

export interface SearchSide {
  /** The URL as Search Console reported it; the busiest one when several merged. */
  url: string;
  clicks: number;
  impressions: number;
  ctr: number;
  position: number;
}

export interface AnalyticsSide {
  sessions: number;
  engagedSessions: number;
  /** Engaged sessions over sessions, recomputed after merging rather than averaged. */
  engagementRate: number;
  keyEvents: number;
}

export interface JoinedPage {
  path: string;
  search: SearchSide;
  analytics: AnalyticsSide;
}

export interface PageJoin {
  joined: JoinedPage[];
  /** Search Console pages with no GA4 organic landing row on the same path. */
  searchOnly: SearchSide[];
  /** Search Console pages whose path is shared by more than one host. */
  ambiguous: SearchSide[];
  /** Search Console rows whose key is not a URL at all. */
  unreadable: number;
  /** GA4 organic landing paths with no Search Console page on the same path. */
  analyticsOnly: Array<AnalyticsSide & { path: string }>;
  /** GA4 rows with no path to join — `(not set)` and the like. */
  analyticsUnreadable: { rows: number; sessions: number };
  /** Every Search Console click in the rows, joined or not. */
  totalClicks: number;
  /** The Search Console clicks that landed on a joined page. */
  joinedClicks: number;
}

/** Many rows for one page, as one — clicks summed, CTR and position recomputed. */
function mergeSearch(rows: readonly SearchAnalyticsRow[]): SearchSide {
  const clicks = rows.reduce((sum, row) => sum + row.clicks, 0);
  const impressions = rows.reduce((sum, row) => sum + row.impressions, 0);
  const weighted = rows.reduce((sum, row) => sum + row.position * row.impressions, 0);
  const busiest = [...rows].sort((a, b) => b.clicks - a.clicks)[0];
  return {
    url: busiest?.keys?.[0] ?? "(none)",
    clicks,
    impressions,
    ctr: impressions > 0 ? clicks / impressions : 0,
    position: impressions > 0 ? weighted / impressions : 0,
  };
}

function mergeAnalytics(rows: readonly Ga4LandingRow[]): AnalyticsSide {
  const sessions = rows.reduce((sum, row) => sum + row.sessions, 0);
  const engagedSessions = rows.reduce((sum, row) => sum + row.engagedSessions, 0);
  return {
    sessions,
    engagedSessions,
    engagementRate: sessions > 0 ? engagedSessions / sessions : 0,
    keyEvents: rows.reduce((sum, row) => sum + row.keyEvents, 0),
  };
}

/**
 * Join Search Console page rows to GA4 landing rows on {@link pathKey}.
 *
 * Takes Search Console rows dimensioned `["page"]`. Everything that did not
 * join is returned, counted, and kept apart by reason, because "how much of
 * this did we actually see on both sides" is the first thing the Tool owes.
 */
export function joinPages(
  searchRows: readonly SearchAnalyticsRow[],
  analyticsRows: readonly Ga4LandingRow[],
): PageJoin {
  const searchByPath = new Map<string, SearchAnalyticsRow[]>();
  const hostsByPath = new Map<string, Set<string>>();
  let unreadable = 0;

  for (const row of searchRows) {
    const url = row.keys?.[0] ?? "";
    const key = /^https?:\/\//i.test(url) ? pathKey(url) : null;
    if (key === null) {
      unreadable++;
      continue;
    }
    searchByPath.set(key, [...(searchByPath.get(key) ?? []), row]);
    hostsByPath.set(key, (hostsByPath.get(key) ?? new Set()).add(hostKey(url) ?? ""));
  }

  const analyticsByPath = new Map<string, Ga4LandingRow[]>();
  const analyticsUnreadable = { rows: 0, sessions: 0 };
  for (const row of analyticsRows) {
    const key = pathKey(row.landingPage);
    if (key === null) {
      analyticsUnreadable.rows++;
      analyticsUnreadable.sessions += row.sessions;
      continue;
    }
    analyticsByPath.set(key, [...(analyticsByPath.get(key) ?? []), row]);
  }

  const joined: JoinedPage[] = [];
  const searchOnly: SearchSide[] = [];
  const ambiguous: SearchSide[] = [];
  const claimed = new Set<string>();

  for (const [path, rows] of searchByPath) {
    if ((hostsByPath.get(path)?.size ?? 0) > 1) {
      // One GA4 row, several pages: see the module header. Each host's page is
      // listed on its own, so the reader can see which ones collided.
      const byHost = new Map<string, SearchAnalyticsRow[]>();
      for (const row of rows) {
        const host = hostKey(row.keys?.[0] ?? "") ?? "";
        byHost.set(host, [...(byHost.get(host) ?? []), row]);
      }
      for (const hostRows of byHost.values()) ambiguous.push(mergeSearch(hostRows));
      // Claimed all the same, so GA4's row for the path is not then reported as
      // a landing page Search Console never saw. It saw it, more than once.
      claimed.add(path);
      continue;
    }

    const search = mergeSearch(rows);
    const analytics = analyticsByPath.get(path);
    if (!analytics) {
      searchOnly.push(search);
      continue;
    }
    claimed.add(path);
    joined.push({ path, search, analytics: mergeAnalytics(analytics) });
  }

  const analyticsOnly = [...analyticsByPath.entries()]
    .filter(([path]) => !claimed.has(path))
    .map(([path, rows]) => ({ path, ...mergeAnalytics(rows) }));

  const totalClicks = searchRows.reduce((sum, row) => sum + row.clicks, 0);
  const joinedClicks = joined.reduce((sum, page) => sum + page.search.clicks, 0);

  return {
    joined: joined.sort((a, b) => b.search.clicks - a.search.clicks),
    searchOnly: searchOnly.sort((a, b) => b.clicks - a.clicks),
    ambiguous: ambiguous.sort((a, b) => b.clicks - a.clicks),
    unreadable,
    analyticsOnly: analyticsOnly.sort((a, b) => b.keyEvents - a.keyEvents || b.sessions - a.sessions),
    analyticsUnreadable,
    totalClicks,
    joinedClicks,
  };
}

export interface ValueConfig {
  /** The Search Console clicks a page needs before its engagement is worth judging. */
  minClicks: number;
  /** An engagement rate below this, as a percentage, counts as low. */
  lowEngagement: number;
}

/**
 * When a page's clicks are "many" and its engagement "low", and both are **ours**.
 *
 * Twenty clicks in a window is the least that makes an engagement rate more than
 * a handful of visits. 40% is well below what GA4 properties typically report
 * for organic landings, so a page under it is unusual for its own site rather
 * than merely average.
 */
export const DEFAULT_VALUE: ValueConfig = { minClicks: 20, lowEngagement: 40 };

/** Pages that earn clicks and then do little: low engagement, or no key event at all. */
export function clicksWithoutValue(
  joined: readonly JoinedPage[],
  config: ValueConfig = DEFAULT_VALUE,
  { keyEventsMeasured }: { keyEventsMeasured: boolean },
): JoinedPage[] {
  return joined
    .filter((page) => page.search.clicks >= config.minClicks && page.analytics.sessions > 0)
    .filter(
      (page) =>
        page.analytics.engagementRate * 100 < config.lowEngagement ||
        // Only when the property records key events somewhere. A property with
        // none configured has none on every page, and flagging every page for it
        // would be a finding about the setup presented as one about the pages.
        (keyEventsMeasured && page.analytics.keyEvents === 0),
    )
    .sort((a, b) => b.search.clicks - a.search.clicks);
}

/**
 * Pages that produce key events and are barely seen in search.
 *
 * "Barely seen" is below the median impressions of the pages that joined,
 * because an absolute number means nothing across sites of different sizes and
 * the site's own middle is the comparison an Operator would make by eye.
 */
export function valueWithoutReach(joined: readonly JoinedPage[]): { pages: JoinedPage[]; median: number } {
  const impressions = joined.map((page) => page.search.impressions).sort((a, b) => a - b);
  if (impressions.length === 0) return { pages: [], median: 0 };
  const middle = Math.floor(impressions.length / 2);
  const median =
    impressions.length % 2 === 0 ? (impressions[middle - 1] + impressions[middle]) / 2 : impressions[middle];

  const pages = joined
    .filter((page) => page.analytics.keyEvents > 0 && page.search.impressions < median)
    .sort((a, b) => b.analytics.keyEvents - a.analytics.keyEvents);
  return { pages, median };
}
