import { z } from "zod";
import { type ToolMetadata, type InferSchema } from "xmcp";
import {
  captureDate,
  readPrefix,
  readUrlHistory,
  replayUrl,
  URL_LIMIT,
  VERSION_LIMIT,
  type Capture,
  type PrefixRead,
  type UrlHistory,
  type Window,
} from "../lib/wayback-cdx";
import { fetchAnyStatus } from "../lib/http-client";
import { PageFetchError } from "../lib/page-fetch-error";
import { RobotsDisallowedError, ROBOTS_REFUSAL } from "../lib/robots-gate";
import { CrawlBudgetError } from "../lib/crawl-pacing";
import { InvalidInputError } from "../lib/invalid-input-error";
import { defineCachedTool } from "../lib/define-tool";
import { domainFromUrl, refreshable } from "../lib/with-cache";
import { toolText } from "../lib/tool-result";
import { capped } from "../lib/render-list";
import { basisSection, notCheckedSection, type NotChecked } from "../lib/render-basis";

/** `YYYY`, `YYYYMM` or `YYYYMMDD` — what the CDX server accepts as a partial timestamp. */
const PARTIAL_DATE = /^\d{4}(?:\d{2}(?:\d{2})?)?$/;

/** The live-site reading depth for a prefix or domain read. Stated, not rationed. */
const DEFAULT_LIVE_CHECKS = 20;
const MAX_LIVE_CHECKS = 50;

export const schema = {
  ...refreshable,
  url: z
    .string()
    .url()
    .describe(
      "The page to look up. With scope prefix, the path to read under (https://example.com/blog/); " +
        "with scope domain, any URL on the site",
    ),
  scope: z
    .enum(["url", "prefix", "domain"])
    .optional()
    .describe(
      "url: this URL's capture history. prefix: every URL the archive holds under this path, " +
        "checked for lost pages. domain: the same across the host and its subdomains. Default: url",
    ),
  from: z
    .string()
    .regex(PARTIAL_DATE)
    .optional()
    .describe("Earliest capture to read, as YYYY, YYYYMM or YYYYMMDD. Default: the first one"),
  to: z
    .string()
    .regex(PARTIAL_DATE)
    .optional()
    .describe("Latest capture to read, inclusive, as YYYY, YYYYMM or YYYYMMDD. Default: the latest"),
  live_checks: z
    .number()
    .int()
    .min(0)
    .max(MAX_LIVE_CHECKS)
    .optional()
    .describe(
      `prefix and domain only: how many archived URLs to fetch on the live site now, to see which ` +
        `are lost. URLs the archive saw die are checked first. Default: ${DEFAULT_LIVE_CHECKS}`,
    ),
};

export const metadata: ToolMetadata = {
  name: "wayback_history",
  description:
    "What the Internet Archive's Wayback Machine holds for a URL: first and latest capture, how " +
    "many distinct content versions it captured and when the content changed, and the status " +
    "history — when it started redirecting or answering 404. With scope prefix or domain, lists " +
    "the URLs the archive saw answering 200 under a path, checks a stated number of them on the " +
    "live site now, and reports the lost pages (now 404 or 410) and redirects. Archive coverage " +
    "is not site history: a missing capture is a fact about the archive. Needs no credentials " +
    "and no database.",
  annotations: {
    title: "Read Wayback Machine history",
    readOnlyHint: true,
    destructiveHint: false,
    // Nothing is written anywhere, so a repeat changes nothing — though the
    // archive adds captures and the live check reads the site as it is now.
    idempotentHint: true,
    openWorldHint: true,
  },
};

/** Completes the sentence "Could not …" for every failure this Tool can return. */
const FAILURE_CONTEXT = "read the Wayback Machine's history for this URL";

/** How many content versions to list line by line, newest first. */
const VERSIONS_SHOWN = 15;

/**
 * What the archive is not, under the basis section that closes every answer.
 *
 * It used to open the answer, before any date, because every date invites the
 * same misreading. It closes it now because that is where every Tool says what
 * its answer rests on, and an agent that has learned to look there for what a
 * figure is worth finds this with the rest.
 */
const COVERAGE = [
  "Archive coverage is not site history. The Wayback Machine captures pages",
  "selectively and irregularly, honours exclusion requests, and never saw many real",
  "pages. A first capture means \"existed no later than\", a gap between captures is",
  "silence rather than downtime, and a status is what the site answered the archive",
  "on that day.",
];

function statusLabel(status: number | null): string {
  return status === null ? "no status recorded" : `HTTP ${status}`;
}

function windowLabel(window: Window): string {
  if (!window.from && !window.to) return "every capture";
  return `captures from ${window.from ?? "the first"} to ${window.to ?? "the latest"}`;
}

// ── One URL ──────────────────────────────────────────────────────────────────

