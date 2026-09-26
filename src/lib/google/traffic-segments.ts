/**
 * The two slices of GA4 traffic the Tools here keep asking for: sessions that
 * arrived from an AI assistant, and sessions that arrived from Google's organic
 * results. Each is defined once, below.
 *
 * ── Why one module ──
 *
 * Both had more than one definition, and a slice defined twice is a slice two
 * Tools can disagree about on the same property. `ga4_ai_traffic` ran and walked
 * its own three reports while `site_ai_landing_signals` and
 * `site_ai_crawler_traffic` shared a fourth reading, and `run_site_audit` a
 * fifth. "Organic landing pages" meant source `google` / medium `organic` in
 * `gsc_page_value` and the `Organic Search` channel group in
 * `site_ai_landing_signals` — two different sets of sessions under one name.
 *
 * ── AI-referred: what counts ──
 *
 * The classification is `classifyAiReferrer`'s, in `ai-referrers.ts`: Google's
 * own `ai-assistant` medium first, the supplementary host list second, and the
 * verdict kept per row so a report can say which of the two counted a session.
 * GA4 has no dimension filter for "is an AI assistant" that covers both, so the
 * rows are read unfiltered and sorted through here. The limit is high for the
 * same reason — a truncated read silently drops AI sources sitting below the cut
 * — and when it does truncate, `readReport` says so in `caveats`.
 *
 * ── AI-referred: each figure at its own grain ──
 *
 * Sessions add up across rows and users do not. The same person reaching two
 * landing pages from ChatGPT is one user and two rows, so a user count summed out
 * of a source × landing page report overstates it. GA4 deduplicates within
 * whatever grain it is asked for, so users are read from the source × medium
 * report and never from the landing one, and landing pages carry sessions only.
 * The one sum left is a source that arrived under both mediums in one window —
 * Google recognising an assistant partway through it — and that figure is marked
 * as an upper bound rather than passed off as a count.
 *
 * ── Organic: Google's, and only Google's ──
 *
 * Organic here is **Google organic search**: `sessionSource == google AND
 * sessionMedium == organic`. It is narrower than GA4's `Organic Search` channel
 * group or `sessionMedium == organic`, both of which take in Bing, DuckDuckGo,
 * Yahoo, Ecosia and every other engine, and that is the point: Search Console
 * reports Google alone, and it is the only definition whose pages can be joined
 * to Search Console's. Every Tool reading it sits beside Search Console data —
 * `gsc_page_value` joins the two page by page, and `site_ai_landing_signals`
 * picks "the busiest organic pages" that an Operator will check against the
 * `gsc_*` Tools — so a broader slice would credit Google's clicks with other
 * engines' sessions, or name pages as organic that Search Console has never heard
 * of. The cost is real on a site with meaningful Bing or DuckDuckGo traffic: those
 * sessions are in no organic figure here. GA4 also files some Discover, Images and
 * News visits under google / organic by its own rules, so even this slice is not
 * exactly the traffic Search Console counts; the Tools that join it say so.
 *
 * ── Landing pages GA4 could not name ──
 *
 * GA4 writes `""` or `(not set)` for a session it could not attribute a landing
 * page to. Those are unattributed sessions, not visits to `/`: see `landingUrl`
 * in `url-match.ts`. Both slices count them apart, here, so no Tool credits the
 * root with every session GA4 lost track of.
 *
 * Every read throws whatever the reader throws. A refusal from Google is the whole
 * answer to "how much of this traffic is there?", and a Tool crossing a slice with
 * something else must not carry on with an empty one as if the property had none.
 */
import { classifyAiReferrer } from "./ai-referrers";
import { readReport, type ReportTable } from "./ga4-report";
import type { GoogleReader } from "./reader";
import { pathKey } from "../url-match";

/** A property and a date range, which is all either slice needs. `Ga4Window` fits. */
export interface SegmentWindow {
  property: string;
  dateRange: { startDate: string; endDate: string };
}

/** How many rows to ask GA4 for when reading AI referrals. See the header for why it is high. */
const AI_ROW_LIMIT = 10_000;

const BY_SESSIONS = [{ metric: { metricName: "sessions" }, desc: true }];

type Row = ReportTable["rows"][number];

// A cell by its header rather than its position, so the order a report's
// columns come back in cannot move a figure into the wrong field.
function dimension(table: ReportTable, row: Row, name: string): string {
  const at = table.dimensions.indexOf(name);
  return at >= 0 ? (row.dimensions[at] ?? "") : "";
}

function metric(table: ReportTable, row: Row, name: string): number {
  const at = table.metrics.indexOf(name);
  return at >= 0 ? (row.metrics[at] ?? 0) : 0;
}

/** Whether GA4 named a page for this landing, per the header's rule. */
function namesAPage(landingPage: string): boolean {
  return pathKey(landingPage) !== null;
}

