/**
 * A Site's sitemaps, found and read, with each URL's `<lastmod>` kept.
 *
 * ── One reader ──
 *
 * There were three. `sitemap-parser.ts` returned URLs and nothing else, looked
 * only at `/sitemap.xml`, and logged a failed child and carried on — right for a
 * generated `llms.txt`, wrong for a report, where a sitemap we could not read is
 * "not checked" rather than "lists nothing". `seo_geo_score` had a third, a regex
 * over the index that followed five children and handed the analyzer XML text,
 * which then ran a second regex and a URL normaliser of its own to find one
 * page's `<lastmod>`. Three readers meant three answers to "is this page in the
 * sitemap": they disagreed about gzip, about a child that would not load, and
 * about whether `http://www.` and `https://` name the same page.
 *
 * Now every caller reads here. The ones that walk every entry take `entries`;
 * the one that asks about a single page takes {@link listingFor}, which is where
 * "absence is only proof if we read everything" is decided, once.
 *
 * ── Where the sitemaps come from ──
 *
 * In order: a sitemap the caller names outright; then the ones the Operator
 * submitted to Search Console, because those are the ones Google is reading —
 * asked only when the caller holds a reader and a property, which a
 * credential-free Tool does not; then any `Sitemap:` line in robots.txt; then
 * `/sitemap.xml`, the convention, only when nothing named one.
 *
 * ── Bounded ──
 *
 * A sitemap index can list hundreds of children and each is a request to the
 * Operator's server, which `crawl-pacing` caps per origin per minute. So files
 * and URLs are both capped, and the read says when it stopped at either.
 */
import { XMLParser } from "fast-xml-parser";
import { gunzipSync } from "node:zlib";
import { fetchAnyStatus } from "./http-client";
import { RobotsDisallowedError, ROBOTS_REFUSAL } from "./robots-gate";
import { CrawlBudgetError } from "./crawl-pacing";
import type { NotChecked } from "./render-basis";
import { readWellKnown } from "./well-known";
import { classifyRobotsStatus, parseRobots } from "./analyzers/robots-ruleset";
import { urlKey } from "./url-match";
import { logError } from "./log";
import type { SearchConsoleReader } from "./google/reader";

/** How many sitemap files one read fetches, index and children together. */
export const MAX_SITEMAP_FILES = 20;

/** How many URLs one read keeps. Well past what any sampled comparison uses. */
export const MAX_SITEMAP_URLS = 10_000;

/** Nesting depth for indexes of indexes. An index that lists itself stops here too. */
const MAX_DEPTH = 3;

const REQUEST_TIMEOUT = 10_000;

export interface SitemapEntry {
  /** As the sitemap wrote it. */
  loc: string;
  /** As the sitemap wrote it, or `null` when it gave none. Never parsed here. */
  lastmod: string | null;
  /** The file it came from. */
  sitemap: string;
  /** When that file was fetched, epoch ms. What "stamped at generation" is judged against. */
  fetchedAt: number;
}

export type SitemapSource = "argument" | "search-console" | "robots.txt" | "convention";

/**
 * Why a file gave us no entries, in the three states `well-known.ts` names.
 *
 * - `absent` — 404 or 410. The file is not there, and that is an answer.
 * - `not-a-sitemap` — it answered, and what it answered with is not a sitemap
 *   anyone can read: not well-formed XML, not a `<urlset>` or `<sitemapindex>`,
 *   a gzip that will not inflate. Also an answer, about the site.
 * - `unavailable` — a 5xx, a timeout, robots.txt closing it to us. We did not
 *   find out what it lists, and nothing may be concluded from its silence.
 */
export type SitemapFailureKind = "absent" | "not-a-sitemap" | "unavailable";

export interface SitemapRead {
  /** The top-level sitemaps tried, and why each was. */
  roots: Array<{ url: string; source: SitemapSource }>;
  entries: SitemapEntry[];
  /** Every file that answered with a sitemap, indexes included. */
  filesRead: string[];
  /** Every file that did not, with a sentence we wrote rather than one a server did. */
  failed: Array<{ url: string; reason: string; kind: SitemapFailureKind }>;
  /** True when a cap stopped the read before the sitemaps ran out. */
  truncated: boolean;
  /** The caps this read ran under, so a sentence about stopping can name them. */
  limits: { maxFiles: number; maxUrls: number };
}

