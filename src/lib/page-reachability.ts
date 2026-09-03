import { fetchAnyStatus } from "./http-client";
import { RobotsDisallowedError } from "./robots-gate";
import { CrawlBudgetError } from "./crawl-pacing";
import { describeHttpStatus } from "./describe-http-status";
import { PAGE_AUDIT_USER_AGENT } from "./bot-identity";
import { createSingleFlightCache } from "./single-flight";

/**
 * One read of a page per window, however many subtasks ask for it.
 *
 * Keyed on the timeout as well as the URL, because a caller that allowed twelve
 * seconds and one that allowed two asked different questions, and handing the
 * second the first's answer would hide a timeout it was entitled to see.
 */
const pageCache = createSingleFlightCache<PageReachability>();

/** Drop the cache. For tests, so one case cannot leak into the next. */
export function resetPageCache(): void {
  pageCache.clear();
}

/**
 * The first thing an audit must establish: can this URL be read at all.
 *
 * `seo_geo_score` and `ai_visibility_score` fetched the page alongside robots.txt,
 * the sitemap and a HEAD probe in one `Promise.allSettled`, then scored whatever
 * came back. A URL returning 404 resolves with a real status and the error page's
 * body, so the audit carried on and produced a full report: auditing a
 * non-existent page returned "GEO 24 Low" with 24 findings, of which 23 were
 * consequences of the page not existing. The one finding that mattered — "HTTP
 * 200 status code" — sat fourteenth in the list.
 *
 * A **Reachability Gate** runs before anything else and is binary. Either the
 * page can be read and the audit proceeds, or it cannot and the audit stops and
 * says why. Nothing downstream should have to wonder whether its input is real.
 */

export type PageReachability =
  | {
      ok: true;
      status: number;
      html: string;
      headers: Record<string, string>;
      /** The URL actually read, after any redirects the guard allowed. */
      finalUrl: string;
    }
  | {
      ok: false;
      /** The HTTP status, or 0 when the request never completed. */
      status: number;
      /** One sentence naming what happened, for the reader of the report. */
      reason: string;
    };


/**
 * What a Tool says when the Gate refuses.
 *
 * Both scoring Tools stop here and both say the same four things: which heading
 * the reader was expecting, that nothing was scored, why not, and what was asked
 * for. They said it in two hand-built blocks, so the wording could drift while
 * the situation stayed identical — and the situation is the Gate's, not either
 * Tool's, which is why the sentence lives beside it.
 *
 * @param heading  the section header the reader would otherwise have got.
 * @param url      what was asked for, echoed because an agent may have rewritten it.
 * @param note     what this particular Tool did not do, in its own terms.
 */
export function refusalText(
  heading: string,
  url: string,
  page: Extract<PageReachability, { ok: false }>,
  note?: string,
): string {
  return [
    heading,
    "Not scored: the page could not be read.",
    "",
    page.reason,
    "",
    `URL: ${url}`,
    `HTTP status: ${page.status || "no response"}`,
    ...(note ? ["", note] : []),
  ].join("\n");
}

/**
 * Read the page, or explain why not.
 *
 * A 3xx is not a failure: the fetcher follows redirects and the final response is
 * what gets audited. `finalUrl` records where it landed, which is how a caller can
 * notice it audited something other than what it was given.
 */
export function fetchAuditablePage(
  url: string,
  timeout = 12_000,
): Promise<PageReachability> {
  // Shared with every other caller in the same window: an agent asked to audit a
  // page calls several Tools that all read it, and they get one request between
  // them rather than one each.
  //
  // A verdict is cached whether or not the page was reachable: "this URL is a
  // 404" is as much an answer as the HTML, and re-asking it once per Tool in the same
  // turn told us nothing new.
  return pageCache.run(`${url} ${timeout}`, () => readPage(url, timeout));
}

async function readPage(url: string, timeout: number): Promise<PageReachability> {
  try {
    // Through the shared fetcher, so this consults robots.txt and spends a
    // pacing slot. It did neither: this is the FIRST fetch of every
    // `seo_geo_score` and `ai_visibility_score` run, reading the Operator's page
    // with our product token, and `http-client.ts` says the two obligations bind
    // every fetch. They did not bind this one.
    const { response } = await fetchAnyStatus(url, { method: "GET", timeout });

    if (!response.ok) {
      return { ok: false, status: response.status, reason: describeHttpStatus(response.status) };
    }

    const html = await response.text();
    const headers: Record<string, string> = {};
    response.headers.forEach((value, key) => { headers[key.toLowerCase()] = value; });

    // A 200 with no body is not a page either, and scoring it produces the same
    // fog of meaningless findings as a 404.
    if (html.trim().length === 0) {
      return {
        ok: false,
        status: response.status,
        reason: `The URL returned HTTP ${response.status} with an empty body, so there is no content to audit.`,
      };
    }

    return { ok: true, status: response.status, html, headers, finalUrl: response.url || url };
  } catch (error) {
    // A refusal is not a failure to reach, and flattening it into one is the
    // mistake `RobotsDisallowedError` was given its own type to prevent:
    // "callers must not report it as a fetch failure: the page is fine, we chose
    // not to look. Surfacing it as 'site unreachable' would send someone
    // debugging their server over a rule they wrote on purpose." The same holds
    // for a budget we set ourselves. Both are authored sentences that answer the
    // Operator's question in full, so both travel to the Tool failure seam
    // intact rather than becoming this function's generic `reason`.
    if (error instanceof RobotsDisallowedError || error instanceof CrawlBudgetError) throw error;

    const message = error instanceof Error ? error.message : String(error);
    const timedOut = /abort|timeout/i.test(message);
    return {
      ok: false,
      status: 0,
      // Neither branch interpolates `message`. It used to: the non-timeout branch
      // read `The URL could not be reached: ${message}`, and `reason` is rendered
      // straight into tool output by `seo_geo_score` and `ai_visibility_score`, so a
      // driver string or an internal hostname reached the model from here without
      // ever passing the seam in `tool-failure.ts`. Both Tools promise
      // only to name the status, and every other `reason` in this file is already
      // a fixed sentence — this one was the exception.
      reason: timedOut ? describeHttpStatus(0, timeout) : describeHttpStatus(0),
    };
  }
}
