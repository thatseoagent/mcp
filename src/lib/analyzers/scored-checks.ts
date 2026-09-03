/**
 * A scored check, and the only arithmetic anyone should do with a pile of them.
 *
 * Four scoring modules had four conventions, and `points` meant two opposite
 * things across them: the *maximum* in `geo-analyzer` and `ai-visibility`, the
 * *earned* value in `eeat-analyzer`. So a failed E-E-A-T indicator rendered as
 * "(0 pts)" — the same "0/0" confusion `geo-analyzer` had already had and fixed
 * for itself, without the fix reaching anywhere else.
 *
 * Underneath that, three of the four maintained a total by hand alongside the
 * checks that produce it:
 *
 *   - `ai-visibility` wrote every value twice, once as `points: 8` and once as
 *     `score += 8`, in sixteen pairs with nothing keeping them in step.
 *   - `eeat` hardcoded four `maxScore = 25` constants; changing one indicator's
 *     award would have let a perfect page score 26 out of 25.
 *   - `security` declared a literal ceiling per check and then clamped the
 *     ladder to it — the clamp existing precisely because the two were
 *     maintained separately.
 *
 * That class of bug has already cost us once: `scoreL1` kept `const MAX = 40`
 * after a check dropped to zero points, so a flawless site reached 33 out of a
 * stated 40 and every grade came out a tier low.
 *
 * A total that is computed cannot drift from its parts. `points` is always the
 * ceiling; `earned` is what this page got, and only partial-credit checks set it.
 *
 * ── The second invariant: a check that did not run is not in the fraction ──
 *
 * `na` used to mean "not applicable" and `earnedBy` credited it in full, which was
 * safe only if the caller then subtracted those points from *both* sides of the
 * percentage. That requirement was stated in a doc comment and enforced by nothing,
 * and it is the same reasoning error twice over (#288 in `geo-analyzer`, #304 in the
 * crawler report): **empty read as clean, unanswerable read as answered.** One
 * caller of four did the subtraction. The other three were safe only because their
 * own check types happened not to declare the field.
 *
 * So the arithmetic no longer needs a caller to remember anything. `tally` skips a
 * non-scorable check in the score AND in the maximum, and reports its points
 * separately for whoever wants to say so in words. There is nothing left to forget.
 * See #337 and `docs/research/checks-that-cannot-run.md`.
 */

/**
 * Why a check has no score, when it has none.
 *
 * Two states, deliberately not one boolean. They differ in what the reader should
 * do about it, and in whether the number is comparable to the last run:
 *
 * - `not-applicable` — the check does not correspond to this kind of page. It is
 *   structural and deterministic: derived from the `PageKind`, the same answer on
 *   every run. An Article freshness check on a homepage. The reader is told this
 *   page does not owe it, and the matter is closed.
 * - `not-evaluated` — we could not find out. A robots.txt that timed out, an API
 *   that returned 5xx, a comparison with nothing to compare against. Transitory:
 *   the same page can score differently on two runs with nothing about the site
 *   having changed, so the reader is told to try again AND told that the coverage
 *   was incomplete. Silently averaging over it is how a number lies by omission.
 *
 * Not called "unknown": `checkAiBotAccess` already uses that word for a status that
 * conflates a 404 with no body, a 5xx with no body, and a timeout. Reusing it would
 * inherit the confusion instead of replacing it.
 */
export type ScoreStatus = "not-applicable" | "not-evaluated";

/**
 * The arithmetic of a check, without its wording.
 *
 * `tally` needs only these fields, so it asks for only these. The four scoring
 * modules each name their label differently — `label`, `name`, `signal`,
 * `header` — and forcing them onto one word would have meant rewriting four
 * stored Section shapes to change nothing that matters. What has to agree is
 * what the numbers mean.
 */
export interface Scorable {
  /**
   * Whether the check succeeded, for the all-or-nothing case.
   *
   * A check states either this or `earned`. Optional because a partial-credit
   * check has nothing useful to put here: "did the page pass Depth of detail?"
   * has no answer when the award is 3 for length plus 2 for code plus 1 for
   * diagrams.
   */
  passed?: boolean;
  /**
   * What the check is WORTH. Never what it earned.
   *
   * The single most important line in this file: `points` is the ceiling. A
   * check that awards partial credit sets `earned` as well.
   */
  points: number;
  /**
   * Points actually earned, when a check awards partial credit.
   *
   * Absent means all-or-nothing: `passed` decides between `points` and zero.
   */
  earned?: number;
  detail?: string;
  /**
   * Set when this check produced no answer, saying which kind of no-answer it was.
   *
   * Absent means the check ran and `passed`/`earned` mean what they say. Present
   * means the check is **out of the fraction entirely** — `tally` counts it in
   * neither the score nor the maximum — so a page is only ever measured against
   * what it could actually be measured on.
   *
   * This replaces a `na?: boolean` that was credited its full points instead, which
   * required every caller to subtract those points from both sides afterwards. One
   * of four did. See the second invariant in this file's header.
   */
  status?: ScoreStatus;
}