type Roots = SitemapRead["roots"];

/**
 * Which sitemaps to read for a Site.
 *
 * Search Console's list is asked through the reader, so a refusal there
 * propagates like any other Google refusal: it is the Operator's data, and a
 * Tool that silently fell back to guessing would be answering a different
 * question from the one asked. Without a reader and a property that step is
 * skipped, not failed: a credential-free Tool was never asking Google.
 */
export async function findSitemaps(
  origin: string,
  options: { searchConsole?: SearchConsoleReader; property?: string; explicit?: string } = {},
): Promise<Roots> {
  if (options.explicit) return [{ url: options.explicit, source: "argument" }];

  if (options.searchConsole && options.property) {
    const submitted = (await options.searchConsole.listSitemaps(options.property))
      .map((sitemap) => sitemap.path)
      .filter((path): path is string => typeof path === "string" && path.length > 0);
    if (submitted.length > 0) {
      return [...new Set(submitted)].map((url) => ({ url, source: "search-console" as const }));
    }
  }

  const robots = await readWellKnown(origin, "/robots.txt");
  const declared = robots.outcome === "found" ? parseRobots(robots.text).sitemaps : [];
  if (declared.length > 0) {
    return [...new Set(declared)].map((url) => ({ url, source: "robots.txt" as const }));
  }

  return [{ url: new URL("/sitemap.xml", origin).toString(), source: "convention" }];
}

/**
 * One child, many or none, as a list.
 *
 * `fast-xml-parser` gives a lone `<url>` as an object and two as an array. It
 * also gives *no* children as `undefined` — an empty `<urlset xmlns="…">` parses
 * to an object holding only the namespace, or to `""` — and `[undefined]` then
 * reached a `.loc`. An empty sitemap is a valid sitemap, and it read as a crash.
 */
function toList<T>(value: T[] | T | undefined | null): T[] {
  if (value === undefined || value === null) return [];
  return Array.isArray(value) ? value : [value];
}

/** A text node, whatever shape the parser left it in. */
function textOf(value: unknown): string | null {
  if (typeof value === "string") return value.trim() || null;
  if (typeof value === "number") return String(value);
  if (value && typeof value === "object" && "#text" in value) {
    return textOf((value as Record<string, unknown>)["#text"]);
  }
  return null;
}

/**
 * Read every sitemap reachable from these roots, within the caps.
 *
 * A file that fails loses only itself — Google reads the rest of an index when
 * one child is bad, and so does this — but it is recorded in `failed`, never
 * dropped, so a report can say it was not checked.
 */
