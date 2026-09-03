/**
 * The request machinery both agent-readiness tiers make their claims out of.
 *
 * Extracted when the API-surface tier (#388) arrived and needed the same four
 * things the HTTP tier (#387) already had: a request whose failure is a reason
 * rather than a throw, a redirect chain followed by hand under a same-host guard,
 * the `curl` line that reproduces either of them, and the one shape a check takes
 * when it could not run. Two copies of a same-host guard is the copy that
 * eventually stops guarding.
 *
 * Everything here is read-only and unauthenticated, and that is a rule of the axis
 * rather than a property of this file — see ADR-0006.
 */

import { fetchWithoutRedirect } from "../http-client";
import { RobotsDisallowedError } from "../robots-gate";
import { notScored } from "./scored-checks";

/**
 * The path both tiers ask for in order to be told it does not exist.
 *
 * One constant, shared, and deliberately not a nonce: every finding ships with the
 * `curl` line that produced it, and a reader who cannot re-run the exact request
 * cannot check our work. It is self-describing so an operator reading their access
 * log meets an explanation rather than a mystery.
 */
export const PROBE_PATH = "/thatseoagent-probe-this-path-should-not-exist";

/** Redirect hops followed before the chain is reported as unresolved. */
export const MAX_HOPS = 5;

/**
 * Per-request budget.
 *
 * Per request, not per audit: the API tier can issue a dozen landed requests on a
 * site that advertises a spec and redirects, so this bounds the slowest one rather
 * than the run. The tier that adds probes owns the arithmetic.
 */
const PROBE_TIMEOUT = 15_000;

export type Probe =
  | { ok: true; status: number; headers: Headers; body: string; url: string }
  /**
   * `blockedByRobots` because the two failures need different sentences: a
   * timeout is ours or the network's and is worth a retry, a `Disallow` is the
   * site's own instruction and retrying it would mean ignoring it.
   */
  | { ok: false; reason: string; url: string; blockedByRobots?: boolean };

/**
 * The line that reproduces a check, spelled exactly as the audit asked it.
 *
 * Three things it has to get right, and each of them was wrong in a first draft:
 *
 * - **`url` is what we requested, not where we landed.** Printing the landed URL
 *   next to `-L` tells the reader to start following from the destination, which
 *   re-runs the tail of a journey rather than the journey.
 * - **`-L` iff the audit followed a hop.** A flag we did not use makes it a
 *   different request to the one the finding is about.
 * - **`-o /dev/null` iff the check is about headers.** The 404-body, code-fence
 *   and token-budget checks are claims about the body; discarding it hands the
 *   reader a command that cannot show them what we saw.
 */
export function curl(
  url: string,
  { accept, followed = false, body = false }: { accept?: string; followed?: boolean; body?: boolean } = {},
): string {
  const flags = ["-sS", "-D", "-", body ? null : "-o /dev/null", followed ? "-L" : null]
    .filter(Boolean)
    .join(" ");
  return accept
    ? `curl ${flags} -H 'Accept: ${accept}' '${url}'`
    : `curl ${flags} '${url}'`;
}

/**
 * The `not-evaluated` shape, in one place.
 *
 * Every check on this axis needs it and it has to be identical in all of them:
 * `notScored`'s sentence, the `status` that takes the check out of both sides of
 * the score, and the reproducing request kept — a check nobody could run is the
 * one a reader is most likely to want to try themselves.
 *
 * Not for a robots.txt refusal. See {@link disallowed}.
 */
export function couldNotRun<T extends { points: number; request: string }>(
  base: T,
  reason: string,
): T & { status: "not-evaluated"; detail: string } {
  return { ...base, status: "not-evaluated", detail: notScored(reason) };
}

/**
 * One request, with the failure kept as a reason rather than thrown.
 *
 * Every caller here wants the same three-way answer — it responded, it refused,
 * we could not reach it — and a `not-evaluated` check needs the reason as prose
 * anyway. `RobotsDisallowedError` is separated because it is not a failure at
 * all: the site told us not to look and we did not, which is a different sentence
 * to print than a timeout.
 */
export async function probe(url: string, accept?: string): Promise<Probe> {
  try {
    const response = await fetchWithoutRedirect(
      url,
      PROBE_TIMEOUT,
      accept ? { Accept: accept } : undefined,
    );
    return {
      ok: true,
      status: response.status,
      headers: response.headers,
      body: await response.text(),
      url,
    };
  } catch (error) {
    if (error instanceof RobotsDisallowedError) {
      return { ok: false, reason: "robots.txt disallows this path for our crawler", url, blockedByRobots: true };
    }
    const message = error instanceof Error ? error.message : String(error);
    return { ok: false, reason: message, url };
  }
}
export type Hop = { url: string; status: number; location: string };

export type Landing = {
  /** What we asked for. The `curl` line prints this, never `finalUrl`. */
  requested: string;
  probe: Probe;
  hops: Hop[];
  /** A hop whose `Location` left the host. Recorded, not followed. */
  offHost: Hop | null;
  finalUrl: string;
};

/**
 * Follow the chain by hand, stopping at the host boundary.
 *
 * `crawlability-analyzer` walks a chain too, and counts hops for latency. This
 * one exists because the tier needs the *landing response* — headers and body —
 * under a same-host guard, and because an off-host hop is a finding here rather
 * than a hop to keep following.
 */
export async function land(url: string): Promise<Landing> {
  const hops: Hop[] = [];
  let current = url;
  const requested = url;

  for (let i = 0; i <= MAX_HOPS; i++) {
    const result = await probe(current);
    if (!result.ok) return { requested, probe: result, hops, offHost: null, finalUrl: current };

    const location = result.status >= 300 && result.status < 400
      ? result.headers.get("location")
      : null;
    if (!location) return { requested, probe: result, hops, offHost: null, finalUrl: current };

    let next: string;
    try {
      next = new URL(location, current).toString();
    } catch {
      return { requested, probe: result, hops, offHost: null, finalUrl: current };
    }

    const hop = { url: current, status: result.status, location: next };
    if (new URL(next).host !== new URL(current).host) {
      // Not followed. An audit of one host must not become a request to another.
      return { requested, probe: result, hops, offHost: hop, finalUrl: current };
    }

    hops.push(hop);
    current = next;
  }

  return { requested, probe: await probe(current), hops, offHost: null, finalUrl: current };
}

/**
 * The `not-evaluated` shape for a path the site told us not to fetch.
 *
 * Separate from {@link couldNotRun} because `notScored`'s sentence would be two
 * lies at once here: it promises "this is not a finding about the page" when the
 * cause is squarely the page's own robots.txt, and it says "try again" when
 * trying again is exactly what we have undertaken not to do. `no-answer-says-why`
 * already draws this line for checks whose no-answer is the page's doing — they
 * must explain themselves without claiming innocence on the page's behalf.
 */
export function disallowed<T extends { points: number; request: string }>(
  base: T,
  url: string,
): T & { status: "not-evaluated"; detail: string } {
  return {
    ...base,
    status: "not-evaluated",
    detail: `Not scored: your robots.txt disallows ${url} for our crawler, and That SEO Agent honours it (https://thatseoagent.com/en/seo-bot). Nothing was fetched, so nothing is claimed either way. Allow the path if you want this measured.`,
  };
}

/** Whether a response is a redirect — at the end of a walk, a chain that never resolved. */
export function unresolved(probe: Probe): boolean {
  return probe.ok && probe.status >= 300 && probe.status < 400;
}