/**
 * What this page got, what it could have got, and what was never asked.
 *
 * The last two fields exist so a caller can state its own coverage without walking
 * the list a second time with different rules than `tally` used — which is exactly
 * how the score and the qualifier beside it would drift apart.
 */
export interface Tally {
  /** Earned, over the scorable checks only. */
  score: number;
  /** The ceiling, over the scorable checks only. Excludes anything with a `status`. */
  max: number;
  /** Points belonging to checks that do not apply to this page. */
  notApplicable: number;
  /** Points belonging to checks that could not be evaluated on this run. */
  notEvaluated: number;
}

/**
 * The sentence a check shows when it could not be evaluated.
 *
 * ── Why this exists ──
 *
 * `render-check.ts` was written because four handlers had drifted to five
 * wordings for two states, and it unified the **marks**. Nothing unified the
 * sentence underneath, so the same drift happened again in prose. By #346 there
 * were five templates for one idea:
 *
 *   "Wikidata could not be reached on this run, so this was not scored either way — retry to find out"
 *   "The Knowledge Graph API did not answer on this run, so this was not scored either way — retry to find out"
 *   "${reason} — not scored either way; retry"
 *   "${reason} — not scored either way; retry, or check that /robots.txt is reachable"
 *   "Not scored: ${reason}"
 *
 * and three more arrived with #344–#346. A reader comparing a GEO report against
 * an E-E-A-T one meets two vocabularies for the same fact.
 *
 * ── What it fixes beyond consistency ──
 *
 * Four of those five never said the thing that matters most: **this is not a
 * finding about your page**. A customer reading "not scored either way" beside a
 * row of red crosses reads it as another shortcoming of theirs. It is a
 * shortcoming of ours, or of a third party's uptime, and the sentence has to say
 * so or the distinction the whole `ScoreStatus` machinery buys is lost at the
 * last inch.
 *
 * ── What is deliberately not here ──
 *
 * The check object. `GeoCheck` says `label`, `AiVisibilityCheck` says `name`,
 * `EeatIndicator` says `signal` and spells its detail `details` — so a builder
 * returning a spreadable fragment would need a parameter per field name, which
 * is an interface as wide as the call sites it replaces, and renaming them would
 * rewrite four stored Section shapes to change nothing that matters. Same
 * reasoning, same conclusion, as `render-check.ts`: the words travel, the object
 * does not.
 *
 * The `status` field is not here either, and does not need to be. It has two
 * possible values and the compiler checks both; it cannot drift. Prose can.
 *
 * `hint` is for the cases where there IS something the reader can do — checking
 * that `/robots.txt` is reachable, say. Most of the time there is not, and the
 * default says the honest thing instead of inventing an action.
 */
export function notScored(reason: string, hint = "try again"): string {
  return `Not scored: ${reason}. This is not a finding about the page — ${hint}.`;
}

/**
 * Points earned by one check: its own `earned`, or all-or-nothing on `passed`.
 *
 * Only meaningful for a check with no `status`. It used to return full points for
 * `na: true`, which is the line that made forgetting to normalize silent; the
 * decision now lives in `tally`, where it cannot be bypassed.
 */
export function earnedBy(check: Scorable): number {
  return check.earned ?? (check.passed ? check.points : 0);
}

/**
 * Add up a list of checks.
 *
 * The only way to get a total. Every number comes from one walk of one list, so
 * there is no second place for any of them to be written down and no way for them
 * to disagree — including the two that are not in the fraction.
 */
export function tally(checks: readonly Scorable[]): Tally {
  let score = 0;
  let max = 0;
  let notApplicable = 0;
  let notEvaluated = 0;

  for (const check of checks) {
    // A `status` takes the check out of both sides. Deliberately not a `continue`
    // after adding to `max`: a maximum that includes a question we never asked is
    // the bug this whole file's second invariant exists to prevent.
    if (check.status === "not-applicable") {
      notApplicable += check.points;
      continue;
    }
    if (check.status === "not-evaluated") {
      notEvaluated += check.points;
      continue;
    }
    score += earnedBy(check);
    max += check.points;
  }

  return { score, max, notApplicable, notEvaluated };
}
