/**
 * Whether Google can index this page at all, as a gate rather than as points.
 *
 * > "As long as your page meets the minimum technical requirements, it's eligible
 * > to be indexed by Google Search:"
 * > https://developers.google.com/search/docs/essentials/technical
 *
 * Three checks, and only two of them are Google's technical requirements. That
 * distinction cost this module a rewrite, so it is worth stating: Google's third
 * requirement is "the page has indexable content", and Google defines that as a
 * supported file type plus no spam-policy violation — neither of which we can
 * check. `noindex` is a different mechanism on a different page, and the first
 * draft filed it as requirement three, which put a sentence in front of clients
 * that Google never wrote. It stays in the gate because it belongs at this
 * severity; it is sourced to the page that documents it.
 *
 * These three are not findings like the others. Everything else the product
 * reports is an improvement to a page that can appear in Search; these decide
 * whether it can appear at all. Scored among thirty-odd GEO checks — which is
 * where the HTTP status lived, worth 3 points next to "Blockquote elements
 * present" — a page answering 500 and a page missing a summary section came back
 * looking like comparable findings. `docs/google-search-central-conformance.md`
 * §2.5 records why.
 *
 * A gate, not a score, so it returns a verdict a report can lead with. It does
 * not decide what a caller does about a failure: the GEO report still scores the
 * page, because a 500 today does not make the rest of the analysis wrong, only
 * premature. What changes is that the reader is told first.
 *
 * Pure, and separate from `page-reachability` on purpose. That module answers
 * "can we read this page" for our own fetchers and returns the body. This one
 * answers "can Google index it", which is a different question with an
 * overlapping input: a 403 stops us both, a `noindex` stops only Google.
 */

import { type CheerioAPI } from "cheerio";
import type { ParsedPage } from "./parsed-page";

import { parseRobots } from "./robots-ruleset";
import { describeHttpStatus } from "../describe-http-status";

/** The crawler the first check is about. */
const GOOGLEBOT = "Googlebot";

export type TechnicalRequirementId = "googlebot-allowed" | "http-200" | "not-excluded";

export type TechnicalRequirement = {
  id: TechnicalRequirementId;
  /** What Google asks for, in Google's terms. */
  label: string;
  met: boolean;
  /** Why it is met or not, naming the status, the rule, or the directive found. */
  detail: string;
};

export type TechnicalRequirementsVerdict = {
  /** True only when all three checks pass. */
  met: boolean;
  requirements: TechnicalRequirement[];
  /**
   * One sentence for the top of a report, present only on failure.
   *
   * Counts the failures rather than naming the first, so that fixing one does not
   * read as having fixed all of them.
   */
  blocker?: string;
};

export type TechnicalRequirementsInput = {
  /** The status the page answered with. `0` when the request never completed. */
  httpStatus: number;
  /** The document, read once. Was `html: string`, and this module parsed it again. */
  page: ParsedPage;
  /** The site's robots.txt, or `""` when it has none (which allows everything). */
  robotsTxt: string;
  /** The page's own URL: a `Disallow` can cover this path and not the site. */
  url: string;
  /** Lowercased response headers, for `X-Robots-Tag`. */
  responseHeaders?: Record<string, string>;
};

/**
 * Is Googlebot allowed to fetch this specific URL?
 *
 * Path-aware, because `Disallow: /admin/` blocks a dashboard and not a homepage,
 * and reporting the whole site as invisible on the strength of it would be the
 * kind of false alarm the conformance audit exists to remove. Falls back to the
 * path only, since `robots.txt` rules are path patterns.
 */
function googlebotAllowed(robotsTxt: string, url: string): TechnicalRequirement {
  if (!robotsTxt.trim()) {
    return {
      id: "googlebot-allowed",
      label: "Googlebot is not blocked",
      met: true,
      detail: "No robots.txt, so nothing is disallowed",
    };
  }

  const rules = parseRobots(robotsTxt);
  let path = "/";
  try {
    path = new URL(url).pathname || "/";
  } catch {
    // An unparseable URL is the caller's problem, not a robots finding. Judging
    // the site root is the answer least likely to invent a blocker.
  }

  const allowed = rules.allows(path, GOOGLEBOT);
  return {
    id: "googlebot-allowed",
    label: "Googlebot is not blocked",
    met: allowed,
    detail: allowed
      ? `robots.txt allows Googlebot on ${path}`
      : `robots.txt disallows Googlebot on ${path}` +
        (rules.restrictionsFor(GOOGLEBOT).length
          ? ` (rules in force: ${rules.restrictionsFor(GOOGLEBOT).join(", ")})`
          : ""),
  };
}

