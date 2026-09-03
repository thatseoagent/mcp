/**
 * The three agent-readiness Tools' shared output shape.
 *
 * They print the same thing: a list of checks, each one a mark, a name, a
 * fraction, a detail line and the `curl` that reproduces it — followed by the
 * subset that did not earn full marks. The three handlers carried a verbatim
 * copy of that block each, two identical prose comments included, which is three
 * places for a mark or a wording to drift apart. `render-check.ts` already
 * settled the vocabulary for one check; this settles the list.
 *
 * What is deliberately *not* here: the headline sentences above the list. Those
 * differ on purpose — the discovery tier only ever adds, the API tier is not
 * scored at all when a site has no API — and folding them together would be
 * flattening three different claims into one.
 *
 * `renderCoverage` is the exception to the "three Tools" in that first line: it
 * is read by every scored surface, because the sentence it prints is about the
 * arithmetic in `scored-checks.ts` rather than about agent-readiness. See its own
 * comment.
 */
import { earnedBy, type Scorable } from "./analyzers/scored-checks";
import { renderVerdict } from "./render-check";

/**
 * A check with something to say for itself.
 *
 * Structural rather than a base the three analyzers extend: they are ported
 * verbatim and each declares its own check type, and giving them a shared parent
 * would mean editing three files to satisfy a renderer.
 */
export interface ReportableCheck extends Scorable {
  name: string;
  detail: string;
  /** The `curl` line that reproduces this check, so a reader can check our work. */
  request: string;
}

/** One check: `✓ Name (12/15 pts)`, its detail, and how to re-run it. */
function renderCheck(check: ReportableCheck): string[] {
  // `passed ?? false` because `Scorable.passed` is optional — a partial-credit
  // check has nothing useful to put there — while `renderVerdict` requires it.
  // It only reads `passed` when `points` is 0, where "no answer" and "did not
  // pass" are the same statement.
  const { mark, words } = renderVerdict({ ...check, passed: check.passed ?? false });
  return [
    "",
    `${mark} ${check.name} (${words ?? `${earnedBy(check)}/${check.points} pts`})`,
    `   ${check.detail}`,
    `   Reproduce: ${check.request}`,
  ];
}

/** A whole section: the heading, then every check under it. */
export function renderCheckSection(
  heading: string,
  checks: readonly ReportableCheck[],
): string[] {
  return ["", `=== ${heading} ===`, ...checks.flatMap(renderCheck)];
}

/**
 * The checks that ran and did not earn what they were worth.
 *
 * `!check.status` drops both no-answer states: a question we could not ask is
 * not a gap in the site, and listing it under "what to fix" would hand the
 * reader our network trouble as their defect. A check worth zero points is
 * informational and cannot fail, which is why it is excluded too.
 */
export function checksToFix<T extends Scorable>(checks: readonly T[]): T[] {
  return checks.filter((check) => !check.status && check.points > 0 && earnedBy(check) < check.points);
}

/**
 * The two sentences a score owes when part of it was set aside.
 *
 * Both say "excluded from both sides", because that is the fact a reader needs
 * and the one a bare numerator hides. They stay two sentences because they mean
 * different things: `n/a` points are questions this subject cannot owe, and
 * `not evaluated` points are questions we failed to ask — which is what makes
 * this run incomparable to the last one.
 *
 * ── Why this took a `subject` ──
 *
 * `Tally` gained its last two fields so a caller could state its coverage
 * "without walking the list a second time with different rules than `tally`
 * used". Two of six scoring surfaces then walked nothing at all — `eeat` and
 * `security` dropped both fields on the floor and printed a score over a
 * denominator that had silently moved — and three of the remaining four spelled
 * the qualifier themselves, in three wordings. Reading them side by side, the
 * only difference that carried meaning was **what** the points fail to apply
 * to: a page, a file, a site. That one word is a parameter now, and the rest is
 * one sentence in one place. ADR-0003: a partial result presented as a whole one
 * is the failure the rule exists to prevent, and a score is a result.
 *
 * @param subject what the excluded points do not apply to, as the reader would
 *                say it: "this page", "this file", "this site".
 * @param notApplicableDetail an extra clause for the `n/a` sentence, when the
 *                exclusion is structural in a way worth naming — GEO's page type
 *                decides which checks a page can owe at all, and a reader who is
 *                not told which type was assumed cannot check our work.
 */
export function renderCoverage(
  totals: {
    notApplicable: number;
    notEvaluated: number;
  },
  { subject = "this site", notApplicableDetail }: {
    subject?: string;
    notApplicableDetail?: string;
  } = {},
): string[] {
  const lines: string[] = [];
  if (totals.notApplicable > 0) {
    const detail = notApplicableDetail ? ` ${notApplicableDetail}` : "";
    lines.push(
      `Not applicable: ${totals.notApplicable} pts do not apply to ${subject} and are excluded from both sides of the score — they are not gaps.${detail}`,
    );
  }
  if (totals.notEvaluated > 0) {
    lines.push(
      `Coverage: ${totals.notEvaluated} pts could not be evaluated on this run and are excluded from both sides — a retry may change the score without ${subject} changing.`,
    );
  }
  return lines;
}
