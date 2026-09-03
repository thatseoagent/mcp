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
import { gunzipSync } from 'zlib';
import { fetchAnyStatus } from './http-client';
import { PAGE_AUDIT_USER_AGENT } from './bot-identity';

interface SitemapUrl {
  loc: string;
  lastmod?: string;
  changefreq?: string;
  priority?: number;
}

interface SitemapIndex {
  sitemap: Array<{ loc: string }> | { loc: string };
}

interface Urlset {
  url: SitemapUrl[] | SitemapUrl;
}

const MAX_DEPTH = 3;
const REQUEST_TIMEOUT = 10_000; // 10 seconds

export class SitemapParser {
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
    const sitemaps = Array.isArray(index.sitemap) ? index.sitemap : [index.sitemap];

    const allUrls: string[] = [];

    for (const sitemap of sitemaps) {
      if (maxUrls && this.seenUrls.size >= maxUrls) {
        break;
      }

      const urls = await this.parseRecursive(sitemap.loc, depth + 1, maxUrls);
      allUrls.push(...urls);
    }

    return allUrls;
  }

  private parseUrlset(urlset: Urlset, maxUrls?: number): string[] {
    const urls = Array.isArray(urlset.url) ? urlset.url : [urlset.url];

    const extracted: string[] = [];

    for (const entry of urls) {
      if (maxUrls && this.seenUrls.size >= maxUrls) {
        break;
      }

      const url = entry.loc;
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
