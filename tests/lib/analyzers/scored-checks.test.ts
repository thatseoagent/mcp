import { describe, expect, it } from "vitest";
import { tally, earnedBy } from "@/lib/analyzers/scored-checks";

describe("what a check earns", () => {
  it("gives a passing all-or-nothing check its full points", () => {
    expect(earnedBy({ passed: true, points: 7 })).toBe(7);
  });

  it("gives a failing one nothing", () => {
    expect(earnedBy({ passed: false, points: 7 })).toBe(0);
  });

  it("prefers an explicit partial award over pass or fail", () => {
    expect(earnedBy({ passed: true, points: 10, earned: 3 })).toBe(3);
    expect(earnedBy({ passed: false, points: 10, earned: 3 })).toBe(3);
  });

  /**
   * `earnedBy` no longer has an opinion about a check with no answer, and this test
   * is the inverse of the one it replaces.
   *
   * It used to assert that `na: true` earned its full points, which is the line that
   * made forgetting to normalize silent: a caller who summed `earnedBy` and never
   * subtracted those points back off both sides inflated the score, and three of the
   * four callers were one `na` away from doing exactly that (#337). The decision now
   * lives in `tally`, which never asks `earnedBy` about a check carrying a `status`.
   * If anything ever routes around `tally` and calls this directly, a check with no
   * answer must read as zero rather than as full marks — a lie that flatters is still
   * a lie.
   */
  it("gives a check with no answer nothing, because it is not `tally`'s job to ask", () => {
    expect(earnedBy({ passed: false, points: 5, status: "not-applicable" })).toBe(0);
    expect(earnedBy({ passed: false, points: 5, status: "not-evaluated" })).toBe(0);
  });
});

describe("adding checks up", () => {
  /**
   * The bug this module exists to make impossible. `scoreL1` declared
   * `const MAX = 40` and kept it after a check dropped to zero points, so a
   * flawless site reached 33 of a stated 40 and every grade came out a tier low.
   * Both halves now come from the same list.
   */
  it("takes the maximum from the same list as the score", () => {
    const checks = [
      { passed: true, points: 7 },
      { passed: false, points: 6 },
      { passed: true, points: 0 }, // a check that was demoted to informational
    ];

    expect(tally(checks)).toEqual({ score: 7, max: 13, notApplicable: 0, notEvaluated: 0 });
  });

  it("cannot report a score above its own maximum", () => {
    const checks = [
      { passed: true, points: 5 },
      { passed: true, points: 5, earned: 5 },
    ];
    const { score, max } = tally(checks);
    expect(score).toBeLessThanOrEqual(max);
  });

  it("counts partial credit in the score and the full award in the maximum", () => {
    expect(tally([{ passed: true, points: 10, earned: 4 }]))
      .toEqual({ score: 4, max: 10, notApplicable: 0, notEvaluated: 0 });
  });

  it("is zero for no checks, rather than dividing by nothing later", () => {
    expect(tally([])).toEqual({ score: 0, max: 0, notApplicable: 0, notEvaluated: 0 });
  });
});

describe("checks with no answer are out of the fraction, without anyone subtracting", () => {
  /**
   * The enforcement this whole change exists for.
   *
   * The predecessor of this test performed the subtraction **in its own body** and
   * therefore proved only that the arithmetic worked, not that any caller did it.
   * One of four did. These assert the property directly on the primitive's output,
   * so there is nothing a caller could forget.
   */
  it("leaves an inapplicable check out of the score and out of the maximum", () => {
    const { score, max, notApplicable } = tally([
      { passed: true, points: 4 },
      { passed: false, points: 6, status: "not-applicable" },
    ]);

    // 4 of 4, rather than 10/10 (flattering) or 4/10 (punishing a page for a check
    // nobody ran). Both were reachable from the old primitive.
    expect(score).toBe(4);
    expect(max).toBe(4);
    // Still reported, because the report has to say so in words.
    expect(notApplicable).toBe(6);
  });

  it("leaves an unevaluated check out of both sides too, and counts it separately", () => {
    const { score, max, notApplicable, notEvaluated } = tally([
      { passed: true, points: 4 },
      { passed: false, points: 8, status: "not-evaluated" },
    ]);

    expect(score).toBe(4);
    expect(max).toBe(4);
    // Kept apart from `notApplicable` on purpose: an inapplicable check is settled,
    // an unevaluated one means the next run may score differently with nothing about
    // the page having changed, and the reader is owed that distinction.
    expect(notApplicable).toBe(0);
    expect(notEvaluated).toBe(8);
  });

  it("does not credit a check that says both `passed: true` and a status", () => {
    // `naCheck()` in `geo-analyzer` builds exactly this shape — `passed: true` so the
    // old renderer would not print a red cross beside it. Under the old `earnedBy`
    // the `passed` was load-bearing; here it must be inert, or the shape that exists
    // at sixteen call sites quietly earns its points back.
    expect(tally([{ passed: true, points: 15, status: "not-applicable" }]))
      .toEqual({ score: 0, max: 0, notApplicable: 15, notEvaluated: 0 });
  });

  it("reports 0/0 rather than a percentage when nothing could be scored", () => {
    // The all-N/A page. `tally` returning `max: 0` is what lets `computeGeoScore`
    // report "Not assessable" instead of handing the report's worst grade to the one
    // input we simply failed to measure.
    const { score, max } = tally([
      { passed: true, points: 10, status: "not-applicable" },
      { passed: false, points: 5, status: "not-evaluated" },
    ]);
    expect(score).toBe(0);
    expect(max).toBe(0);
  });
});

// The security-header ceilings this file also pinned moved out with
// `security-analyzer`, which is not part of this Tool group. They belong with it
// wherever it lands.

// ── The belt, worn with the braces ───────────────────────────────────────────

/**
 * `tally` is now the only place that decides what a check with no answer is worth,
 * and the tests above assert it decides correctly. This one asserts nobody routes
 * around it.
 *
 * A source-level check rather than a behavioural one because the failure it guards
 * is a *new* call site, which no amount of testing existing behaviour can catch: a
 * module that sums `earnedBy` itself gets the pre-#337 arithmetic back, silently and
 * with every other test still green. That is exactly how the requirement documented
 * in a doc comment came to be honoured by one caller out of four.
 */
describe("nobody adds checks up except `tally`", () => {
  it("is the only module that calls `earnedBy`", async () => {
    const { readdir, readFile } = await import("node:fs/promises");
    const dir = new URL("../../../src/lib/analyzers/", import.meta.url);
    const files = (await readdir(dir)).filter((f) => f.endsWith(".ts") && f !== "scored-checks.ts");

    const offenders: string[] = [];
    for (const file of files) {
      const src = await readFile(new URL(file, dir), "utf8");
      if (/\bearnedBy\s*\(/.test(src)) offenders.push(file);
    }

    // If this fails, the fix is to call `tally` on the list, not to add the file
    // here. `earnedBy` answers "what did this check earn" and has no opinion about
    // checks that earned nothing because they never ran — that opinion lives one
    // level up, on purpose.
    expect(offenders).toEqual([]);
  });
});
