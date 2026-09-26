/**
 * The two sections every Tool owes besides its findings: what the answer is
 * based on, and what it could not check.
 *
 * ── Why this exists ──
 *
 * The rule is CONTEXT.md's: a Tool that cannot do its whole job says so, and a
 * partial result presented as a whole one is the failure worth preventing. Every
 * Tool here already obeyed it in prose, and every one chose its own heading to
 * obey it under. Search Console's Tools shared one footer, `WHAT THIS IS BASED
 * ON`, because `gsc-tool-shape.ts` wrote it for them. The rest said the same
 * thing as `WHAT WAS READ`, `HOW THIS WAS READ`, `WHAT THIS IS`, `COVERAGE`,
 * `WHAT WAS SAMPLED`, `WHAT THIS DOES NOT SEE` or `NOTE`, and GA4's Tools said it
 * as a bare `Note:` line wherever the loop that printed Google's caveats
 * happened to sit — seven loops, one of which printed the caveats twice on an
 * empty report. "Could not check" came in five more wordings: `NOT CHECKED (n)`,
 * `NOT EVALUATED (n)`, `NOT MEASURED`, a trailing "N page(s) could not be read",
 * and a heading that named its reason in the heading.
 *
 * An agent reading a Tool's output learns where the honesty lives from the
 * headings. Fourteen headings for two sections is fourteen things to know, and
 * the next Tool's fifteenth is the one it misses. So each section has one
 * heading, written here and nowhere else — `tests/lib/one-basis-heading.test.ts`
 * holds every Tool's source to that.
 *
 * ── What is deliberately not here ──
 *
 * The sentences. Search Console's personal-query withholding, GA4's sampling,
 * a sitemap read that stopped at its cap, the Wayback Machine's coverage: each
 * is owned by the module that knows it, and arrives here as lines. This owns the
 * heading, the order and the arithmetic, which is the part that has to agree.
 *
 * Guidance, too. `HOW TO READ THIS`, `WHAT TO LOOK FOR`, `READING THESE` and
 * `USING THESE` say what to do with an answer, not what it rests on, and stay
 * where each Tool put them. So does a scored Tool's coverage: points taken out
 * of a denominator are `renderCoverage`'s, a different fact with its own words.
 */
import { withheld } from "./render-list";

/** The one heading an answer's basis is printed under. */
export const BASIS_HEADING = "=== WHAT THIS IS BASED ON ===";

/**
 * What an answer rests on, in three kinds.
 *
 * Kept apart because a reader weighs them differently. `read` is a fact about
 * this run; `caveats` are what the source said about this run's data, and
 * change the meaning of its numbers; `limits` are true of the method whatever
 * the run returned.
 */
export interface Basis {
  /** What was read: rows, pages, files, the sample and how it was drawn, the window. */
  read: readonly string[];
  /** What the source said about this read: sampled, thresholded, truncated, collapsed. */
  caveats?: readonly string[];
  /** What this method cannot see, however the read went. */
  limits?: readonly string[];
}

/**
 * The basis section, or nothing when there is nothing to say.
 *
 * Takes several parts because an answer usually rests on several reads: Search
 * Console's rows, a sample drawn from them, a sitemap, a GA4 report. Each module
 * describes its own read and the Tool hands the parts over together, so the
 * section is one section however many sources fed it. Within each kind, parts
 * keep the order they were given in.
 *
 * Caveats are de-duplicated, because two reads of one property draw the same
 * sentence from Google and printing it twice reads as two problems. `read` and
 * `limits` are not: a line in either is the caller's, and may repeat a word
 * or be blank on purpose.
 */
export function basisSection(...parts: readonly Basis[]): string[] {
  const read = parts.flatMap((part) => part.read);
  const caveats = [...new Set(parts.flatMap((part) => part.caveats ?? []))];
  const limits = parts.flatMap((part) => part.limits ?? []);

  const groups = [read, caveats, limits].filter((group) => group.length > 0);
  if (groups.length === 0) return [];

  const lines = ["", BASIS_HEADING];
  groups.forEach((group, index) => {
    if (index > 0) lines.push("");
    lines.push(...group);
  });
  return lines;
}

/** One thing a Tool set out to check and could not, and why. */
export interface NotChecked {
  /** What was not checked: a URL, a file, a rule, a setting. */
  subject: string;
  /** Why, in words the reader can act on or at least believe. */
  reason: string;
}

export interface NotCheckedOptions {
  /** What the items are, for the withheld line: "and 4 more pages". */
  noun?: string;
  /** How many to list before counting the rest. Default 10. */
  cap?: number;
  /**
   * What their absence does to the answer, printed once under the heading.
   *
   * "These are in no figure above", say. Here rather than at the call site so
   * that it is printed exactly when the section is, which a line pushed after
   * an empty section would not be.
   */
  note?: string;
}

/** How many unchecked items to list before counting the rest, unless a Tool says otherwise. */
const DEFAULT_CAP = 10;

/**
 * What could not be checked, one line each, or nothing when everything was.
 *
 * The count in the heading is the whole count, not the listed one: the cap cuts
 * the lines, never the number, for the reason `render-list.ts` gives. A reader
 * who sees `NOT CHECKED (40)` over ten lines knows the list is not the story.
 */
export function notCheckedSection(
  items: readonly NotChecked[],
  { noun, cap = DEFAULT_CAP, note }: NotCheckedOptions = {},
): string[] {
  if (items.length === 0) return [];

  const lines = ["", `=== NOT CHECKED (${items.length}) ===`];
  if (note) lines.push(note);
  for (const { subject, reason } of items.slice(0, cap)) lines.push(`  ${subject} — ${reason}`);
  lines.push(...withheld(items.length, cap, { noun }));
  return lines;
}
