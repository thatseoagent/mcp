import { describe, expect, it } from "vitest";
import { renderVerdict } from "@/lib/render-check";

/**
 * Four tool handlers each decided this for themselves while #337 was landing, and
 * ended with five wordings for two states: `n/a`, `not run`, `Not applicable`,
 * `not evaluated`, `Not evaluated`. These pin the two that survived.
 */
describe("the two no-answer states do not share a mark", () => {
  it("marks a check the page does not owe with – and n/a", () => {
    expect(renderVerdict({ status: "not-applicable", passed: true, points: 10 }))
      .toEqual({ mark: "–", words: "n/a" });
  });

  it("marks a check we could not evaluate with ? and not run", () => {
    expect(renderVerdict({ status: "not-evaluated", passed: false, points: 8 }))
      .toEqual({ mark: "?", words: "not run" });
  });

  it("does not let a `passed: true` under a status leak a tick", () => {
    // `naCheck()` in `geo-analyzer` builds exactly this shape, so the old renderers
    // all had to remember to test `status` before `passed`. Here it is structural.
    expect(renderVerdict({ status: "not-applicable", passed: true, points: 15 }).mark).toBe("–");
  });
});

describe("a check with an answer keeps its own figures", () => {
  it("returns null words so the caller formats them", () => {
    // geo prints `(5 pts)`, eeat prints `(3/5 pts)`, security prints
    // `Present (5/20)`. Those were never one decision and are not pulled in here.
    expect(renderVerdict({ passed: true, points: 5 })).toEqual({ mark: "✓", words: null });
    expect(renderVerdict({ passed: false, points: 5 })).toEqual({ mark: "✗", words: null });
  });
});

describe("the mark comes from what was earned, not from a separate boolean", () => {
  it("gives partial credit a mark of its own", () => {
    // `✗ Before/after evidence (3/5 pts)` — a red cross above a majority score. The
    // indicator set `found` at two keywords and `earned` at one, and the tick was
    // taken from `found` (#341). Rendering it as a tick would hide what is missing;
    // as a cross, what is there.
    expect(renderVerdict({ passed: false, earned: 3, points: 5 })).toEqual({ mark: "~", words: null });
    expect(renderVerdict({ passed: true, earned: 3, points: 5 })).toEqual({ mark: "~", words: null });
  });

  it("keeps the tick and the cross for the ends of the range", () => {
    expect(renderVerdict({ passed: false, earned: 5, points: 5 })).toEqual({ mark: "✓", words: null });
    expect(renderVerdict({ passed: true, earned: 0, points: 5 })).toEqual({ mark: "✗", words: null });
  });

  it("falls back to the check's own verdict when there is nothing to divide", () => {
    // The informational checks: llms.txt, and E-E-A-T's before/after evidence. A
    // 0-point check has no fraction, so `earned >= points` would tick every one.
    expect(renderVerdict({ passed: true, earned: 0, points: 0 })).toEqual({ mark: "✓", words: null });
    expect(renderVerdict({ passed: false, earned: 0, points: 0 })).toEqual({ mark: "✗", words: null });
  });
});

describe("the four fields are what a caller can supply without an adapter", () => {
  it("accepts a SecurityCheck's own field names at the call site", () => {
    // `SecurityCheck` says `score`/`maxScore`, not `earned`/`points`, and renaming
    // those would rewrite a stored shape. This is why the input is four loose fields
    // rather than a `Scorable`.
    const securityCheck = { present: false, score: 0, maxScore: 20, status: undefined };
    const { mark, words } = renderVerdict({
      status: securityCheck.status,
      passed: securityCheck.present,
      earned: securityCheck.score,
      points: securityCheck.maxScore,
    });
    expect(mark).toBe("✗");
    expect(words).toBeNull();
  });
})
