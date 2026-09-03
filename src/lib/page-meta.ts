/**
 * Reading one page's `<title>` and `<meta name="description">`, for the pages a
 * generated `llms.txt` is about to declare.
 *
 * **Why this exists as a module.** `llms-txt-tools` already read the homepage's
 * title and description inline, and the generator then labelled every *other*
 * link from its URL slug — so `/docs/getting-started` became "Getting Started"
 * and its description became the string `"Getting Started page"`. That is filler
 * standing where the llms.txt spec asks for a description, and it is the one
 * thing a generated file cannot fake convincingly: a reader can see that every
 * line says the same thing twice.
 *
 * The fix is to read what the site already published. Every line of the
 * generated file then traces to a `<title>` or a `<meta description>` the owner
 * wrote themselves, which is a claim we can make in the interface and defend.
 *
 * **This performs network I/O and is deliberately bounded**, because it runs on
 * a public, unauthenticated surface:
 *
 * - Every fetch goes through {@link fetchAnyStatus}, so the SSRF guard applies to a
 *   URL a stranger supplied.
 * - The robots and pacing guards run per hop inside it, so a site that asks us not to read a
 *   path is not read. A refusal is not an error here — it yields no metadata and
 *   the caller falls back to the slug, which is what the generator did for every
 *   page before this module existed.
 * - Concurrency is capped and each request has its own timeout, so one slow host
 *   cannot hold the whole run open.
 * - Only the first {@link META_READ_LIMIT} bytes of the body are parsed. `<head>`
 *   is at the top of the document and a 4 MB page has nothing further to tell us.
 */

import { fetchAnyStatus } from "./http-client";

/** One page, and whatever of its own metadata we could read. Both fields are
 *  optional because a page that answers without a title is a normal outcome, not
 *  a failure — the generator falls back to the URL slug for the label. */
export interface PageMeta {
  url: string;
  title?: string;
  description?: string;
}

/** How many pages one generation run may read. Chosen rather than inherited:
 *  a generated `llms.txt` lists at most a handful of links per section, so
 *  reading far more than it can print buys the visitor nothing and spends
 *  someone else's bandwidth. */
export const PAGE_META_LIMIT = 25;

/** How many of those run at once. Low enough to be a polite visitor to a small
 *  site, high enough that 25 pages do not take 25 round trips end to end. */
const PAGE_META_CONCURRENCY = 6;

/** Bytes of each response body parsed for `<head>`. */
const META_READ_LIMIT = 60_000;

const PER_PAGE_TIMEOUT_MS = 8_000;

/**
 * Pull the title and meta description out of an HTML string.
 *
 * Regex rather than a parser on purpose: this reads two well-known tags from the
 * head of a document we do not otherwise care about, and the project's real
 * parser (`parsed-page`) is built for analysis over a page we own the context
 * for. Both orderings of the `name`/`content` attribute pair are matched because
 * hand-written and framework-emitted heads differ, and `og:` is accepted as a
 * fallback for the description because a page with an Open Graph description and
 * no meta description is common and the text is written for the same job.
 *
 * Exported for the tests, and because the public route parses bodies it fetched
 * through its own budget rather than re-fetching here.
 */
export function extractPageMeta(html: string): { title?: string; description?: string } {
  const head = html.slice(0, META_READ_LIMIT);

  const titleMatch = head.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  const title = titleMatch ? collapse(decodeEntities(titleMatch[1])) : "";

  const descMatch =
    head.match(/<meta[^>]+name=["']description["'][^>]*content=["']([^"']*)["']/i) ??
    head.match(/<meta[^>]+content=["']([^"']*)["'][^>]*name=["']description["']/i) ??
    head.match(/<meta[^>]+property=["']og:description["'][^>]*content=["']([^"']*)["']/i) ??
    head.match(/<meta[^>]+content=["']([^"']*)["'][^>]*property=["']og:description["']/i);
  const description = descMatch ? collapse(decodeEntities(descMatch[1])) : "";

  return {
    ...(title ? { title } : {}),
    ...(description ? { description } : {}),
  };
}

/**
 * Read one page's metadata. **Never throws.** Every failure — SSRF refusal,
 * robots refusal, timeout, 404, 5xx — returns the URL with no metadata, because
 * the caller's fallback (the URL slug) is the same in all of those cases and a
 * generated file should not fail because one of twenty-five pages was slow.
 */
async function fetchPageMeta(url: string): Promise<PageMeta> {
  try {
    const { response } = await fetchAnyStatus(url, { timeout: PER_PAGE_TIMEOUT_MS });
    if (!response.ok) return { url };

    const contentType = response.headers.get("content-type") ?? "";
    if (contentType && !/text\/html|application\/xhtml/i.test(contentType)) return { url };

    return { url, ...extractPageMeta(await response.text()) };
  } catch {
    return { url };
  }
}

/**
 * Read metadata for many pages, capped and batched.
 *
 * Order is preserved, so the generator's section ordering stays the sitemap's
 * ordering rather than a race result — two runs against an unchanged site
 * produce the same file, which matters because the visitor is going to paste it
 * and may re-run to check their edit.
 */
export async function fetchPagesMeta(
  urls: readonly string[],
  limit: number = PAGE_META_LIMIT,
): Promise<PageMeta[]> {
  const capped = urls.slice(0, limit);
  const out: PageMeta[] = [];

  for (let i = 0; i < capped.length; i += PAGE_META_CONCURRENCY) {
    const batch = capped.slice(i, i + PAGE_META_CONCURRENCY);
    out.push(...(await Promise.all(batch.map(fetchPageMeta))));
  }

  return out;
}

// ── helpers ──────────────────────────────────────────────────────────────────

/** Newlines and runs of whitespace inside a `<title>` are layout, not content. */
function collapse(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

/** The five entities that actually appear in titles and descriptions. A full
 *  entity table is not worth carrying for two tags. */
function decodeEntities(value: string): string {
  return value
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;|&apos;/g, "'");
}