export async function readSitemaps(
  roots: Roots,
  options: { maxFiles?: number; maxUrls?: number } = {},
): Promise<SitemapRead> {
  const maxFiles = options.maxFiles ?? MAX_SITEMAP_FILES;
  const maxUrls = options.maxUrls ?? MAX_SITEMAP_URLS;
  const parser = new XMLParser({ ignoreAttributes: true, parseTagValue: false });

  const read: SitemapRead = {
    roots,
    entries: [],
    filesRead: [],
    failed: [],
    truncated: false,
    limits: { maxFiles, maxUrls },
  };
  const seenFiles = new Set<string>();
  const seenUrls = new Set<string>();
  const queue = roots.map((root) => ({ url: root.url, depth: 0 }));

  while (queue.length > 0) {
    const next = queue.shift()!;
    if (seenFiles.has(next.url)) continue;
    if (seenFiles.size >= maxFiles || read.entries.length >= maxUrls) {
      read.truncated = true;
      break;
    }
    seenFiles.add(next.url);

    const fetched = await fetchSitemapFile(next.url);
    if (!fetched.ok) {
      read.failed.push({ url: next.url, reason: fetched.reason, kind: fetched.kind });
      continue;
    }

    let parsed: Record<string, unknown>;
    try {
      parsed = parser.parse(fetched.xml) as Record<string, unknown>;
    } catch {
      read.failed.push({ url: next.url, reason: "it is not well-formed XML", kind: "not-a-sitemap" });
      continue;
    }

    const index = parsed.sitemapindex as { sitemap?: unknown } | undefined;
    const urlset = parsed.urlset as { url?: unknown } | undefined;

    if (index !== undefined) {
      read.filesRead.push(next.url);
      if (next.depth >= MAX_DEPTH) continue;
      const children = index && typeof index === "object" ? index.sitemap : undefined;
      for (const child of toList(children as unknown[])) {
        const loc = child && typeof child === "object" ? textOf((child as Record<string, unknown>).loc) : null;
        if (loc) queue.push({ url: loc, depth: next.depth + 1 });
      }
    } else if (urlset !== undefined) {
      read.filesRead.push(next.url);
      for (const entry of toList((urlset && typeof urlset === "object" ? urlset.url : undefined) as unknown[])) {
        if (read.entries.length >= maxUrls) {
          read.truncated = true;
          break;
        }
        if (!entry || typeof entry !== "object") continue;
        const record = entry as Record<string, unknown>;
        const loc = textOf(record.loc);
        if (!loc || seenUrls.has(loc)) continue;
        seenUrls.add(loc);
        read.entries.push({ loc, lastmod: textOf(record.lastmod), sitemap: next.url, fetchedAt: fetched.at });
      }
    } else {
      read.failed.push({
        url: next.url,
        reason: "it answered, but not with a sitemap or a sitemap index",
        kind: "not-a-sitemap",
      });
    }
  }

  return read;
}

type FetchedFile =
  | { ok: true; xml: string; at: number }
  | { ok: false; reason: string; kind: SitemapFailureKind };

/** The two bytes every gzip stream opens with. No XML document can. */
function isGzip(bytes: Uint8Array): boolean {
  return bytes.length >= 2 && bytes[0] === 0x1f && bytes[1] === 0x8b;
}

async function fetchSitemapFile(url: string): Promise<FetchedFile> {
  let at: number;
  let bytes: Uint8Array;
  let declaredGzip: boolean;
  try {
    at = Date.now();
    const { response } = await fetchAnyStatus(url, { timeout: REQUEST_TIMEOUT });
    if (!response.ok) {
      // The classification `well-known.ts` borrows for every fixed-path file: a
      // 404 or 410 says there is no file, anything else says we did not find out.
      return {
        ok: false,
        reason: `it answered HTTP ${response.status}`,
        kind: classifyRobotsStatus(response.status) === "absent" ? "absent" : "unavailable",
      };
    }
    const contentType = response.headers.get("content-type") ?? "";
    declaredGzip = url.endsWith(".gz") || /(?:^|\/)(?:x-)?gzip\b/.test(contentType);
    bytes = new Uint8Array(await response.arrayBuffer());
  } catch (error) {
    // Our own pace, not the site's failure: the authored sentence says when to
    // come back, and it is the whole answer.
    if (error instanceof CrawlBudgetError) throw error;
    if (error instanceof RobotsDisallowedError) {
      return {
        ok: false,
        reason: ROBOTS_REFUSAL,
        kind: "unavailable",
      };
    }
    // Not the error's message: that is a driver string or a remote server's text,
    // and this sentence reaches the Tool's output.
    logError(`read the sitemap at ${url}`, error);
    return {
      ok: false,
      reason: "it could not be fetched (timeout, DNS or connection failure)",
      kind: "unavailable",
    };
  }

  // Declared gzip is inflated only when the bytes are gzip. A `.gz` served with
  // `Content-Encoding: gzip` arrives already inflated — `fetch` undoes the
  // encoding — and inflating it a second time failed a readable sitemap as
  // "could not be fetched".
  if (declaredGzip && isGzip(bytes)) {
    try {
      bytes = gunzipSync(bytes);
    } catch {
      return { ok: false, reason: "it is not a valid gzip file", kind: "not-a-sitemap" };
    }
  }
  // `TextDecoder` rather than `Buffer#toString`, for the byte-order mark: it
  // drops one, as `Response#text()` does, and the XML parser does not expect it.
  return { ok: true, xml: new TextDecoder().decode(bytes), at };
}

