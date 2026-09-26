/**
 * When a URL from Search Console, a URL the crawler reached, a URL in a sitemap
 * and a GA4 landing path are the same page — and, under that, when two hosts are
 * the same host.
 *
 * ── Why this exists ──
 *
 * The `site_*` Tools cross three lists of URLs that were never written to agree.
 * Search Console reports the URL Google shows, exactly as it indexed it:
 * `https://www.example.com/pricing/`. The crawler reports the URL it fetched,
 * resolved against whatever `href` the page carried: `https://example.com/pricing`.
 * A sitemap says whatever the CMS that generated it says. GA4 says `/pricing`,
 * with no host at all. Compared as strings, those are four pages, and every one
 * of them is then "missing" from the other lists — which is an orphan report made
 * entirely of false findings.
 *
 * Each of those comparisons used to carry its own normaliser: the crawler, two
 * analyzers, the GSC↔GA4 join, the property helpers and a dozen Tools that each
 * lowercased a host and cut its `www.`. They agreed mostly, and "mostly" is where
 * a page is joined in one Tool and orphaned in the next. So the rules live here,
 * once, and a comparison that needs a stricter or looser rule asks for it by
 * name — {@link UrlKeyOptions} — rather than writing a second one.
 *
 * ── What is treated as the same, and why each ──
 *
 * - **The scheme.** `http://` and `https://` of one path are one page on any site
 *   that redirects between them, which is every site worth auditing. A site that
 *   serves different content on each is not one this comparison can help.
 * - **Case in the host, a leading `www.` and a trailing dot.** Hosts are
 *   case-insensitive by definition, and `example.com.` is the same name in DNS.
 *   `www.` is a choice: a site serves one of the two and redirects the other, and
 *   a crawl seeded at the bare domain lands on `www` while Search Console reports
 *   whichever Google indexed. Keeping them apart would make the whole site "not
 *   reached" on a domain property. The cost is that a site serving genuinely
 *   different pages on `www` and the bare host is read as one.
 * - **The default port.** `URL` drops it already; stated so nobody re-adds it.
 * - **A trailing slash.** `/pricing` and `/pricing/` are one page on almost every
 *   server, and differ in the lists above for no reason but who wrote them. The
 *   root stays `/`.
 * - **The fragment.** It never reaches the server.
 *
 * ── What is deliberately kept ──
 *
 * **The query string.** Search Console reports `?page=2` as its own URL with its
 * own impressions, and merging it into the page without one would credit one URL
 * with another's traffic. The crawler is the one reader that drops it, for its own
 * de-duplication, and asks for that with `{ query: "drop" }`. Path case is kept
 * too: servers are case-sensitive about paths, and `/About` and `/about` can be
 * two pages.
 *
 * ── When the scheme and the host do count ──
 *
 * The leniency above is for matching one site's lists against each other. A
 * check that asks whether a page *declared* the right URL — a canonical in the
 * HTML against the one in the `Link` header, an hreflang return link — is asking
 * about the address as written, and `http://` against `https://` or `www.` against
 * the bare host is then the finding rather than noise. Those ask for
 * `{ origin: "exact" }`.
 *
 * Used only as a key. Every Tool prints the URL as its source wrote it, so a
 * reader is never shown an address nobody published.
 */
import { getDomain } from "tldts";
import { InvalidInputError } from "./invalid-input-error";

const DOMAIN_PROPERTY = "sc-domain:";

/**
 * A host as two lists compare hosts: lowercase, without a leading `www.` or a
 * trailing dot. `null` when there is nothing host-like in the input.
 *
 * Takes whatever names a host — `Example.com`, `www.example.com/pricing`,
 * `https://example.com:8443/`, `sc-domain:example.com` — because the callers get
 * all four: an Operator's argument, a URL out of a report, a GA4 stream's
 * default URL, a Search Console property.
 */
export function hostKey(input: string): string | null {
  const trimmed = input.trim();
  const named = propertyDomain(trimmed) ?? trimmed;
  if (named.length === 0) return null;

  let hostname: string;
  try {
    hostname = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(named) ? named : `https://${named}`).hostname;
  } catch {
    return null;
  }
  return foldHost(hostname) || null;
}