/** Did the page answer 200? Anything else, including a redirect, is not a 200. */
function answers200(httpStatus: number): TechnicalRequirement {
  const met = httpStatus === 200;
  return {
    id: "http-200",
    label: "The page returns HTTP 200",
    met,
    detail: met
      ? "HTTP 200"
      : httpStatus === 0
        ? "The request never completed, so Google would get no response either"
        : `HTTP ${httpStatus}. ${describeHttpStatus(httpStatus)}`,
  };
}

/**
 * The rules that remove a page from the index, and only those.
 *
 * `nofollow`, `nosnippet` and `noarchive` all restrict what Google does with a
 * page it has indexed. None keep it out, so none belong in a gate about whether
 * the page can appear at all — treating them as blockers would report a deliberate
 * snippet choice as a site-breaking fault.
 *
 * `none` does belong: Google defines it as "Equivalent to `noindex, nofollow`", so
 * a page carrying it is as gone as one carrying `noindex`. Missing it was the kind
 * of gap that makes a gate worse than no gate, because it answers confidently.
 *
 * Parsed with cheerio rather than a regex. The regex this replaced required
 * `name` before `content`, so `<meta content="noindex" name="robots">` cleared the
 * gate, and it read only the first matching tag while Google honours rules "by
 * using multiple `meta` tags".
 */
/**
 * The directive values that take a page out of the index.
 *
 * Exported because three modules used to answer this question with three
 * different regexes, and they disagreed: `crawlability-analyzer` recognised
 * `none`, this gate's first draft did not, and `geo-analyzer`'s check tested a
 * bare `/noindex/i` against the first `robots` tag it found. So the same page
 * could be reported as indexable by one surface and excluded by another.
 */
export const REMOVES_FROM_INDEX = /\b(?:noindex|none)\b/i;

function findIndexBlocker($: CheerioAPI, responseHeaders: Record<string, string>): string | null {
  // Both names Google documents. A page can be indexable for everyone else and
  // not for Google.
  let found: string | null = null;
  $('meta[name="robots"], meta[name="googlebot"]').each((_, el) => {
    if (found) return;
    const content = $(el).attr("content");
    if (content && REMOVES_FROM_INDEX.test(content)) {
      found = `<meta name="${$(el).attr("name")}" content="${content}">`;
    }
  });
  if (found) return found;

  const header = responseHeaders["x-robots-tag"];
  if (header && REMOVES_FROM_INDEX.test(header)) return `X-Robots-Tag: ${header}`;

  return null;
}

function isNotExcluded(
  $: CheerioAPI,
  responseHeaders: Record<string, string>
): TechnicalRequirement {
  const directive = findIndexBlocker($, responseHeaders);
  return {
    id: "not-excluded",
    // Says what is checked. The old label, "The page has indexable content",
    // borrowed Google's wording for its third requirement while checking
    // something else entirely.
    label: "No directive removes the page from the index",
    met: directive === null,
    detail: directive ? `Excluded by ${directive}` : "No noindex or none directive found",
  };
}

/**
 * Check all three, in the order a failure stops mattering.
 *
 * A blocked crawler never sees the status; a page that does not answer has no
 * directives to read. The order is not Google's list — two of these are from that
 * list and the third is not — but it is the order in which the answers become moot.
 */
export function checkTechnicalRequirements(
  input: TechnicalRequirementsInput
): TechnicalRequirementsVerdict {
  const headers = input.responseHeaders ?? {};
  const requirements: TechnicalRequirement[] = [
    googlebotAllowed(input.robotsTxt, input.url),
    answers200(input.httpStatus),
    isNotExcluded(input.page.$, headers),
  ];

  const failed = requirements.filter((r) => !r.met);
  if (failed.length === 0) return { met: true, requirements };

  return {
    met: false,
    requirements,
    blocker:
      `This page fails ${failed.length} of the 3 checks that decide whether Google can index it at all: ` +
      `${failed.map((r) => r.detail).join("; ")}. ` +
      `Until that is fixed the page cannot appear in Search, so the rest of this report is about a page nobody can find.`,
  };
}
