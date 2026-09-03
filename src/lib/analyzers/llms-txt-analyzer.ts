/**
 * What an llms.txt is worth, decided separately from how it prints.
 *
 * ── Why this file exists ──
 *
 * About 210 of `seo-llms-txt.ts`'s 453 lines were scored analysis living inside
 * a Tool handler: the line parse, five checks with their point values and partial
 * credit, the `tally`, and the grade bands. Every sibling scored Tool keeps that
 * in `src/lib/analyzers/` with a direct test — `geo-analyzer`, `eeat-analyzer`,
 * `ai-visibility-analyzer`, the three `agent-*` tiers — and llms.txt had
 * `llms-txt-links.ts` and `llms-txt-generator.ts` but no analyzer and no
 * `tests/lib` test at all. Its only coverage drove the whole Tool through a
 * monkeypatched `fetch`, so "a 200 with an empty body scores 0 but a 503 scores
 * nothing at all" could only be exercised by standing up a fake HTTP server.
 *
 * The consequence was visible in the file. The three-state discipline was
 * re-derived locally rather than reused, and the coverage sentences were written
 * out by hand — a fourth wording of what `render-scored-checks.ts` already says.
 *
 * ── Pure, so the probe is the caller's ──
 *
 * `CONTEXT.md` defines an **Analyzer** as pure and network-free. The one check
 * that needs the network — do the declared links reach real content? — takes its
 * answer as data, the way `EeatInput.trustPages` and `GeoInput.robotsRead` do.
 */
import {
  coverageOf,
  type LinkAudit,
  type ParsedLinks,
} from "../llms-txt-links";
import { notScored, tally, type Scorable, type Tally } from "./scored-checks";

/** What each of the five questions is worth. Equal, and stated once. */
const POINTS_PER_CHECK = 20;

/** The bands a percentage falls into. */
const GRADE_BANDS = [
  { atLeast: 90, grade: "Excellent" },
  { atLeast: 70, grade: "Good" },
  { atLeast: 40, grade: "Needs Improvement" },
  { atLeast: 0, grade: "Poor" },
] as const;

export type LlmsTxtGrade = (typeof GRADE_BANDS)[number]["grade"];

/** Everything the reading needs, all of it already in hand. */
export interface LlmsTxtInput {
  /** The file's bytes. */
  content: string;
  /**
   * The links it declares, parsed.
   *
   * Passed in rather than parsed here because the caller needs them first, to
   * decide whether there is anything to probe. One parse for both.
   */
  links: ParsedLinks;
  /**
   * Whether the declared links reach real content, or `null` when none were
   * declared and there was nothing to probe.
   *
   * This is the fetch, and it is the caller's. Counting links and reporting the
   * count is an endorsement of a file whose links may all 404, and llms.txt is a
   * navigation index: an agent that follows a dead link reads the dead end as the
   * site's rather than the URL's.
   */
  linkAudit: LinkAudit | null;
}

/** The reading of an llms.txt: what it has, what to fix, and what we could not ask. */
export interface LlmsTxtReading {
  /** The five checks, for a caller that wants the arithmetic itself. */
  checks: Scorable[];
  totals: Tally;
  score: number;
  /**
   * The points that could actually be asked.
   *
   * Moves when a check could not run, and it has to: scoring a file out of 100
   * when we only asked 80 points' worth of questions is the number that lies by
   * omission.
   */
  max: number;
  /**
   * The score as a share of what could be asked.
   *
   * Carried rather than left to the caller because the Tool needs the same figure
   * the grade bands use: it offers a generated template below 40%, which is the
   * "Needs Improvement" floor, and its schema description states that number to
   * the agent. Two places computing it is two places for the number to move.
   */
  percent: number;
  /**
   * Graded against what could be asked, not against a fixed 100. A file whose
   * links we failed to reach is scored out of 80, and holding it to the
   * 100-point bands would cost it a grade for our network trouble.
   */
  grade: LlmsTxtGrade;
  /** What the file has, for the reader who wants to know what earned the score. */
  found: string[];
  /** What to fix. Drives the recommendations, so nothing unanswerable goes here. */
  issues: string[];
  /**
   * The questions we could not ask, kept out of {@link issues}.
   *
   * A distinct list rather than a workaround: `issues` drives the
   * recommendations, so a `notScored(...)` string in it printed "Fix: Not scored:
   * … This is not a finding about the page" and marked a correct file invalid
   * because one link timed out. That is the unanswerable-read-as-answered
   * inversion in reverse, and `scored-checks.ts` exists to keep the two apart.
   *
   * What has changed is why it is safe: the checks and their rendering shared one
   * scope, so the leak was a slip away. They no longer do.
   */
  notes: string[];
  /** The coverage sentence for the sampled links, or `null` when none were probed. */
  linkCoverage: string | null;
}

function gradeFor(percent: number): LlmsTxtGrade {
  return GRADE_BANDS.find((band) => percent >= band.atLeast)!.grade;
}

/**
 * Score an llms.txt whose links have already been probed.
 *
 * The five questions, in the order the report prints them: does it have a title,
 * a description, at least three absolute links, links that go somewhere, and an
 * Optional section.
 */
