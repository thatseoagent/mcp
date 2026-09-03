import { fetchAnyStatus } from "./http-client";
import { classifyRobotsStatus } from "./analyzers/robots-ruleset";

/**
 * Reading a file the web agrees lives at a fixed path: `/robots.txt`, `/llms.txt`,
 * `/sitemap.xml`.
 *
 * ── Why this exists ──
 *
 * Two tool handlers read the same three files and disagreed about what a failure
 * meant. `ai-visibility-tools` learned to tell "the site has no robots.txt" from "we
 * could not read it" (#337); `geo-tools` did not, so it kept a `fetchText` that
 * returned `{ text: "", status: 0 }` on every throw. That empty string then reached
 * `scoreAiCrawlerAccess`, where `isBotBlocked("", "GPTBot")` finds no rule and
 * **passes** — so a robots.txt we never read awarded 13 GEO points across four
 * checks. The fix landed in one of the two files that make the same mistake, which
 * is what happens when a decision lives at two call sites instead of in a module.
 *
 * ── The one distinction this module exists to keep ──
 *
 * Three outcomes, and the first two are both **answers**:
 *
 * - `found` — the file is there; here are its bytes.
 * - `absent` — 404 or 410. A definite answer, and for robots.txt a load-bearing one:
 *   no file means no rules, so every crawler is allowed. Callers may treat this as a
 *   pass. They may not treat `unavailable` as one.
 * - `unavailable` — a 5xx, a redirect, an auth challenge, a timeout, a DNS failure,
 *   an SSRF refusal. We did not find out, and saying "allowed" from that invents a
 *   fact.
 *
 * `absent` is a separate case rather than `found` with empty text because a 404 and a
 * genuinely empty file are only the same answer by accident, and a caller that wants
 * to say *why* a check did not run needs to know which it got.
 *
 * ── What is deliberately not here ──
 *
 * Interpretation. `robots-ruleset` parses, `sitemap-discovery` chooses which sitemap
 * to trust, `geo-tools` follows a `<sitemapindex>` into its children. This module
 * brings bytes or a reason and stops. It lives in `lib/utils` and not
 * `lib/analyzers` for the same reason: `CONTEXT.md` defines an **Analyzer** as pure
 * and network-free, and this does I/O.
 *
 * Third-party APIs are not well-known files and are not here either — the Knowledge
 * Graph and Wikidata lookups live in `lib/tools/shared/`, keyed by a brand name
 * rather than an origin.
 *
 * These fetches ARE gated and paced, through `fetchAnyStatus`. An earlier version
 * of this comment said the robots.txt gate "arrives with the crawl Tools" and was
 * absent here; it arrived, `http-client.ts` says the two obligations bind every
 * outbound request, and this file was not revisited. Reading `/robots.txt` itself
 * is exempt from the gate — `robots-gate.ts` owns that exemption by path, so it
 * cannot be forgotten here or applied twice.
 *
 * Three other modules read `/robots.txt` and are not being moved onto this:
 * `robots-analyzer` rethrows non-404s, `crawlability-analyzer` returns
 * `boolean | null`, and `site-crawler` deliberately wants a parsed ruleset rather
 * than a response. Each already treats its own failure on purpose, and none of them
 * varies anything across this seam today.
 */
export type WellKnownRead =
  | { outcome: "found"; text: string; status: number }
  | { outcome: "absent"; status: number }
  | { outcome: "unavailable"; reason: string; status: number };

/** Did we get an answer, of either kind? Convenience for the common branch. */
export function answered(read: WellKnownRead): boolean {
  return read.outcome !== "unavailable";
}

/**
 * The bytes, or `""` when the file is absent.
 *
 * For callers that genuinely treat "no file" and "empty file" alike — a robots
 * parser does, since both yield no rules. **Never** call this without checking
 * `answered()` first: it returns `""` for `unavailable` too, and that collapse is the
 * whole bug this module was written to prevent.
 */
export function textOrEmpty(read: WellKnownRead): string {
  return read.outcome === "found" ? read.text : "";
}

/**
 * Read a well-known file at an origin.
 *
 * `path` is joined against `origin`, so pass `/robots.txt` rather than a full URL —
 * the point of the module is that the caller names the file, not the address.
 *
 * `method: "HEAD"` for existence checks that do not need the body (llms.txt). A HEAD
 * that succeeds returns `found` with empty text, which is correct: the file is there
 * and we did not ask for its contents.
 */
export async function readWellKnown(
  origin: string,
  path: string,
  opts: { method?: "GET" | "HEAD"; timeout?: number } = {},
): Promise<WellKnownRead> {
  const method = opts.method ?? "GET";
  const timeout = opts.timeout ?? 8_000;

  let url: string;
  try {
    url = new URL(path, origin).toString();
  } catch {
    return { outcome: "unavailable", reason: `could not build a URL for ${path}`, status: 0 };
  }

  try {
    const { response } = await fetchAnyStatus(url, { method, timeout });

    // Classification borrowed wholesale from `robots-ruleset`, which already had to
    // name these three outcomes for #337 and is where the reasoning is written down.
    // It is not robots-specific: 404 means "no file" for any well-known path.
    switch (classifyRobotsStatus(response.status)) {
      case "absent":
        return { outcome: "absent", status: response.status };
      case "read":
        return {
          outcome: "found",
          text: method === "HEAD" ? "" : await response.text(),
          status: response.status,
        };
      case "unavailable":
        return {
          outcome: "unavailable",
          reason: `${path} returned HTTP ${response.status}`,
          status: response.status,
        };
    }
  } catch {
    // Timeout, DNS failure, connection refused, or an SSRF refusal. The error kind
    // is not distinguished here because no caller
    // scores differently on it — what they all need is "not an answer".
    return {
      outcome: "unavailable",
      reason: `${path} could not be fetched (timeout, DNS or connection failure)`,
      status: 0,
    };
  }
}