/** The part of {@link hostKey} that {@link urlKey} needs, on a hostname `URL` already parsed. */
function foldHost(hostname: string): string {
  return hostname.toLowerCase().replace(/^www\./, "").replace(/\.$/, "");
}

export interface UrlKeyOptions {
  /**
   * `"keep"`, the default, for the reason in the header. `"drop"` for a reader
   * that has decided `?page=2` is not worth a second visit.
   */
  query?: "keep" | "drop";
  /**
   * `"site"`, the default: scheme, `www.` and a trailing dot on the host are
   * ignored. `"exact"`: they are part of the key, for the checks the header names.
   */
  origin?: "site" | "exact";
}

/**
 * The key two URLs share when they are the same page, or `null` for anything
 * that is not an `http(s)` URL.
 *
 * @param base resolves a relative URL, the way a page's `href` is resolved.
 */
export function urlKey(url: string, base?: string, options: UrlKeyOptions = {}): string | null {
  let parsed: URL;
  try {
    parsed = new URL(url.trim(), base);
  } catch {
    return null;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;

  const host =
    options.origin === "exact" ? `${parsed.protocol}//${parsed.hostname}` : foldHost(parsed.hostname);
  const port = parsed.port ? `:${parsed.port}` : "";
  const path = parsed.pathname.replace(/\/+$/, "") || "/";
  // `URL` keeps a bare `?` as an empty search, so `/a?` and `/a` already agree.
  const query = options.query === "drop" ? "" : parsed.search;
  return `${host}${port}${path}${query}`;
}

/** Two URLs are the same page. Unparseable URLs are the same page as nothing. */
export function sameUrl(a: string, b: string, options?: UrlKeyOptions): boolean {
  const left = urlKey(a, undefined, options);
  return left !== null && left === urlKey(b, undefined, options);
}

/**
 * The part of a URL or a path that Search Console and GA4 agree on, or `null`
 * when there is none.
 *
 * Looser than {@link urlKey} because GA4 is: its `landingPage` is a path with no
 * host and no query, so the host and the query cannot be part of a key that must
 * meet it. The ambiguity that costs — one path on two hosts of a Domain Property
 * — is `page-join.ts`'s to refuse, not this key's to hide.
 *
 * Decoded, so `/caf%C3%A9` and `/café` meet: the two APIs spell non-ASCII paths
 * differently.
 *
 * `null` for GA4's `(not set)`, its empty landing page and anything else that is
 * not a path: GA4 writes those when a session had no page view to land on, and
 * there is no page to join. {@link landingUrl} applies the same rule.
 */
export function pathKey(urlOrPath: string): string | null {
  const trimmed = urlOrPath.trim();
  let path: string;

  if (/^https?:\/\//i.test(trimmed)) {
    try {
      path = new URL(trimmed).pathname;
    } catch {
      return null;
    }
  } else if (trimmed.startsWith("/")) {
    path = trimmed.split(/[?#]/)[0];
  } else {
    return null;
  }

  // A malformed escape is left as it came rather than failing the page: it is
  // still the same string on both sides.
  try {
    path = decodeURI(path);
  } catch {
    // keep as is
  }

  if (path.length > 1) path = path.replace(/\/+$/, "");
  return path.length === 0 ? "/" : path;
}

/**
 * A GA4 landing page as a URL on the site, or `null` when GA4 named no page.
 *
 * GA4 writes `(not set)`, or nothing, for a session it could not attribute a
 * landing page to. That is an unattributed session, not a visit to the home page:
 * reading it as `/` would credit the root with every session GA4 lost track of,
 * and on a site where that is common it becomes the busiest page. Every Tool that
 * turns a landing page into a page reads it through here or {@link pathKey}, so
 * none of them decides otherwise.
 *
 * Concatenated rather than resolved, so a path GA4 reports as `//x` stays on the
 * site instead of being read as another host.
 */
export function landingUrl(origin: string, landingPage: string): string | null {
  const path = landingPage.trim();
  if (!path.startsWith("/")) return null;
  try {
    return new URL(`${origin.replace(/\/+$/, "")}${path}`).href;
  } catch {
    return null;
  }
}

/**
 * The domain a Domain Property names, lowercased, or `null` for a URL-Prefix
 * Property.
 *
 * Kept as named, `www.` included: `sc-domain:www.example.com` is a real, narrower
 * property than `sc-domain:example.com`, and {@link inProperty} must not widen it.
 * {@link hostKey} is what to ask for when comparing hosts instead.
 */
export function propertyDomain(property: string): string | null {
  if (!property.startsWith(DOMAIN_PROPERTY)) return null;
  const domain = property.slice(DOMAIN_PROPERTY.length).trim().toLowerCase();
  return domain.length > 0 ? domain : null;
}

/**
 * Where to start reading a Site, for a Search Console property.
 *
 * A Domain Property names no scheme and no host prefix, so its root is taken as
 * `https://` on the bare domain — which the site will redirect wherever it lives,
 * and the fetcher follows. A URL-Prefix Property names its own root, and that is
 * the one used: the property covers exactly that prefix and nothing above it.
 */
export function propertyRoot(property: string): string {
  const domain = propertyDomain(property);
  return domain === null ? property : `https://${domain}/`;
}

/**
 * Is this URL inside the property?
 *
 * Asked before a URL Inspection, because Google refuses to inspect a URL under a
 * property that does not cover it — and a sitemap can list anything, including
 * another host's pages.
 *
 * A Domain Property covers its domain and every subdomain, over either scheme.
 * A URL-Prefix Property covers exactly its prefix, scheme included: that is what
 * Google means by one, so the leniency of {@link urlKey} is not applied here.
 */
export function inProperty(url: string, property: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }

  const domain = propertyDomain(property);
  if (domain !== null) {
    const host = parsed.hostname.toLowerCase();
    return host === domain || host.endsWith(`.${domain}`);
  }

  return parsed.href.startsWith(property);
}

/**
 * The domain, as a Site is stored under it.
 *
 * {@link hostKey}, refused with a sentence when it is not a registrable domain.
 * A person says `https://example.com/pricing`, `www.example.com` and
 * `example.com` meaning one thing, so all three land on one row. Anything else in
 * the hostname stays, because `blog.example.com` genuinely is a different Site
 * from `example.com` and the Operator may want both.
 */
export function normaliseDomain(input: string): string {
  if (input.trim().length === 0) throw new InvalidInputError("A domain is required.");

  const host = hostKey(input);
  if (host === null) throw new InvalidInputError(`"${input}" is not a domain this server can read.`);
  if (!getDomain(host)) {
    throw new InvalidInputError(
      `"${input}" is not a registrable domain. Pass something like example.com.`,
    );
  }
  return host;
}

/**
 * The origin to fetch a Site's pages from, out of whatever the Operator typed.
 *
 * For the Tools that cross a GA4 property with the site it measures. GA4 reports
 * landing pages as paths and the Admin API does not say which host a property
 * measures (`ga4-tool-shape.ts` explains why a display name cannot stand in for
 * one), so the host is an argument, and this turns `example.com`,
 * `www.example.com/pricing` or `https://example.com` into the one origin those
 * paths are read against, through {@link landingUrl}.
 *
 * The host is kept as typed, `www.` included, unlike {@link normaliseDomain}:
 * this is where requests go, not how a Site is keyed, and dropping the `www.`
 * would add a redirect to every fetch on a site that serves from it.
 * `normaliseDomain` is still asked, because it is what refuses something that is
 * not a registrable domain with a sentence naming the argument.
 */
export function siteOrigin(input: string): string {
  normaliseDomain(input);

  const trimmed = input.trim();
  const withScheme = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
  try {
    return new URL(withScheme).origin;
  } catch {
    throw new InvalidInputError(`"${input}" is not a domain this server can read.`);
  }
}
