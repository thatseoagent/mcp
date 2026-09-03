import { describe, expect, it } from "vitest";
import { answered, textOrEmpty, type WellKnownRead } from "@/lib/well-known";

/**
 * The module exists to keep one distinction, so the tests are about that
 * distinction rather than about HTTP.
 *
 * Two tool handlers read the same three well-known files and disagreed about what a
 * failure meant. The one that got it wrong handed `""` to `scoreAiCrawlerAccess`,
 * where `isBotBlocked("", "GPTBot")` finds no rule and passes — so a robots.txt we
 * never read awarded 13 GEO points across four checks (#337).
 *
 * The status classification itself is `classifyRobotsStatus`, covered in
 * `tests/lib/analyzers/ai-visibility-lookups.test.ts`.
 */

const found: WellKnownRead = { outcome: "found", text: "User-agent: *\nDisallow: /admin", status: 200 };
const absent: WellKnownRead = { outcome: "absent", status: 404 };
const unavailable: WellKnownRead = { outcome: "unavailable", reason: "/robots.txt returned HTTP 503", status: 503 };

describe("an absent file is an answer; an unreadable one is not", () => {
  it("counts both a file and its absence as answered", () => {
    // 404 is load-bearing for robots.txt: no file means no rules, so every crawler
    // really is allowed. A caller may treat this as a pass.
    expect(answered(found)).toBe(true);
    expect(answered(absent)).toBe(true);
  });

  it("does not count an unreadable file as answered", () => {
    expect(answered(unavailable)).toBe(false);
  });
});

describe("textOrEmpty", () => {
  it("gives a parser the bytes when there are bytes", () => {
    expect(textOrEmpty(found)).toContain("Disallow: /admin");
  });

  it("gives a parser an empty string for an absent file", () => {
    // Correct input: no file and an empty file both yield no rules.
    expect(textOrEmpty(absent)).toBe("");
  });

  it("also returns empty for an unavailable read, which is why `answered` exists", () => {
    // This is the collapse the module was written to prevent, and it is deliberately
    // still reachable — a convenience that cannot tell you whether it is safe to use
    // would be no convenience at all. The guard is `answered`, and every caller in
    // the repo checks it first.
    expect(textOrEmpty(unavailable)).toBe("");
    expect(answered(unavailable)).toBe(false);
  });
});

describe("the three outcomes are distinguishable without inspecting HTTP", () => {
  it("carries a reason only when there is no answer", () => {
    // A caller writing a report line needs the reason, and needs it to be absent
    // when there is nothing to explain.
    const reasons = [found, absent, unavailable].map((r) => ("reason" in r ? r.reason : null));
    expect(reasons).toEqual([null, null, "/robots.txt returned HTTP 503"]);
  });

  it("keeps the status on every outcome, for a report that wants to say 404 or 503", () => {
    expect([found.status, absent.status, unavailable.status]).toEqual([200, 404, 503]);
  });
});
