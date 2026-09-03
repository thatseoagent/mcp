import { earnedBy, type ScoreStatus } from "./analyzers/scored-checks";

/**
 * The mark beside a check, and the words that replace its figures when it has none.
 *
 * ── Why this exists ──
 *
 * Four tool handlers each decided this for themselves while #337 was landing, and by
 * the end they had **five wordings for two states**: `n/a` (7 uses), `not run` (6),
 * `Not applicable` (3), `not evaluated` (2), `Not evaluated` (1). A reader comparing
 * a GEO report against a security one sees two vocabularies for the same fact, and
 * every new handler adds a sixth. That is what happens when a decision lives at four
 * call sites: it does not stay the same decision.
 *
 * ── What is deliberately not here ──
 *
 * The figures. `geo` prints `(5 pts)`, `eeat` prints `(3/5 pts)`, `security` prints
 * `Present (5/20)`, and those differ because the tools differ — they were never one
 * decision and pulling them in would mean a parameter per format, which is an
 * interface as wide as the four implementations it replaced. `words` is `null` for a
 * check that has figures, and the caller formats its own.
 *
 * The label is not here either, for the same reason: `geo` runs it through
 * `describeCheck` for provenance, `eeat` uses a signal name, `security` puts the
 * header first and the verdict after a colon.
 *
 * And it does not cross into `components/report/**`. `CheckRow` draws its marks as
 * SVG for accessibility rather than printing a glyph, and normalises the pre-#337
 * `na` boolean out of frozen snapshots. ADR-0014 keeps that guard at the reader; a
 * module spanning MCP text and TSX would contradict it.
 */

/**
 * The minimum a mark depends on.
 *
 * Four fields rather than `Scorable`, because `SecurityCheck` is not one — it says
 * `score`/`maxScore` where `Scorable` says `earned`/`points`, and renaming those
 * would rewrite a stored shape to change nothing that matters. Every caller can
 * supply this with a literal at the call site, so there is no adapter and no
 * intermediate type.
 */
export interface CheckVerdict {
  status?: ScoreStatus;
  passed: boolean;
  earned?: number;
  points: number;
}

/**
 * `words` is `null` when the check has an answer, and the caller prints its figures.
 */
export interface RenderedVerdict {
  mark: "✓" | "✗" | "~" | "–" | "?";
  words: "n/a" | "not run" | null;
}

/**
 * `–` and `n/a` for a check this page does not owe. `?` and `not run` for one we
 * could not evaluate.
 *
 * The two states do not share a mark, and that is the point of having two states: the
 * first is settled and needs nothing from the reader, the second is worth a retry and
 * means this run is not comparable to the last one. A reader given the same grey mark
 * for both cannot tell which they are looking at.
 *
 * These two wordings won on usage rather than on taste — they were already the most
 * common of the five, and already what `CheckRow` shows on the report side.
 */
export function renderVerdict(check: CheckVerdict): RenderedVerdict {
  if (check.status === "not-applicable") return { mark: "–", words: "n/a" };
  if (check.status === "not-evaluated") return { mark: "?", words: "not run" };

  // A check worth nothing has no fraction to read, so its own verdict is all there
  // is. The informational checks — llms.txt, before/after evidence — are these.
  if (check.points === 0) return { mark: check.passed ? "✓" : "✗", words: null };

  // `earned`, not `passed`. The two disagree wherever a check awards partial credit,
  // and the tick was taken from `passed`: E-E-A-T's before/after indicator set
  // `found` at two keywords and `earned` at one, so a page printed
  // `✗ Before/after evidence (3/5 pts)` — a red cross above a majority score (#341).
  //
  // Three outcomes rather than two, because a check that earned some of its points
  // is neither. Rendering partial credit as either a tick or a cross is the same
  // misreport in opposite directions: the first hides what is missing, the second
  // hides what is there.
  const earned = earnedBy(check);
  if (earned >= check.points) return { mark: "✓", words: null };
  if (earned <= 0) return { mark: "✗", words: null };
  return { mark: "~", words: null };
}