/**
 * The status runs across the versions: "HTTP 200 from …, HTTP 301 from …".
 *
 * Read off the collapsed versions rather than every capture, which is enough: a
 * status change is a payload change, so it always starts a new version. The one
 * blind spot is two statuses with byte-identical bodies — an empty 301 followed
 * by an empty 302 — which collapse into one run.
 */
function statusRuns(versions: Capture[]): Array<{ status: number | null; from: Capture; count: number }> {
  const runs: Array<{ status: number | null; from: Capture; count: number }> = [];
  for (const version of versions) {
    const last = runs.at(-1);
    if (last && last.status === version.status) last.count++;
    else runs.push({ status: version.status, from: version, count: 1 });
  }
  return runs;
}

function renderUrl(url: string, window: Window, history: UrlHistory): string[] {
  const lines = [
    "=== WAYBACK MACHINE HISTORY ===",
    "",
    `URL: ${url}`,
    "",
  ];

  const { versions, latest, truncated } = history;
  const first = versions[0];
  if (!first) {
    lines.push(
      `The archive holds no capture of this URL (${windowLabel(window)}). That is a fact about the`,
      "archive's coverage, not about the page: it may never have been crawled, or its owner may",
      "have asked to be excluded.",
    );
    return lines;
  }

  lines.push(`First capture: ${captureDate(first.timestamp)} (${statusLabel(first.status)})`);
  if (latest) {
    lines.push(`Latest capture: ${captureDate(latest.timestamp)} (${statusLabel(latest.status)})`);
  }
  lines.push(
    `Content versions: ${versions.length}${truncated ? "+" : ""} — captures whose payload differed ` +
      "from the capture before them.",
    "  Any changed byte counts, a date stamp or a rotating banner included, so a high count on",
    "  a dynamic page is markup churn more often than edits (inference).",
  );
  if (truncated) {
    const reachedTo = versions.at(-1);
    lines.push(
      `  The archive holds more than ${VERSION_LIMIT.toLocaleString("en-US")} versions in this window; ` +
        `this read the oldest ${VERSION_LIMIT.toLocaleString("en-US")},`,
      `  up to ${reachedTo ? captureDate(reachedTo.timestamp) : "unknown"}. The status history below stops there too.`,
      "  Pass `from` to read a later stretch.",
    );
  }

  lines.push("", "=== STATUS HISTORY ===", "");
  const runs = statusRuns(versions);
  runs.forEach((run, i) => {
    const next = runs[i + 1];
    const until = next
      ? `until ${captureDate(next.from.timestamp)}`
      : truncated
        ? "(the read stopped here)"
        : "(still so at the latest capture)";
    lines.push(
      `${statusLabel(run.status)} from ${captureDate(run.from.timestamp)} ${until} — ` +
        `${run.count} version${run.count === 1 ? "" : "s"}`,
    );
  });
  const changes = runs.length - 1;
  lines.push(
    "",
    changes === 0
      ? `The archive saw one status throughout: ${statusLabel(first.status)}.`
      : `The status changed ${changes} time${changes === 1 ? "" : "s"}. A change is dated by the first ` +
          "capture that showed it; it happened at some point since the capture before.",
  );

  lines.push("", "=== CONTENT VERSIONS (newest first) ===", "");
  const newestFirst = [...versions].reverse();
  const rows = newestFirst.map(
    (v) =>
      `${captureDate(v.timestamp)}  ${statusLabel(v.status).padEnd(9)}  ${(v.mimetype || "unknown type").padEnd(10)}  ` +
      `${v.length === null ? "" : `${v.length.toLocaleString("en-US")} bytes stored  `}${replayUrl(v)}`,
  );
  lines.push(...capped(rows, VERSIONS_SHOWN, { indent: "", noun: "versions" }));
  return lines;
}

// ── A prefix or a domain ─────────────────────────────────────────────────────

/** Extensions that are pages. Anything else with an extension is an asset. */
const PAGE_EXTENSIONS = new Set(["html", "htm", "shtml", "php", "asp", "aspx", "jsp", "cfm"]);

/**
 * Whether an archived URL is plausibly a page somebody meant to publish.
 *
 * The archive holds every URL anything ever linked, and a site's index is full
 * of what nobody published on purpose: every `?utm_` and `?replytocom=` variant
 * of a post, `gtm.js` captured as HTML under every directory, and paths with a
 * quote or a backslash in them scraped out of broken markup. Checking those
 * against the live site would report as lost pages that never existed.
 */
