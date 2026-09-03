/**
 * The single identity every outbound request to a third-party site presents.
 *
 * The product token stays `ThatSEOAgentBot` even though the product it was named
 * for is being retired, and that is deliberate: site owners who already wrote
 * `User-agent: ThatSEOAgentBot` into their robots.txt did so to keep us out.
 * Renaming the token would silently un-block every one of them. robots.txt tokens
 * match on a prefix of the product token, so one rule keeps binding both variants
 * below.
 *
 * The documentation URL *did* have to change: it pointed at a page on the site
 * that is shutting down, and a user agent whose URL 404s tells a webmaster
 * reading their logs nothing.
 *
 * Web Bot Auth request signing is not carried here. It arrives with the crawl
 * Tools, which are the ones that fetch a site at volume; a single robots.txt read
 * does not need it.
 */

/** Where a webmaster who sees us in their logs should land. */
export const BOT_DOCS_URL = "https://github.com/thatseoagent/mcp";

/** BFS crawls of a whole site. */
export const CRAWLER_USER_AGENT = `ThatSEOAgentBot/1.0 (+${BOT_DOCS_URL})`;

/** Single-URL fetches: page audits, on-page checks, every analyzer. */
export const PAGE_AUDIT_USER_AGENT = `ThatSEOAgentBot/1.0 (page-audit; +${BOT_DOCS_URL})`;
