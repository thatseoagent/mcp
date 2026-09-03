/**
 * Fetching a URL the Operator named, safely.
 *
 * Every fetch here goes through the SSRF guard, which validates the URL and
 * re-validates every redirect hop. Nothing else in the codebase should call
 * `fetch` on an Operator-supplied URL directly.
 *
 * Two obligations ride on every outbound request: the site's robots.txt has to
 * allow it, and this server has to hold itself to a pace. Both used to live only
 * in the site crawler; they bind every fetch now, because a site owner writing
 * `Disallow` for our product token means all of them.
 *
 * They are stated once, in `clearToFetch`, and applied once, as `safeFetch`'s
 * per-hop hook — which is what makes "every outbound request" mean it. Above the
 * hop loop, one robots check and one pacing slot covered a chain of up to six
 * requests. And because the guards now travel *with* the fetcher rather than
 * beside it, {@link fetchAnyStatus} exists: there was no way to read a status
 * without throwing, so nine modules assembled the pair by hand and two of them
 * left the guards out.
 *
 * Web Bot Auth request signing is the one thing from the retired implementation
 * that is genuinely absent. It signed requests with a key registered to a domain
 * that is shutting down, and an Operator running their own instance has no such
 * key to sign with; identifying honestly in the user agent is what remains.
 */
import { PAGE_AUDIT_USER_AGENT } from "./bot-identity";
import { safeFetch, assertUrlAllowed } from "./ssrf-guard";
import { PageFetchError } from "./page-fetch-error";
import { InvalidInputError } from "./invalid-input-error";
import { createSingleFlightCache } from "./single-flight";
import { assertRobotsAllowed } from "./robots-gate";
import { paceRequestTo } from "./crawl-pacing";

const DEFAULT_TIMEOUT = 30_000;

/**
 * One request per URL per window, shared by every caller in it.
 *
 * Not a nicety: `seo_analyze_page`, `seo_content_analysis`, `seo_schema_detection`,
 * `seo_eeat_score` and `seo_geo_score` all read the same URL, and an agent asked to
 * "audit this page" calls several of them in one turn. Without this, each one is a
 * separate request to the Operator's — or their client's — site.
 *
 * It holds the in-flight promise rather than the resolved text, which is what makes
 * concurrent callers share instead of all missing before the first one writes.
 */
const htmlCache = createSingleFlightCache<string>();

/** The same, for the header-only reads {@link fetchHeaders} makes. */
const headersCache = createSingleFlightCache<{ headers: Headers; finalUrl: string }>();

/**
 * The HTML at a URL, fetched at most once per window.
 *
 * Every analyzer that reads a page goes through here rather than calling
 * {@link fetchWithTimeout} itself, so they share one request.
 */
export function fetchHtml(url: string): Promise<string> {
  return htmlCache.run(url, async () => {
    const response = await fetchWithTimeout(url);
    return response.text();
  });
}

/**
 * The two things owed to a third-party server before every request to it: obey
 * what its robots.txt says about us, and do not go faster than we said we would.
 *
 * One function rather than two calls at each site, so a fetch path cannot honour
 * one and forget the other. Order matters: a request robots.txt forbids should
 * never have spent a slot in the pacing budget, since it is never going to be
 * made.
 *
 * Both throw rather than returning a verdict — a refusal is the whole answer to
 * the caller's question, and both errors are written to be read out to whoever
 * asked.
 *
 * ── Private, and why that took a change ──
 *
 * This was exported, and its own docstring argued for "one function rather than
 * two calls at each site, so a fetch path cannot honour one and forget the
 * other". The argument was right and stopped one level too low: the pairing that
 * actually got forgotten was `clearToFetch`-with-`safeFetch`. Nine call sites
 * assembled it by hand because no fetcher here would hand back a response
 * without throwing on a non-2xx — and two of them, the Reachability Gate and the
 * well-known reads, omitted the guards entirely.
 *
 * {@link fetchAnyStatus} is the fetcher those nine wanted, so this is no longer
 * anybody's to call. It is handed to `safeFetch` as its per-hop hook, which is
 * also what puts a redirect chain inside the budget.
 */
