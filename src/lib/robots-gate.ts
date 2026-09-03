/**
 * robots.txt as a precondition for fetching, not just as something we report on.
 *
 * The site crawler has always parsed robots.txt before walking a site. Everything
 * else — page audits, schema probes, GEO checks, llms.txt lookups, E-E-A-T,
 * security headers — fetched straight past it, which meant a site that blocked
 * ThatSEOAgentBot by name still received every one of those requests. The user
 * agents are one product token now, so the same `Disallow` has to bind all of
 * them.
 *
 * Two fetches are deliberately NOT gated, and both would be bugs if they were:
 *   - robots.txt itself. Gating it on its own contents does not terminate.
 *   - Fixed third-party APIs (Wikipedia, Wikidata). Those are APIs with their own
 *     terms, reached at a known endpoint, and they are not what a site owner is
 *     addressing when they write a rule about our crawler.
 *
 * The ruleset is cached per origin for the request window, so auditing twenty
 * pages on one site costs one robots.txt fetch, not twenty.
 */
import { NO_ROBOTS, parseRobots, type RobotsRuleset } from "./analyzers/robots-ruleset";
import { PAGE_AUDIT_USER_AGENT, BOT_DOCS_URL } from "./bot-identity";
import { createSingleFlightCache } from "./single-flight";
import { safeFetch } from "./ssrf-guard";
import { paceRequestTo } from "./crawl-pacing";

const ROBOTS_TIMEOUT = 5_000;

const robotsCache = createSingleFlightCache<RobotsRuleset>({ ttlMs: 60_000 });

/**
 * Thrown when robots.txt disallows the URL for our user agent.
 *
 * A distinct type because callers must not report it as a fetch failure: the
 * page is fine, we chose not to look. Surfacing it as "site unreachable" would
 * send someone debugging their server over a rule they wrote on purpose.
 */
export class RobotsDisallowedError extends Error {
  readonly url: string;
  readonly userAgent: string;

  constructor(url: string, userAgent: string) {
    super(
      `robots.txt disallows ${url} for ${userAgent}. ` +
        `This server honours robots.txt: see ${BOT_DOCS_URL}`,
    );
    this.name = "RobotsDisallowedError";
    this.url = url;
    this.userAgent = userAgent;
  }
}

/**
 * The origin's robots.txt, parsed.
 *
 * Unreachable or erroring robots.txt means no rules, which is what every crawler
 * does. That is the opposite of what `well-known.ts` insists on for *reporting*,
 * and deliberately so: there the question is "what does this site say?", and
 * answering "nothing" from a 503 invents a fact. Here the question is "may we
 * fetch?", and the only alternative to proceeding is refusing to do the work the
 * Operator asked for because a stranger's server had a bad minute.
 */
export async function robotsFor(origin: string): Promise<RobotsRuleset> {
  return robotsCache.run(origin, async () => {
    try {
      // Paced, though never gated. The recursion argument only rules out asking
      // robots.txt for permission to read robots.txt; it says nothing about the
      // request being free, and it is not — it is one more connection to
      // somebody else's server, and on a fifty-page crawl it is the very first
      // one. Leaving it out meant the pace began after we had already knocked.
      await paceRequestTo(`${origin}/robots.txt`);

      const { response } = await safeFetch(`${origin}/robots.txt`, {
        signal: AbortSignal.timeout(ROBOTS_TIMEOUT),
        headers: { "User-Agent": PAGE_AUDIT_USER_AGENT },
      });
      if (!response.ok) return NO_ROBOTS;
      return parseRobots(await response.text());
    } catch {
      return NO_ROBOTS;
    }
  });
}

/**
 * True when we may fetch this URL.
 *
 * Malformed URLs pass: the SSRF guard is what rejects those, and duplicating its
 * judgement here would only disagree with it.
 */
export async function isAllowedByRobots(
  url: string,
  userAgent: string = PAGE_AUDIT_USER_AGENT,
): Promise<boolean> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return true;
  }

  // Never gate the file that does the gating.
  if (parsed.pathname === "/robots.txt") return true;

  const rules = await robotsFor(parsed.origin);
  return rules.allows(parsed.pathname + parsed.search, userAgent);
}

/** {@link isAllowedByRobots}, as a precondition. Throws {@link RobotsDisallowedError}. */
export async function assertRobotsAllowed(
  url: string,
  userAgent: string = PAGE_AUDIT_USER_AGENT,
): Promise<void> {
  if (!(await isAllowedByRobots(url, userAgent))) {
    throw new RobotsDisallowedError(url, userAgent);
  }
}

/** For tests, so one case cannot leak a cached ruleset into the next. */
export function resetRobotsCache(): void {
  robotsCache.clear();
}
