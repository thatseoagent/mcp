import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { capped, withheld } from "@/lib/render-list";

/**
 * The invariant this file exists to keep: **a truncated list says what it left
 * out, and says it in one wording.**
 *
 * Twenty-three sites wrote the sentence themselves, in twenty-three wordings, six
 * of them restating the cap as a literal beside the `slice` that already had it.
 * `crawl-site.ts` had the argument written down — "the withheld count is always
 * printed so a truncated list never reads as a complete one" — inside a private
 * function only it could call, so the invariant held in one file and drifted in
 * another: `gsc_inspect_url` printed ten referring URLs with no count, and a
 * reader could not tell whether Google reported ten or three hundred.
 *
 * The sweep at the bottom is the part that makes this stick. A property test over
 * `withheld` proves the function is right; only the sweep catches the next site
 * that does not call it.
 */

describe("the withheld line", () => {
  it("says nothing when nothing was withheld", () => {
    expect(withheld(3, 10)).toEqual([]);
    // Exactly at the cap is a complete list, not a truncated one.
    expect(withheld(10, 10)).toEqual([]);
    expect(withheld(0, 10)).toEqual([]);
  });

  it("counts what was left out, not what was shown", () => {
    // `length - cap` written at a call site is where a mismatched cap hides.
    expect(withheld(30, 10)).toEqual(["  ... and 20 more."]);
    expect(withheld(11, 10)).toEqual(["  ... and 1 more."]);
  });

  it("names the rows where a Tool prints two lists at once", () => {
    expect(withheld(30, 10, { noun: "queries" })).toEqual(["  ... and 20 more queries."]);
    expect(withheld(30, 10, { noun: "pages" })).toEqual(["  ... and 20 more pages."]);
  });

  it("carries an action only where there is one", () => {
    expect(withheld(30, 10, { hint: "Pass `search` to narrow this down." })).toEqual([
      "  ... and 20 more. Pass `search` to narrow this down.",
    ]);
    // Most lists have no action, and inventing one is worse than saying nothing.
    expect(withheld(30, 10)[0]).not.toContain("Pass");
  });

  it("takes the indent from the caller, because a section indents and a list does not", () => {
    expect(withheld(30, 10, { indent: "" })).toEqual(["... and 20 more."]);
    expect(withheld(30, 10)).toEqual(["  ... and 20 more."]);
  });
});

describe("a capped list", () => {
  const rows = Array.from({ length: 30 }, (_, i) => `row${i}`);

  it("prints the cap and then says what it withheld", () => {
    const lines = capped(rows, 3);

    expect(lines).toEqual(["  row0", "  row1", "  row2", "  ... and 27 more."]);
  });

  it("prints everything and says nothing when the list fits", () => {
    expect(capped(["a", "b"], 10)).toEqual(["  a", "  b"]);
  });

  it("prints nothing at all for an empty list", () => {
    expect(capped([], 10)).toEqual([]);
  });
});

/**
 * Nobody writes this sentence but `render-list.ts`.
 *
 * Matched on the shape rather than on a list of known sites, which is the whole
 * point: a new Tool hand-writing its own truncation notice looks exactly like the
 * twenty-three that did, and that is what has to be caught.
 */
describe("the sentence lives in one place", () => {
  const root = process.cwd();
  const OWNER = path.join("src", "lib", "render-list.ts");

  /** Every `.ts` under `src/`, with its repo-relative path. */
  function sources(dir: string): Array<{ file: string; source: string }> {
    const found: Array<{ file: string; source: string }> = [];
    for (const entry of readdirSync(dir)) {
      const full = path.join(dir, entry);
      if (statSync(full).isDirectory()) {
        found.push(...sources(full));
      } else if (entry.endsWith(".ts")) {
        found.push({ file: path.relative(root, full), source: readFileSync(full, "utf8") });
      }
    }
    return found;
  }

  /**
   * A hand-written truncation notice: `and ${…} more`, in a template literal.
   *
   * Deliberately narrow. The two remaining `(and N more)` forms in
   * `onpage-seo.ts` and `agent-api-surface.ts` are a clause inside a sentence
   * about one finding, not a list being cut, and folding those in would mean
   * naming a cap that does not exist.
   */
  const HAND_WRITTEN = /\.\.\.\s*and \$\{/;

  it("is not hand-written anywhere else in src/", () => {
    const offenders = sources(path.join(root, "src"))
      .filter(({ file }) => file !== OWNER)
      .filter(({ source }) => HAND_WRITTEN.test(source))
      .map(({ file }) => file);

    expect(offenders).toEqual([]);
  });

  it("is what `render-list.ts` itself writes, so the sweep is looking for the right thing", () => {
    // Guards against the sweep quietly passing because the pattern stopped
    // matching the real sentence.
    expect(HAND_WRITTEN.test(withheld(30, 10)[0])).toBe(false);
    expect(withheld(30, 10)[0]).toContain("... and 20 more");
  });
});