async function clearToFetch(
  url: string,
  userAgent: string = PAGE_AUDIT_USER_AGENT,
): Promise<void> {
  await assertRobotsAllowed(url, userAgent);
  await paceRequestTo(url);
}

/**
 * The guards, as `safeFetch` takes them.
 *
 * Passed by every fetcher in this module and by nobody else, which is what makes
 * "the two obligations ride on every outbound request" structurally true rather
 * than a sentence in a comment. `robots-gate` fetches robots.txt through
 * `safeFetch` without this, which is the exemption its own docstring names.
 */
const GUARDED = { onHop: (url: string) => clearToFetch(url) };

/**
 * A fetch that hands back the response and its status instead of throwing.
 *
 * ── Why this exists ──
 *
 * Most callers here need to treat a 404, a 429 or a 503 as an *answer*: a
 * sitemap that is not there, an `hreflang` target that refuses, a page a
 * reachability gate is about to report on. {@link fetchWithTimeout} throws on
 * every non-2xx, so nine modules dropped to `safeFetch` and re-wrote the same
 * four lines — `clearToFetch`, then `safeFetch` with a timeout signal and our
 * User-Agent — with the ordering between them expressed nowhere in a type. Six
 * got it right, two skipped the guards, and one split them.
 *
 * The stated reason for the bypass had also been fixed underneath it:
 * `hreflang-analyzer` explained that `PageFetchError` "does not carry the
 * status", and `page-fetch-error.ts` declares `readonly status: number`.
 */
export async function fetchAnyStatus(
  url: string,
  options: {
    timeout?: number;
    method?: string;
    headers?: Record<string, string>;
    /**
     * The product token to identify as, and to ask robots.txt about.
     *
     * The site crawler declares a different one, and the token is what a site
     * owner writes a rule against — so asking about one and sending another
     * would honour a rule nobody wrote.
     */
    userAgent?: string;
  } = {},
): Promise<{ response: Response; finalUrl: string; redirectCount: number }> {
  const userAgent = options.userAgent ?? PAGE_AUDIT_USER_AGENT;
  return safeFetch(
    url,
    {
      method: options.method,
      signal: AbortSignal.timeout(options.timeout ?? DEFAULT_TIMEOUT),
      headers: { "User-Agent": userAgent, ...options.headers },
    },
    { onHop: (hop: string) => clearToFetch(hop, userAgent) },
  );
}

/**
 * Fetch a URL with a timeout. Throws {@link PageFetchError} on timeout or on any
 * non-2xx response, so a caller that wants to treat a 404 as an answer rather
 * than a failure has to say so — by calling {@link fetchAnyStatus}.
 */
export async function fetchWithTimeout(url: string, timeout = DEFAULT_TIMEOUT): Promise<Response> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeout);

  try {
    const { response } = await safeFetch(
      url,
      {
        signal: controller.signal,
        headers: { "User-Agent": PAGE_AUDIT_USER_AGENT },
      },
      GUARDED,
    );

    if (!response.ok) {
      // The explanation travels with the error: every Tool that gives up on a
      // page surfaces this string, and "HTTP 404 Not Found" leaves both the agent
      // and the Operator with nothing to act on. Typed, so the seam forwarding it
      // can tell it apart from a failure we did not write.
      throw PageFetchError.fromResponse(response.status);
    }

    return response;
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      throw PageFetchError.timeout(timeout);
    }
    throw error;
  } finally {
    clearTimeout(timeoutId);
  }
}

