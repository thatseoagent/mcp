import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { BASIS_HEADING, basisSection, notCheckedSection } from "@/lib/render-basis";

/**
 * The invariant this file exists to keep: **what an answer rests on, and what
 * it could not check, have one heading each, and only `render-basis.ts` writes
 * them.**
 *
 * Before it, Search Console's Tools closed under `WHAT THIS IS BASED ON` because
 * a shared footer wrote it for them, and every other Tool chose its own words
 * for the same two sections: `WHAT WAS READ`, `HOW THIS WAS READ`, `WHAT THIS
 * IS`, `COVERAGE`, `WHAT WAS SAMPLED`, `WHAT THIS DOES NOT SEE`, `NOTE`, and
 * for "could not check" `NOT EVALUATED`, `NOT MEASURED` and a heading that
 * carried its reason in it. An agent that learns where the honesty lives from
 * the headings misses whichever one it has not seen yet.
 *
 * ── Why the source, and not the output ──
 *
 * Running every Tool is not practical here: most need a Google fake, a served
 * site or a database, and `every-google-tool.test.ts`, which does run the
 * Google ones, runs them on an empty window — where most of these sections
 * never print, because there is nothing to have skipped. A heading is a string
 * literal in a Tool's source whichever branch prints it, so the source is where
 * every branch can be seen at once. The cost is that a heading assembled from
 * parts would slip past; none is, and `=== ${title} ===` headings are titles of
 * findings, not of these sections.
 *
 * Table-driven over the directory rather than a list, for the reason
 * `every-google-tool.test.ts` gives: a Tool added tomorrow is covered the day
 * its file lands.
 */

const root = process.cwd();
const OWNER = path.join("src", "lib", "render-basis.ts");

/** Every `.ts` under `dir`, with its repo-relative path. */
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
 * A section heading as it is written in source: `=== ` just inside a string,
 * after an optional `\n`. Comments that name a retired heading in passing — as
 * this one does — are not strings and do not match.
 */
const heading = (name: string) => new RegExp(`["'\`](?:\\\\n)*=== ${name}`);

/**
 * The retired names for the basis and not-checked sections.
 *
 * `WHAT THIS IS`, `COVERAGE` and `NOTE` are matched only as whole headings:
 * `WHAT THIS IS FOR` is guidance, and `COVERAGE` inside a longer heading is a
 * title of findings.
 */
const RETIRED: Array<[string, RegExp]> = [
  ["WHAT WAS READ", heading("WHAT WAS READ")],
  ["HOW THIS WAS READ", heading("HOW THIS WAS READ")],
  ["WHAT THIS IS", heading("WHAT THIS IS ===")],
  ["WHAT WAS SAMPLED", heading("WHAT WAS SAMPLED")],
  ["WHAT THIS DOES NOT SEE", heading("WHAT THIS DOES NOT SEE")],
  ["COVERAGE", heading("COVERAGE ===")],
  ["PAGES READ", heading("PAGES READ")],
  ["HOW URLS WERE MATCHED", heading("HOW URLS WERE MATCHED")],
  ["HOW COUNTRIES WERE PAIRED", heading("HOW COUNTRIES WERE PAIRED")],
  ["HOW THIS WAS DECIDED", heading("HOW THIS WAS DECIDED")],
  ["NOTE", heading("NOTE ===")],
  ["NOT MEASURED", heading("NOT MEASURED")],
  ["NOT EVALUATED", heading("NOT EVALUATED")],
];

/** The two headings `render-basis.ts` owns. Written anywhere else, they can drift from it. */
const OWNED: Array<[string, RegExp]> = [
  ["WHAT THIS IS BASED ON", heading("WHAT THIS IS BASED ON")],
  ["NOT CHECKED", heading("NOT CHECKED")],
];

/**
 * The loop that printed GA4's caveats by hand, seven times, one of them twice
 * over the same report. A caveat is a `Basis` caveat now.
 */
const CAVEAT_LOOP = /Note[^`"'\n]*: \$\{caveat\}/;

/** Which of the above a source commits, by name, so a failure says which heading came back. */
function offences(source: string): string[] {
  return [
    ...RETIRED.filter(([, pattern]) => pattern.test(source)).map(([name]) => `retired heading ${name}`),
    ...OWNED.filter(([, pattern]) => pattern.test(source)).map(([name]) => `hand-written ${name}`),
    ...(CAVEAT_LOOP.test(source) ? ["hand-written caveat loop"] : []),
  ];
}

const TOOLS = sources(path.join(root, "src", "tools"));
/** The modules Tools render through, which wrote `WHAT WAS SAMPLED` and `WHAT THIS IS BASED ON` for them. */
const RENDERERS = sources(path.join(root, "src", "lib")).filter(({ file }) => file !== OWNER);

describe("the basis and not-checked headings", () => {
  it("are looked for in every Tool", () => {
    // The guard on the guard: a directory read that found nothing would pass
    // every case below by iterating an empty list.
    expect(TOOLS.length).toBeGreaterThanOrEqual(60);
    expect(RENDERERS.length).toBeGreaterThanOrEqual(60);
  });

  it.each(TOOLS)("$file prints no retired heading, and leaves the owned ones to render-basis", ({ source }) => {
    expect(offences(source)).toEqual([]);
  });

  it("are not written by any module a Tool renders through, either", () => {
    const offenders = RENDERERS.flatMap(({ file, source }) => offences(source).map((name) => `${file}: ${name}`));

    expect(offenders).toEqual([]);
  });

  it("match what render-basis itself writes, so the sweep is looking for the right thing", () => {
    // Guards against the sweep quietly passing because the patterns stopped
    // matching the real headings.
    const owner = readFileSync(path.join(root, OWNER), "utf8");
    for (const [name, pattern] of OWNED) expect(owner, name).toMatch(pattern);

    expect(basisSection({ read: ["x"] })).toContain(BASIS_HEADING);
    expect(notCheckedSection([{ subject: "x", reason: "y" }])).toContain("=== NOT CHECKED (1) ===");
  });
});
