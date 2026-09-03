/**
 * The sentence a truncated list owes the reader.
 *
 * ── Why this exists ──
 *
 * Every Tool that prints a long list caps it, and every one of them wrote the
 * cap's consequence out by hand: `if (rows.length > CAP) lines.push(\`... and
 * ${rows.length - CAP} more\`)`. Twenty-three sites, twenty-three wordings, six
 * of which restated the cap as a literal beside the `slice` that already had it.
 *
 * `crawl-site.ts` had the argument written down — "the withheld count is always
 * printed so a truncated list never reads as a complete one" — inside a private
 * function only it could call. So the invariant held in one file and drifted in
 * another: `gsc_inspect_url` printed ten referring URLs under "HOW GOOGLE REACHED
 * IT" with no count at all, and a reader could not tell whether Google reported
 * ten or three hundred.
 *
 * The failure is the same one `scored-checks.ts` and `renderCoverage` exist to
 * prevent, one layer out: **a partial answer presented as a whole one.** A
 * truncated list read as complete is a finding about a site we did not look at.
 *
 * ── What is deliberately not here ──
 *
 * The rows. Each Tool formats its own — a query with its clicks, a URL with its
 * status, a heading with its level — and folding those together would be an
 * interface as wide as the call sites it replaced. This owns the arithmetic and
 * the sentence, which is the part that has to agree everywhere.
 */

export interface WithheldOptions {
  /**
   * What the withheld rows are, for the sentence: "and 12 more queries".
   *
   * Optional because most lists are unambiguous under their own heading. Where
   * a Tool prints two lists at once, naming them is the difference between a
   * reader knowing which was cut and guessing.
   */
  noun?: string;
  /**
   * What the reader can do about it, where there is something.
   *
   * `ga4_metadata` can say "Pass `search` to narrow this down", because it can.
   * Most cannot, and inventing an action is worse than saying nothing.
   */
  hint?: string;
  /** Prefix for the line. Sections indent their rows; a bare list usually does not. */
  indent?: string;
}

/**
 * The line naming what a capped list left out, or nothing when it left nothing.
 *
 * @param total how many rows there are. The caller passes the *full* count, not
 *        the shown one — the arithmetic is this function's, because
 *        `length - CAP` written at the call site is where a mismatched cap hides.
 * @param cap how many were printed.
 */
export function withheld(
  total: number,
  cap: number,
  { noun, hint, indent = "  " }: WithheldOptions = {},
): string[] {
  if (total <= cap) return [];

  const subject = noun ? ` more ${noun}` : " more";
  const action = hint ? ` ${hint}` : "";
  return [`${indent}... and ${total - cap}${subject}.${action}`];
}

/**
 * A capped list's rows and its withheld line together.
 *
 * For the common shape, where the caller has already turned its data into
 * strings. A caller whose rows need per-row logic slices itself and calls
 * {@link withheld}.
 */
export function capped(
  rows: readonly string[],
  cap: number,
  options: WithheldOptions = {},
): string[] {
  const indent = options.indent ?? "  ";
  return [
    ...rows.slice(0, cap).map((row) => `${indent}${row}`),
    ...withheld(rows.length, cap, options),
  ];
}