/**
 * The response headers at a URL, without its body.
 *
 * @param allowAnyStatus return the headers even when the status is not 2xx.
 *        Security headers are server configuration and come back with *any*
 *        response, so refusing to read them on a 404 declines to answer a
 *        question that is perfectly answerable. Only pass this where the
 *        headers, not the page, are the subject.
 *
 * `finalUrl` travels with the headers rather than being dropped: `safeFetch`
 * computes it while following redirects, and the security analyzer needs it. A
 * header ladder scored without knowing the scheme charged an `http://` site 20
 * of 94 points for not sending HSTS, which RFC 6797 §7.2 forbids it to send and
 * §8.1 requires browsers to ignore. The *requested* URL's scheme would not do: a
 * site on http:// that redirects to https:// is the common case, and there the
 * requested scheme gives the wrong answer exactly when the answer matters.
 */
export async function fetchHeaders(
  url: string,
  timeout = DEFAULT_TIMEOUT,
  allowAnyStatus = false,
): Promise<{ headers: Headers; finalUrl: string }> {
  // `allowAnyStatus` is part of the key: one caller wanting headers off a 404 and
  // another refusing them are asking different questions, and sharing an entry
  // between the two would hand one of them the wrong answer.
  return headersCache.run(`${url} ${allowAnyStatus}`, async () => {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeout);

    try {
      const { response, finalUrl } = await safeFetch(
        url,
        {
          method: "HEAD",
          signal: controller.signal,
          headers: { "User-Agent": PAGE_AUDIT_USER_AGENT },
        },
        GUARDED,
      );

      if (!allowAnyStatus && !response.ok) {
        throw PageFetchError.fromResponse(response.status);
      }

      return { headers: response.headers, finalUrl };
    } catch (error) {
      if (error instanceof Error && error.name === "AbortError") {
        throw PageFetchError.timeout(timeout);
      }
      throw error;
    } finally {
      clearTimeout(timeoutId);
    }
  });
}

/**
 * Fetch a URL without following its redirects.
 *
 * The caller inspects `Location` itself, which is what makes a redirect *chain*
 * reportable rather than a single resolved URL. Each hop the caller decides to
 * follow re-enters this function, so every one is re-validated against the SSRF
 * guard and re-cleared with robots.txt — a chain that leaves the origin cannot
 * carry us somewhere we would have refused to go directly.
 *
 * Unlike {@link fetchWithTimeout} this does not throw on a non-2xx: a 301 is the
 * answer here, not a failure.
 *
 * @param extraHeaders merged over ours. Exists for content negotiation:
 *                     `seo_agent_navigability` asks one URL for `text/markdown`
 *                     and compares the answer with the HTML one, and there is no
 *                     way to ask that question without setting `Accept`.
 */
export async function fetchWithoutRedirect(
  url: string,
  timeout = DEFAULT_TIMEOUT,
  extraHeaders?: Record<string, string>,
): Promise<Response> {
  // The one fetcher that calls the guards itself, because it follows no
  // redirects and so has no hop loop for `safeFetch` to hook. Each hop the
  // caller decides to follow re-enters this function and is guarded again.
  await clearToFetch(url);

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeout);

  try {
    await assertUrlAllowed(url);
    return await fetch(url, {
      headers: { "User-Agent": PAGE_AUDIT_USER_AGENT, ...extraHeaders },
      signal: controller.signal,
      redirect: "manual",
    });
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      throw PageFetchError.timeout(timeout);
    }
    throw error;
  } finally {
    clearTimeout(timeoutId);
  }
}

/**
 * Validate URL format before making requests.
 *
 * Both messages name the argument that is wrong and nothing else, which is what
 * makes them {@link InvalidInputError}s: the caller supplied the URL, so the
 * caller is the party that can fix it on the next call.
 */
export function validateUrl(url: string): void {
  try {
    const parsed = new URL(url);
    if (!parsed.protocol.startsWith("http")) {
      throw new InvalidInputError("URL must use HTTP or HTTPS protocol");
    }
  } catch (error) {
    if (error instanceof TypeError) {
      throw new InvalidInputError("Invalid URL format");
    }
    throw error;
  }
}