/**
 * Whether one page is among the entries this read saw, by {@link urlKey}.
 *
 * The identity is `url-match.ts`'s and nobody else's: a sitemap listing
 * `http://www.example.com/a/` names the page `https://example.com/a`. This
 * answers only about what was read; whether "not listed" means anything is
 * {@link listingFor}'s question.
 */
export function entryFor(
  read: SitemapRead,
  pageUrl: string,
): { listed: false } | { listed: true; lastmod: string | null } {
  const target = urlKey(pageUrl);
  if (target === null) return { listed: false };
  const entry = read.entries.find((candidate) => urlKey(candidate.loc) === target);
  return entry ? { listed: true, lastmod: entry.lastmod } : { listed: false };
}

/**
 * What a Site's sitemaps say about one page, already interpreted.
 *
 * Four answers, because a check that reads them has four different things to
 * say. `unread` is the third state: there is a sitemap we did not get to open,
 * so the page's absence from the rest is not evidence.
 */
export type SitemapListing =
  | { outcome: "listed"; lastmod: string | null }
  | { outcome: "not-listed" }
  | { outcome: "no-sitemap" }
  | { outcome: "unread"; reason: string };

/**
 * What these sitemaps say about `pageUrl`.
 *
 * The evidence is asymmetric, the same way `site-trust-pages` is built: a page
 * found in a file we read is listed, and nothing in a file we did not read can
 * unfind it. A page *not* found is only "not listed" when every sitemap the
 * site points at was read; a file that did not answer, or a cap that stopped
 * the read, makes it `unread` instead. A 404 child is not one of those — it is
 * an answer, and it says the page is not in that one.
 */
export function listingFor(read: SitemapRead, pageUrl: string): SitemapListing {
  const entry = entryFor(read, pageUrl);
  if (entry.listed) return { outcome: "listed", lastmod: entry.lastmod };

  if (read.truncated) {
    return {
      outcome: "unread",
      reason:
        `the sitemaps list more than this read opens (${read.limits.maxFiles} files, ` +
        `${read.limits.maxUrls} URLs), so not all of them were searched`,
    };
  }

  const unread = read.failed.filter((failure) => failure.kind === "unavailable");
  if (unread.length > 0) {
    const tried = read.filesRead.length + read.failed.length;
    return {
      outcome: "unread",
      reason:
        unread.length === 1 && tried === 1
          ? `${unread[0].url} could not be read: ${unread[0].reason}`
          : `${unread.length} of the ${tried} sitemap files could not be read`,
    };
  }

  // Nothing unread, nothing read: every file the site points at is missing or
  // is not a sitemap. That is a finding, and a different one from "not listed".
  if (read.filesRead.length === 0) return { outcome: "no-sitemap" };
  return { outcome: "not-listed" };
}

/**
 * What every Tool built on a sitemap read owes its reader: where the sitemaps
 * came from and how much of them was read, as a part of the basis section, and
 * the files that could not be read, for its `NOT CHECKED` section.
 *
 * Two outputs because they are two sections. A file that did not answer is a
 * thing the Tool set out to check and could not; the count of files that did is
 * what the answer rests on.
 */
export function describeSitemapRead(read: SitemapRead): { read: string[]; notChecked: NotChecked[] } {
  const lines: string[] = [];
  const sources = [...new Set(read.roots.map((root) => root.source))];
  const from: Record<SitemapSource, string> = {
    argument: "the sitemap named in the request",
    "search-console": "the sitemaps submitted in Search Console",
    "robots.txt": "the Sitemap: lines in robots.txt (none submitted in Search Console)",
    convention: "/sitemap.xml by convention (none submitted in Search Console or named in robots.txt)",
  };
  lines.push(`Sitemaps: ${sources.map((source) => from[source]).join("; ")}`);
  lines.push(
    `Sitemap files read: ${read.filesRead.length}, URLs listed: ${read.entries.length}` +
      (read.truncated
        ? ` — stopped at our cap of ${read.limits.maxFiles} files or ${read.limits.maxUrls} URLs, so the sitemaps list more than this read saw`
        : ""),
  );
  return {
    read: lines,
    notChecked: read.failed.map((failure) => ({ subject: failure.url, reason: failure.reason })),
  };
}