// ── AI-referred ─────────────────────────────────────────────────────────────

export interface AiSource {
  /** The session source, lower-cased: `chatgpt.com`, `perplexity.ai`. */
  source: string;
  sessions: number;
  /** Of `sessions`, how many only the host list counted — Google did not classify them. */
  fromHostList: number;
  /** Distinct users, when read `withUsers`; `null` otherwise. */
  users: number | null;
  /**
   * The source arrived under both mediums, so `users` is the sum of two rows and
   * may count one person twice. An upper bound, not a count.
   */
  usersUpperBound: boolean;
}

export interface AiLanding {
  /** As GA4 wrote it: always a path, since unattributed rows are counted apart. */
  page: string;
  /** AI-referred sessions landing here, from every AI source together. */
  sessions: number;
}

export interface AiReferred {
  /** Busiest first. */
  sources: AiSource[];
  /** Every AI-referred session in the window. */
  sessions: number;
  /** Of `sessions`, how many only the host list counted. */
  fromHostList: number;
  /**
   * Every session on the property in the window, from GA4's own total rather than
   * from adding up rows — `limit` truncates, and a share over whatever survived
   * it is a fraction of the wrong number. `null` when GA4 reported no total.
   */
  siteSessions: number | null;
  /** When read `byLanding`: the pages, busiest first, and the sessions GA4 could not place. */
  landings: { pages: AiLanding[]; unattributed: number } | null;
  /** When read with `compareWith`: the same slice over that window. */
  previous: { sessions: number; bySource: ReadonlyMap<string, number> } | null;
  /** What GA4 said these reports are not — sampled, thresholded, truncated. */
  caveats: string[];
}

export interface AiReferredOptions {
  /** Also read AI-referred sessions by landing page. */
  byLanding?: boolean;
  /** Also read distinct users per source, at the source's own grain. */
  withUsers?: boolean;
  /** A second window to read the same slice over, for a change figure. */
  compareWith?: { startDate: string; endDate: string };
}

/**
 * The AI-referred sessions in one window: by source always, by landing page and
 * against an earlier window when asked.
 */
export async function aiReferred(
  google: GoogleReader,
  window: SegmentWindow,
  options: AiReferredOptions = {},
): Promise<AiReferred> {
  const bySourceQuery = (dateRange: { startDate: string; endDate: string }, withUsers: boolean) => ({
    property: window.property,
    dateRanges: [dateRange],
    dimensions: ["sessionSource", "sessionMedium"],
    metrics: withUsers ? ["sessions", "totalUsers"] : ["sessions"],
    orderBys: BY_SESSIONS,
    limit: AI_ROW_LIMIT,
  });

  // Asked together: they are independent, and a refusal on any one is the
  // refusal of the whole reading.
  const [sourceReport, landingReport, previousReport] = await Promise.all([
    google.analytics.runReport({
      ...bySourceQuery(window.dateRange, options.withUsers === true),
      metricAggregations: ["TOTAL"],
    }),
    options.byLanding
      ? google.analytics.runReport({
          property: window.property,
          dateRanges: [window.dateRange],
          dimensions: ["sessionSource", "sessionMedium", "landingPage"],
          metrics: ["sessions"],
          orderBys: BY_SESSIONS,
          limit: AI_ROW_LIMIT,
        })
      : null,
    options.compareWith ? google.analytics.runReport(bySourceQuery(options.compareWith, false)) : null,
  ]);

  const sourceTable = readReport(sourceReport);
  const bySource = new Map<string, AiSource>();
  let sessions = 0;
  let fromHostList = 0;
  for (const row of aiRows(sourceTable)) {
    const users = options.withUsers ? metric(sourceTable, row.row, "totalUsers") : null;
    const hostListed = row.verdict === "host-list" ? row.sessions : 0;
    const known = bySource.get(row.source);
    if (known) {
      // A second row for one source is the same source under the other
      // medium. Sessions add; users only bound — see the header.
      known.sessions += row.sessions;
      known.fromHostList += hostListed;
      if (known.users !== null && users !== null) {
        known.users += users;
        known.usersUpperBound = true;
      }
    } else {
      bySource.set(row.source, {
        source: row.source,
        sessions: row.sessions,
        fromHostList: hostListed,
        users,
        usersUpperBound: false,
      });
    }
    sessions += row.sessions;
    fromHostList += hostListed;
  }

  const caveats = [...sourceTable.caveats];

  let landings: AiReferred["landings"] = null;
  if (landingReport) {
    const table = readReport(landingReport);
    caveats.push(...table.caveats);
    const pages = new Map<string, number>();
    let unattributed = 0;
    for (const row of aiRows(table)) {
      const page = dimension(table, row.row, "landingPage");
      if (!namesAPage(page)) {
        unattributed += row.sessions;
        continue;
      }
      pages.set(page, (pages.get(page) ?? 0) + row.sessions);
    }
    landings = {
      pages: [...pages.entries()]
        .map(([page, pageSessions]) => ({ page, sessions: pageSessions }))
        .sort((a, b) => b.sessions - a.sessions),
      unattributed,
    };
  }

  let previous: AiReferred["previous"] = null;
  if (previousReport) {
    const table = readReport(previousReport);
    // Labelled, because a change figure is only as good as both of its ends and
    // the reader should know which end GA4 qualified.
    caveats.push(...table.caveats.map((caveat) => `In the comparison window: ${caveat}`));
    const earlier = new Map<string, number>();
    let total = 0;
    for (const row of aiRows(table)) {
      earlier.set(row.source, (earlier.get(row.source) ?? 0) + row.sessions);
      total += row.sessions;
    }
    previous = { sessions: total, bySource: earlier };
  }

  const siteTotal = sourceTable.totals[sourceTable.metrics.indexOf("sessions")];

  return {
    sources: [...bySource.values()].sort((a, b) => b.sessions - a.sessions),
    sessions,
    fromHostList,
    siteSessions: typeof siteTotal === "number" ? siteTotal : null,
    landings,
    previous,
    caveats: [...new Set(caveats)],
  };
}

