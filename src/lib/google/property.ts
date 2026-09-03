/**
 * Turning what an Operator typed into the property identifier Google wants.
 *
 * ── The two shapes, and why neither wins ──
 *
 * A **Domain Property** is `sc-domain:example.com` and covers every subdomain
 * and both schemes. A **URL-Prefix Property** is `https://example.com/` and
 * covers exactly what its prefix says. Google gives an Operator whichever they
 * set up, and plenty of Operators have both for one site.
 *
 * An agent, meanwhile, will pass `example.com`, because that is what a person
 * said to it. So a bare domain is matched against the properties the account
 * actually holds, preferring the Domain Property when both exist — it is the
 * broader of the two, and an Operator who wanted the narrower one can name it.
 *
 * ── The fallback, and its one honest use ──
 *
 * Holding a property is not the same as being able to read it. An Operator can
 * have `https://example.com/` verified and `sc-domain:example.com` not, or the
 * reverse, and Search Console answers 403 for the one they cannot read. When the
 * *other* shape of the same site is available, retrying with it turns a refusal
 * into the report the Operator asked for.
 *
 * This is a fallback between two spellings of one Site, and deliberately not a
 * fallback to a smaller answer: ADR-0003 forbids degrading, and nothing here
 * returns less than was asked for. If both shapes refuse, the refusal stands.
 */
import { getDomain } from "tldts";
import { InvalidInputError } from "../invalid-input-error";
import { UpstreamApiError } from "../upstream-api-error";
import type { GscProperty, SearchConsoleReader } from "./reader";

/**
 * Is this already a property identifier?
 *
 * A bare domain like `example.com` is not: it is what a person says, and Google
 * has never heard of it.
 */
export function isFormattedSiteUrl(input: string): boolean {
  return input.startsWith("sc-domain:") || /^https?:\/\//.test(input);
}

/** The registrable domain of either property shape, for comparison. */
function domainOfProperty(siteUrl: string): string | null {
  if (siteUrl.startsWith("sc-domain:")) return getDomain(siteUrl.slice("sc-domain:".length));
  return getDomain(siteUrl);
}

/**
 * The property matching a bare domain, or `null`.
 *
 * Pure, so the matching rule can be tested without a reader. The Domain Property
 * is preferred when both exist.
 */
export function matchSiteUrl(input: string, properties: readonly GscProperty[]): string | null {
  if (isFormattedSiteUrl(input)) return input;

  const wanted = getDomain(input);
  if (!wanted) return null;

  const candidates = properties.filter((property) => domainOfProperty(property.siteUrl) === wanted);
  if (candidates.length === 0) return null;

  const domainProperty = candidates.find((property) => property.siteUrl.startsWith("sc-domain:"));
  return (domainProperty ?? candidates[0]).siteUrl;
}

/**
 * No property matches what the Operator named.
 *
 * The message lists what they *do* have and names the Tools that still work,
 * because the common cause is not a typo: it is a site the Operator does not
 * hold in Search Console at all, and the useful next step is the
 * credential-free surface rather than a retry.
 *
 * An {@link InvalidInputError} because the caller supplied the value and the
 * caller is who can fix it on the next call — which also makes the message safe
 * to publish through the Tool failure seam.
 */
export function siteResolutionError(input: string, available: readonly string[]): InvalidInputError {
  const list = available.length > 0 ? available.join(", ") : "(none)";
  return new InvalidInputError(
    `No Search Console property found for "${input}". Properties this Google account can read: ${list}. ` +
      `Google only exposes properties the account has access to, so the gsc_* Tools cannot run for this site. ` +
      `You can still audit "${input}" with no Google access at all: seo_analyze_page, seo_crawlability_audit, ` +
      `seo_schema_detection, seo_eeat_score, seo_geo_score, seo_security_headers, seo_llms_txt and crawl_site. ` +
      `If you do own this site, pass one of the identifiers above exactly as printed.`,
  );
}

/**
 * The property identifier to use for what the Operator named.
 *
 * An already-formatted identifier is returned untouched and costs no API call —
 * an agent that pasted one from `gsc_list_properties` should not pay for a
 * lookup.
 */
export async function resolveSiteUrl(
  reader: SearchConsoleReader,
  input: string,
): Promise<string> {
  if (isFormattedSiteUrl(input)) return input;

  const properties = await reader.listProperties();
  const matched = matchSiteUrl(input, properties);
  if (matched) return matched;

  throw siteResolutionError(
    input,
    properties.map((property) => property.siteUrl),
  );
}

/** The other spelling of the same Site, or `null` when there is none. */
export function alternateProperty(siteUrl: string): string | null {
  if (siteUrl.startsWith("sc-domain:")) {
    return `https://${siteUrl.slice("sc-domain:".length)}/`;
  }
  const domain = domainOfProperty(siteUrl);
  return domain ? `sc-domain:${domain}` : null;
}

/**
 * Run a Search Console read against the property the Operator named, retrying
 * once with the other shape of the same Site if Google refuses this one.
 *
 * The retry is only attempted on a refusal — 403 — and never on a 429, a 5xx or
 * a timeout. Retrying those would spend a second request against a quota that is
 * already exhausted, or ask a struggling API the same question twice, and in
 * neither case is the property the problem.
 *
 * If the alternate also refuses, the **original** error is what surfaces. The
 * Operator asked about the property they named, and a message about a property
 * they never mentioned would send them looking in the wrong place.
 */
export async function withPropertyFallback<T>(
  reader: SearchConsoleReader,
  input: string,
  read: (siteUrl: string) => Promise<T>,
): Promise<{ result: T; siteUrl: string }> {
  const siteUrl = await resolveSiteUrl(reader, input);

  try {
    return { result: await read(siteUrl), siteUrl };
  } catch (error) {
    const refused = error instanceof UpstreamApiError && (error.status === 403 || error.status === 401);
    const alternate = refused ? alternateProperty(siteUrl) : null;
    if (!alternate) throw error;

    try {
      return { result: await read(alternate), siteUrl: alternate };
    } catch {
      throw error;
    }
  }
}