export function scoreLlmsTxt({ content, links, linkAudit }: LlmsTxtInput): LlmsTxtReading {
  const fileLines = content.split(/\r?\n/);
  const checks: Scorable[] = [];
  const found: string[] = [];
  const issues: string[] = [];
  const notes: string[] = [];

  // 1. Title (# heading)
  const titleLine = fileLines.find((l) => /^#\s+\S/.test(l));
  checks.push({ points: POINTS_PER_CHECK, passed: Boolean(titleLine) });
  if (titleLine) {
    found.push(`Title: ${titleLine.replace(/^#\s+/, "").trim()}`);
  } else {
    issues.push("Missing title line (should start with '# Site Name')");
  }

  // 2. Description (> blockquote)
  const descLine = fileLines.find((l) => /^>\s+\S/.test(l));
  checks.push({ points: POINTS_PER_CHECK, passed: Boolean(descLine) });
  if (descLine) {
    found.push(`Description: ${descLine.replace(/^>\s+/, "").trim()}`);
  } else {
    issues.push("Missing description line (should start with '> Brief description')");
  }

  // 3. Content links.
  const absoluteUrls = links.absolute;
  if (absoluteUrls.length >= 3) {
    checks.push({ points: POINTS_PER_CHECK, passed: true });
    found.push(`Content links: ${absoluteUrls.length} absolute URLs declared`);
  } else if (absoluteUrls.length > 0) {
    // Partial credit, so `earned` rather than `passed`. `points` stays the
    // ceiling: that is the single most important line in `scored-checks.ts`.
    checks.push({ points: POINTS_PER_CHECK, earned: 8 });
    issues.push(`Only ${absoluteUrls.length} absolute link(s) found — recommend at least 3`);
  } else {
    checks.push({ points: POINTS_PER_CHECK, passed: false });
    issues.push("No content links found — add links to your key pages with absolute URLs");
  }

  if (links.relative > 0) {
    issues.push(
      `${links.relative} relative URL(s) found — use absolute URLs (https://...) for AI parsers`,
    );
  }

  // 4. Do those links go anywhere?
  let linkCoverage: string | null = null;
  const allBlockedByRobots =
    linkAudit !== null &&
    linkAudit.unreachable.length > 0 &&
    linkAudit.unreachable.every((probe) => probe.blockedByRobots === true);

  if (!linkAudit || linkAudit.probed === 0) {
    // Nothing declared to probe. Not a failure and not a pass: the check above
    // already reported that there are no links, and charging twice for one
    // absence is a double count.
    checks.push({ points: POINTS_PER_CHECK, status: "not-applicable" });
  } else {
    const answered = linkAudit.probed - linkAudit.unreachable.length;
    linkCoverage = coverageOf(linkAudit);

    if (answered === 0) {
      checks.push({ points: POINTS_PER_CHECK, status: "not-evaluated" });
      notes.push(
        notScored(
          `none of the ${linkAudit.probed} link(s) sampled could be reached on this run`,
          allBlockedByRobots
            ? "allow those paths in robots.txt if you want them measured — we do not fetch what you disallow"
            : "retry, or check that the URLs are reachable from outside your network",
        ),
      );
    } else {
      checks.push({
        points: POINTS_PER_CHECK,
        earned: Math.round((POINTS_PER_CHECK * linkAudit.resolves) / answered),
      });
      if (linkAudit.broken.length === 0) {
        // The coverage sentence is printed once, beside the score. Repeating it
        // here read as two different facts about the same probe.
        found.push(
          `Links resolve: ${linkAudit.resolves}/${answered} sampled links reach real content`,
        );
      } else {
        issues.push(
          `${linkAudit.broken.length} of ${answered} sampled link(s) do not reach real content: ` +
            linkAudit.broken.map((probe) => `${probe.url} — ${probe.reason}`).join("; "),
        );
      }
      if (linkAudit.unreachable.length > 0) {
        notes.push(
          notScored(
            `${linkAudit.unreachable.length} sampled link(s) could not be reached on this run (${linkAudit.unreachable
              .map((probe) => `${probe.url}: ${probe.reason}`)
              .join("; ")})`,
            allBlockedByRobots
              ? "allow those paths in robots.txt if you want them measured"
              : "retry to find out",
          ),
        );
      }
      // The shell comparison needs the homepage. Without it every 200 looks like
      // real content, which is precisely the check this replaced — so the reader
      // is told the strongest half of the check did not run.
      if (!linkAudit.shellCheckRan && linkAudit.resolves > 0) {
        notes.push(
          notScored(
            "the homepage could not be read, so a link answering 200 with the app shell would not have been caught on this run",
            "retry to find out",
          ),
        );
      }
    }
  }

  // 5. Optional section
  const hasOptional = /^##\s+Optional/im.test(content);
  checks.push({ points: POINTS_PER_CHECK, passed: hasOptional });
  if (hasOptional) {
    found.push("Optional section: present (legal/privacy pages)");
  } else {
    issues.push("No '## Optional' section — consider adding privacy policy and terms links");
  }

  const totals = tally(checks);
  const percent = totals.max === 0 ? 0 : (totals.score / totals.max) * 100;

  return {
    checks,
    totals,
    score: totals.score,
    max: totals.max,
    percent,
    grade: gradeFor(percent),
    found,
    issues,
    notes,
    linkCoverage,
  };
}