function isPageLike(original: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(original);
  } catch {
    return false;
  }
  if (parsed.search) return false;
  const path = parsed.pathname.toLowerCase();
  if (/[\\"'<>{}|^`]|%22|%5c|%3c|%3e|%7b|%7d/.test(path)) return false;
  const extension = /\.([a-z0-9]{1,5})$/.exec(path.split("/").pop() ?? "")?.[1];
  return extension === undefined || PAGE_EXTENSIONS.has(extension);
}

/** The archived URL as it would be asked for today: the Operator's scheme, no port. */
function liveUrlFor(original: string, scheme: string): string {
  const parsed = new URL(original);
  parsed.protocol = scheme;
  parsed.port = "";
  return parsed.toString();
}

type LiveOutcome =
  | { kind: "answered"; status: number; finalUrl: string; redirected: boolean }
  | { kind: "not-checked"; reason: string };

/**
 * One URL on the live site, now.
 *
 * Through `fetchAnyStatus`, so robots.txt and the pace bind it like every other
 * fetch of the Operator's site, and a 404 is an answer rather than a throw. The
 * failures that are ours to describe become "not checked" with the reason; an
 * SSRF refusal travels on, because it would refuse every other URL on the host
 * too.
 */
async function checkLive(url: string): Promise<LiveOutcome> {
  try {
    const { response, finalUrl, redirectCount } = await fetchAnyStatus(url, { timeout: 10_000 });
    await response.body?.cancel();
    return { kind: "answered", status: response.status, finalUrl, redirected: redirectCount > 0 };
  } catch (error) {
    if (error instanceof RobotsDisallowedError) {
      return { kind: "not-checked", reason: ROBOTS_REFUSAL };
    }
    if (error instanceof CrawlBudgetError) {
      return { kind: "not-checked", reason: "this server's per-minute budget for the site was spent" };
    }
    if (error instanceof PageFetchError) return { kind: "not-checked", reason: "no response" };
    if (error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError")) {
      return { kind: "not-checked", reason: "no response within 10 seconds" };
    }
    if (error instanceof TypeError) return { kind: "not-checked", reason: "the connection failed" };
    throw error;
  }
}

interface Candidate {
  live: Capture;
  /** The first 404 or 410 capture after the first 200, when the archive has one. */
  diedAt: Capture | null;
  url: string;
}

async function renderPrefix(
  url: string,
  scope: "prefix" | "domain",
  window: Window,
  liveChecks: number,
  read: PrefixRead,
): Promise<string[]> {
  const asked = new URL(url);
  const pathPrefix = asked.pathname.toLowerCase();
  const subject = scope === "domain" ? `${asked.hostname} and its subdomains` : `${asked.host}${asked.pathname}`;

  // The archive's prefix match is on its lower-cased key, which drops a trailing
  // slash — so `/hub/` also matched `/hubspot`. The real path decides.
  const underPath = (capture: Capture): boolean => {
    if (scope === "domain") return true;
    try {
      return new URL(capture.original).pathname.toLowerCase().startsWith(pathPrefix);
    } catch {
      return false;
    }
  };

  const inScope = read.live.filter(underPath);
  const pages = inScope.filter((c) => isPageLike(c.original));
  const skipped = inScope.length - pages.length;

  const goneByKey = new Map(read.gone.filter(underPath).map((c) => [c.urlkey, c]));
  // When the 404 read was cut short, a URL past its last key may have died
  // unseen. Those are left to the live check rather than called either way.
  const goneReachedKey = read.goneTruncated ? read.gone.at(-1)?.urlkey : undefined;

  const candidates: Candidate[] = pages.map((live) => {
    const gone = goneByKey.get(live.urlkey);
    return {
      live,
      diedAt: gone && gone.timestamp > live.timestamp ? gone : null,
      url: liveUrlFor(live.original, asked.protocol),
    };
  });
  const seenDying = candidates
    .filter((c) => c.diedAt !== null)
    .sort((a, b) => (b.diedAt as Capture).timestamp.localeCompare((a.diedAt as Capture).timestamp));
  const others = candidates.filter((c) => c.diedAt === null);

  const lines = [
    "=== WAYBACK MACHINE: LOST PAGES ===",
    "",
    `Subject: ${subject}`,
    "",
  ];

  if (pages.length === 0) {
    lines.push(
      inScope.length === 0
        ? `The archive holds no capture that answered 200 with HTML here (${windowLabel(window)}).`
        : `The archive holds ${inScope.length} URL(s) here that answered 200, and none looks like a page ` +
            "(query-string variants, assets and malformed paths are skipped).",
      "That is a fact about the archive's coverage, not about the site.",
    );
    return lines;
  }

  lines.push(
    `URLs the archive saw answering 200 with HTML: ${pages.length}` +
      (skipped > 0 ? ` (${skipped} more skipped as query-string variants, assets or malformed paths)` : ""),
    `Of those, later captured answering 404 or 410: ${seenDying.length}`,
  );
  if (read.liveTruncated) {
    const last = read.live.at(-1);
    lines.push(
      `The archive holds more than ${URL_LIMIT.toLocaleString("en-US")} such URLs here; this read the first ` +
        `${URL_LIMIT.toLocaleString("en-US")} in its`,
      `own (alphabetical) order, up to ${last?.original ?? "unknown"}. Narrow the path to read the rest.`,
    );
  }
  if (goneReachedKey) {
    lines.push(
      `The archive's 404/410 list was also cut at ${URL_LIMIT.toLocaleString("en-US")} URLs, so a URL after ` +
        `${read.gone.at(-1)?.original ?? "that point"} may have died without it being seen here.`,
    );
  }

  const toCheck = [...seenDying, ...others].slice(0, liveChecks);
  lines.push(
    "",
    `=== LIVE CHECK (${toCheck.length} of ${pages.length} fetched now, the ones the archive saw die first) ===`,
    "",
  );
  if (toCheck.length === 0) {
    lines.push("None fetched: live_checks is 0. Every URL above is unchecked against the live site.");
    return lines;
  }

  const outcomes: Array<{ candidate: Candidate; outcome: LiveOutcome }> = [];
  for (const candidate of toCheck) {
    outcomes.push({ candidate, outcome: await checkLive(candidate.url) });
  }

  const history = (c: Candidate): string =>
    `archived 200 on ${captureDate(c.live.timestamp)}` +
    (c.diedAt ? `, archived ${statusLabel(c.diedAt.status)} on ${captureDate(c.diedAt.timestamp)}` : "");

  const lost: string[] = [];
  const redirected: string[] = [];
  const otherStatus: string[] = [];
  const stillLive: string[] = [];
  const notChecked: NotChecked[] = [];
  for (const { candidate, outcome } of outcomes) {
    if (outcome.kind === "not-checked") {
      notChecked.push({ subject: candidate.url, reason: outcome.reason });
    } else if (outcome.status === 404 || outcome.status === 410) {
      const tail = outcome.redirected ? ` (after redirecting to ${outcome.finalUrl})` : "";
      lost.push(
        `${candidate.url} — HTTP ${outcome.status} now${tail}; ${history(candidate)}. ` +
          `Archived copy: ${replayUrl(candidate.live)}`,
      );
    } else if (outcome.redirected) {
      const home = new URL(outcome.finalUrl).pathname === "/" ? " (the home page)" : "";
      redirected.push(`${candidate.url} → ${outcome.finalUrl}${home}, HTTP ${outcome.status}`);
    } else if (outcome.status >= 200 && outcome.status < 300) {
      stillLive.push(candidate.url);
    } else {
      otherStatus.push(`${candidate.url} — HTTP ${outcome.status} now; ${history(candidate)}`);
    }
  }

  const section = (title: string, rows: string[]) => {
    if (rows.length === 0) return;
    lines.push(`${title}: ${rows.length}`, ...rows.map((row) => `  ${row}`), "");
  };
  section("Lost — answering 404 or 410 now", lost);
  section("Redirected", redirected);
  section("Answering another status", otherStatus);
  lines.push(`Still answering 2xx: ${stillLive.length}`);
  lines.push(...capped(stillLive, 10, { noun: "URLs" }));

  const unchecked = pages.length - toCheck.length;
  if (unchecked > 0) {
    lines.push(
      "",
      `Not fetched: ${unchecked} archived URL(s). Their live status is unknown, not fine. Pass ` +
        `live_checks (up to ${MAX_LIVE_CHECKS}) or narrow the path to check more.`,
    );
  }
  // Every one fetched and unanswered is listed: the cap is `live_checks`.
  lines.push(...notCheckedSection(notChecked, { noun: "URLs", cap: toCheck.length }));
  return lines;
}

// ── The Tool ─────────────────────────────────────────────────────────────────

/** What either answer rests on: the index it was read from, and what that index is not. */
function archiveBasis(window: Window): string[] {
  return basisSection({
    read: [`Read: ${windowLabel(window)}, from the Internet Archive's CDX index`],
    limits: COVERAGE,
  });
}

export async function handler({
  url,
  scope,
  from,
  to,
  live_checks: liveChecks,
}: InferSchema<typeof schema>) {
  const window: Window = { from, to };
  if (from && to && from > to.padEnd(from.length, "9")) {
    throw new InvalidInputError(`from (${from}) is after to (${to}), so the window is empty.`);
  }

  const mode = scope ?? "url";
  if (mode === "url") {
    const history = await readUrlHistory(url, window);
    return toolText([...renderUrl(url, window, history), ...archiveBasis(window)].join("\n"));
  }

  const read = await readPrefix(url, mode, window);
  const lines = await renderPrefix(url, mode, window, liveChecks ?? DEFAULT_LIVE_CHECKS, read);
  return toolText([...lines, ...archiveBasis(window)].join("\n"));
}

export default defineCachedTool(
  FAILURE_CONTEXT,
  { toolName: "wayback_history", domainOf: domainFromUrl },
  handler,
);
