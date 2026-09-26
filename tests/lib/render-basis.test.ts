import { describe, it, expect } from "vitest";
import { BASIS_HEADING, basisSection, notCheckedSection, type NotChecked } from "@/lib/render-basis";

/**
 * The two sections every Tool owes besides its findings, at their interface.
 *
 * What is pinned is what a Tool relies on without reading this module: an empty
 * section prints nothing at all (not a heading over a blank), the kinds come in
 * one order whatever order the parts arrive in, and a capped list never loses
 * its count. The last is `render-list.ts`'s rule one layer out — a `NOT CHECKED`
 * list read as complete is a finding about pages nobody looked at.
 */

const items = (count: number): NotChecked[] =>
  Array.from({ length: count }, (_, i) => ({ subject: `https://example.com/${i}`, reason: `reason ${i}` }));

/** Whatever went in, none of the values a template literal renders without complaint. */
function expectClean(lines: string[]): void {
  const text = lines.join("\n");
  expect(text).not.toMatch(/\bNaN\b/);
  expect(text).not.toMatch(/\bundefined\b/);
  expect(text).not.toMatch(/\bInfinity\b/);
  expect(text).not.toMatch(/\[object Object\]/);
}

describe("basisSection", () => {
  it("prints nothing when there is nothing to say", () => {
    expect(basisSection()).toEqual([]);
    expect(basisSection({ read: [] })).toEqual([]);
    expect(basisSection({ read: [], caveats: [], limits: [] }, { read: [] })).toEqual([]);
  });

  it("opens with a blank line and the one heading, so a Tool pushes it as it is", () => {
    expect(basisSection({ read: ["12 row(s) from Search Console for this window."] })).toEqual([
      "",
      BASIS_HEADING,
      "12 row(s) from Search Console for this window.",
    ]);
    expect(BASIS_HEADING).toBe("=== WHAT THIS IS BASED ON ===");
  });

  it("prints read, then caveats, then limits, a blank line apart, whatever order the parts came in", () => {
    const lines = basisSection(
      { read: [], limits: ["a limit"] },
      { read: ["what was read"], caveats: ["a caveat"] },
    );

    expect(lines).toEqual(["", BASIS_HEADING, "what was read", "", "a caveat", "", "a limit"]);
  });

  it("keeps each kind in the order its parts were given", () => {
    const lines = basisSection(
      { read: ["rows"], limits: ["first limit"] },
      { read: ["sample"], limits: ["second limit"] },
      { read: ["sitemap"] },
    );

    expect(lines).toEqual(["", BASIS_HEADING, "rows", "sample", "sitemap", "", "first limit", "second limit"]);
  });

  it("does not open a group for a kind nobody supplied", () => {
    // Caveats only: no blank line under the heading for an absent `read`.
    expect(basisSection({ read: [], caveats: ["GA4 sampled this report."] })).toEqual([
      "",
      BASIS_HEADING,
      "GA4 sampled this report.",
    ]);
  });

  it("prints a caveat two reads both drew once, and leaves read and limits as given", () => {
    const lines = basisSection(
      { read: ["same"], caveats: ["thresholded"], limits: ["wrapped", ""] },
      { read: ["same"], caveats: ["thresholded"], limits: ["wrapped", ""] },
    );

    expect(lines.filter((line) => line === "thresholded")).toHaveLength(1);
    expect(lines.filter((line) => line === "same")).toHaveLength(2);
    expect(lines.filter((line) => line === "wrapped")).toHaveLength(2);
  });

  it("renders no value nobody measured", () => {
    expectClean(basisSection({ read: ["0 row(s) from Search Console for this window."], caveats: [], limits: [] }));
  });
});

describe("notCheckedSection", () => {
  it("prints nothing when everything was checked", () => {
    expect(notCheckedSection([])).toEqual([]);
    // The note belongs to the list: no list, no note.
    expect(notCheckedSection([], { note: "These are in no figure above." })).toEqual([]);
  });

  it("names each subject before its reason, under a heading that counts them", () => {
    expect(notCheckedSection([{ subject: "https://example.com/a", reason: "the URL returned HTTP 500" }])).toEqual([
      "",
      "=== NOT CHECKED (1) ===",
      "  https://example.com/a — the URL returned HTTP 500",
    ]);
  });

  it("prints the note once, under the heading and before the list", () => {
    const lines = notCheckedSection(items(2), { note: "These are in no figure above." });

    expect(lines.slice(0, 3)).toEqual(["", "=== NOT CHECKED (2) ===", "These are in no figure above."]);
    expect(lines.filter((line) => line === "These are in no figure above.")).toHaveLength(1);
  });

  it("keeps the order it was given", () => {
    const lines = notCheckedSection(items(3));

    expect(lines.slice(2)).toEqual([
      "  https://example.com/0 — reason 0",
      "  https://example.com/1 — reason 1",
      "  https://example.com/2 — reason 2",
    ]);
  });

  it("caps the lines at ten by default, and never the count", () => {
    const lines = notCheckedSection(items(12), { noun: "pages" });

    expect(lines[1]).toBe("=== NOT CHECKED (12) ===");
    expect(lines.filter((line) => line.includes(" — reason "))).toHaveLength(10);
    expect(lines.at(-1)).toBe("  ... and 2 more pages.");
  });

  it("takes a cap from the Tool, and says nothing extra when the list fits it", () => {
    expect(notCheckedSection(items(5), { cap: 3 }).at(-1)).toBe("  ... and 2 more.");
    expect(notCheckedSection(items(3), { cap: 3 }).join("\n")).not.toContain("more");
    // "List them all" is a cap too, and must not print a count of nothing.
    const all = notCheckedSection(items(40), { cap: Number.POSITIVE_INFINITY });
    expect(all.filter((line) => line.includes(" — reason "))).toHaveLength(40);
    expect(all.join("\n")).not.toContain("more");
  });

  it("renders no value nobody measured, at any cap", () => {
    for (const cap of [0, 1, 10, Number.POSITIVE_INFINITY]) {
      expectClean(notCheckedSection(items(12), { cap, noun: "URLs", note: "A note." }));
    }
  });
});
