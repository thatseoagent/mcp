/**
 * Sitemap XML parser with support for sitemap indexes and gzipped sitemaps.
 * Recursively fetches and parses sitemaps up to a maximum depth.
 *
 * The per-step progress traces this carried did not travel. They were written for
 * a serverless log where one request's lines were retrievable on their own; here
 * they are one Operator's terminal, and a sitemap index of forty children would
 * bury the server's actual output. The failure path still logs, through
 * `log.ts` like everything else.
 */

import { XMLParser } from 'fast-xml-parser';
import { logError } from './log';
import { gunzipSync } from 'node:zlib';
import { fetchAnyStatus } from './http-client';

interface SitemapUrl {
  loc: string;
  lastmod?: string;
  changefreq?: string;
  priority?: number;
}

interface SitemapIndex {
  /**
   * Optional, because an empty index is a valid document.
   *
   * `<sitemapindex xmlns="…"></sitemapindex>` parses to an object holding only
   * the namespace attribute, so this key is missing rather than empty — and
   * wrapping a missing key in an array gave `[undefined]`, one `.loc` away from
   * a TypeError. See {@link parseSitemapIndex}.
   */
  sitemap?: Array<{ loc: string }> | { loc: string };
}

interface Urlset {
  /** Optional for the same reason. A site with no URLs yet publishes this. */
  url?: SitemapUrl[] | SitemapUrl;
}

const MAX_DEPTH = 3;
const REQUEST_TIMEOUT = 10_000; // 10 seconds

/**
 * One child, many children, or none, as a list.
 *
 * `fast-xml-parser` gives a lone `<url>` as an object and two as an array, which
 * is why every caller wrapped a non-array in `[value]`. It also gives *no*
 * children as `undefined` — an empty `<urlset xmlns="…">` parses to an object
 * holding only the namespace — and `[undefined]` then reached a `.loc`. An empty
 * sitemap is a valid sitemap, and it read as a crash.
 */
function toList<T>(value: T[] | T | undefined): T[] {
  if (value === undefined || value === null) return [];
  return Array.isArray(value) ? value : [value];
}

class SitemapParser {
  private readonly parser: XMLParser;
  private readonly seenUrls = new Set<string>();

  constructor() {
    this.parser = new XMLParser({
      ignoreAttributes: false,
      attributeNamePrefix: '@_',
    });
  }

  /**
   * Parse a sitemap URL and extract all URLs.
   * Handles sitemap indexes recursively up to MAX_DEPTH.
   */
  async parse(sitemapUrl: string, maxUrls?: number): Promise<string[]> {
    this.seenUrls.clear();

    const urls = await this.parseRecursive(sitemapUrl, 0, maxUrls);
    const uniqueUrls = Array.from(new Set(urls));
    return uniqueUrls;
  }

  private async parseRecursive(
    url: string,
    depth: number,
    maxUrls?: number
  ): Promise<string[]> {
    if (depth > MAX_DEPTH) {
      return [];
    }

    if (maxUrls && this.seenUrls.size >= maxUrls) {
      return [];
    }

    try {
      const xml = await this.fetchSitemap(url);
      const parsed = this.parser.parse(xml);

      // Check if it's a sitemap index
      if (parsed.sitemapindex) {
        return this.parseSitemapIndex(parsed.sitemapindex, depth, maxUrls);
      }

      // Regular sitemap with URLs
      if (parsed.urlset) {
        return this.parseUrlset(parsed.urlset, maxUrls);
      }
      return [];
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      logError(`parse the sitemap at ${url}`, error);
      throw new Error(`Failed to parse sitemap ${url}: ${msg}`);
    }
  }

  private async parseSitemapIndex(
    index: SitemapIndex,
    depth: number,
    maxUrls?: number
  ): Promise<string[]> {
    const sitemaps = toList(index.sitemap);

    const allUrls: string[] = [];

    for (const sitemap of sitemaps) {
      if (maxUrls && this.seenUrls.size >= maxUrls) {
        break;
      }
      if (typeof sitemap?.loc !== "string") continue;

      // One child at a time, and a child that cannot be read loses only itself.
      // `parseRecursive` throws, so a single 404 among forty children used to
      // fail the whole index — and the one caller turns a throw into `[]`, so a
      // site whose fortieth sitemap had moved got an llms.txt built from none of
      // the other thirty-nine. Google skips a bad child and reads the rest.
      try {
        allUrls.push(...(await this.parseRecursive(sitemap.loc, depth + 1, maxUrls)));
      } catch (error) {
        logError(`read the child sitemap at ${sitemap.loc}`, error);
      }
    }

    return allUrls;
  }

  private parseUrlset(urlset: Urlset, maxUrls?: number): string[] {
    const urls = toList(urlset.url);

    const extracted: string[] = [];

    for (const entry of urls) {
      if (maxUrls && this.seenUrls.size >= maxUrls) {
        break;
      }

      const url = typeof entry?.loc === "string" ? entry.loc : null;
      if (url && !this.seenUrls.has(url)) {
        this.seenUrls.add(url);
        extracted.push(url);
      }
    }

    return extracted;
  }

  private async fetchSitemap(url: string): Promise<string> {
    // Google will not read a sitemap its crawler is disallowed from, and neither
    // will we — the guards ride inside the fetcher, which also owns the timeout
    // that the hand-rolled `AbortController` and its `finally` used to.
    const { response } = await fetchAnyStatus(url, { timeout: REQUEST_TIMEOUT });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status} ${response.statusText}`);
    }

    const contentType = response.headers.get('content-type') || '';
    const isGzipped =
      url.endsWith('.gz') ||
      contentType.includes('gzip') ||
      contentType.includes('x-gzip');

    if (isGzipped) {
      const buffer = await response.arrayBuffer();
      const decompressed = gunzipSync(Buffer.from(buffer));
      return decompressed.toString('utf-8');
    }

    return await response.text();
  }
}

/**
 * Parse a sitemap URL and return all URLs found.
 * Convenience function that creates a new parser instance.
 */
export async function parseSitemap(sitemapUrl: string, maxUrls?: number): Promise<string[]> {
  const parser = new SitemapParser();
  return parser.parse(sitemapUrl, maxUrls);
}