/** The rows of a source × medium report that an AI assistant sent, each with its verdict. */
function* aiRows(table: ReportTable) {
  for (const row of table.rows) {
    const source = dimension(table, row, "sessionSource").toLowerCase();
    const verdict = classifyAiReferrer(source, dimension(table, row, "sessionMedium"));
    if (!verdict) continue;
    yield { row, source, verdict, sessions: metric(table, row, "sessions") };
  }
}

/**
 * What a GA4 count of AI traffic cannot see, said by every Tool that prints one.
 *
 * Only visits that arrived with a referrer are here. An assistant that answers
 * from a page without linking to it sends no visit, and a reader who copies a
 * link into a new tab arrives as Direct.
 */
export const REFERRER_ONLY_CAVEAT = [
  "GA4 only sees AI visits that arrived with a referrer. An assistant that answers",
  "from a page without linking to it sends no visit, and a link copied into a new",
  "tab arrives as Direct, so these counts are a floor on how often the site is",
  "read by AI assistants, not a count of it.",
];

// ── Google organic ──────────────────────────────────────────────────────────

/** The filter that is this module's definition of organic. See the header. */
const GOOGLE_ORGANIC_FILTER = {
  andGroup: {
    expressions: [
      { filter: { fieldName: "sessionSource", stringFilter: { matchType: "EXACT", value: "google" } } },
      { filter: { fieldName: "sessionMedium", stringFilter: { matchType: "EXACT", value: "organic" } } },
    ],
  },
};

export interface OrganicLanding {
  /** As GA4 wrote it: always a path, since unattributed rows are counted apart. */
  landingPage: string;
  sessions: number;
  engagedSessions: number;
  keyEvents: number;
}

export interface OrganicLandings {
  /** Busiest first. */
  pages: OrganicLanding[];
  /** The rows GA4 could not name a landing page for, and their sessions. */
  unattributed: { rows: number; sessions: number };
  /** Every row GA4 returned, attributed or not. */
  rowsRead: number;
  /** What GA4 said this report is not — sampled, thresholded, truncated. */
  caveats: string[];
}

/**
 * Google organic sessions by landing page, busiest first.
 *
 * @param limit how many rows to ask for. The caller's, because the right depth
 *        is the caller's: a join against Search Console wants every page, a
 *        sample of the busiest wants a few hundred.
 */
export async function organicLandings(
  google: GoogleReader,
  window: SegmentWindow,
  { limit }: { limit: number },
): Promise<OrganicLandings> {
  const table = readReport(
    await google.analytics.runReport({
      property: window.property,
      dateRanges: [window.dateRange],
      dimensions: ["landingPage"],
      metrics: ["sessions", "engagedSessions", "keyEvents"],
      dimensionFilter: GOOGLE_ORGANIC_FILTER,
      orderBys: BY_SESSIONS,
      limit,
    }),
  );

  const pages: OrganicLanding[] = [];
  const unattributed = { rows: 0, sessions: 0 };
  for (const row of table.rows) {
    const landing = {
      landingPage: dimension(table, row, "landingPage"),
      sessions: metric(table, row, "sessions"),
      engagedSessions: metric(table, row, "engagedSessions"),
      keyEvents: metric(table, row, "keyEvents"),
    };
    if (namesAPage(landing.landingPage)) {
      pages.push(landing);
    } else {
      unattributed.rows++;
      unattributed.sessions += landing.sessions;
    }
  }

  return {
    pages: pages.sort((a, b) => b.sessions - a.sessions),
    unattributed,
    rowsRead: table.rows.length,
    caveats: table.caveats,
  };
}
