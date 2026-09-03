import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

import {
  scoreStructuredData,
  scoreFreshness,
  scoreContentStructure,
  scoreAiCrawlerAccess,
  scoreAuthorEeat,
  scoreTechnical,
  scoreContentCitability,
  scoreCitationSignals,
  scoreFreshnessSignals,
  scoreQueryOptimization,
} from "@/lib/analyzers/geo-analyzer";
import { LABEL } from "@/lib/analyzers/geo-check-labels";
import type { PageKind } from "@/lib/analyzers/page-identity";
import { page } from "../../helpers/parsed-page";

/**
 * A GEO check's label is a key, and nothing was holding the copies together.
 *
 * `buildRecommendations` looks each failing check's recommendation up by its
 * label. So the label is written down three times for many checks — on the
 * `naCheck` branch, on the scoring branch, and as a `labelMap` key — and until
 * `LABEL` existed, nothing made those three agree.
 *
 * Both ways of disagreeing had already happened, and neither was loud:
 *
 *   - **Two labels, one check.** Rewording the scoring branch out of JSON-key
 *     spelling left `naCheck` behind, so `scoreFreshnessSignals` emitted "JSON-LD
 *     states when the page was published or last modified" on an article and
 *     "JSON-LD contains dateModified or datePublished" on a homepage. Same check,
 *     two names, decided by page kind.
 *   - **A key matching no label.** `labelMap` still carries "Person schema with
 *     sameAs links", which no scorer produces. A stale key is not an error and
 *     not a crash: `labelMap[check.label]` is simply `undefined`, the `if` skips,
 *     and the check fails with no advice attached. A missing recommendation looks
 *     exactly like a check that never needed one.
 *
 * This asserts the second direction, which `LABEL` cannot: a constant guarantees
 * the spellings match, not that a key still points at something real.
 */

const GEO_FILE = path.join(process.cwd(), "src/lib/analyzers/geo-analyzer.ts");

/** Every page kind, so a label only emitted on one of them still shows up. */
const PAGE_KINDS: PageKind[] = [
  "homepage",
  "article",
  "product",
  "faq",
  "landing",
  "collection",
  "profile",
  "generic",
];

/**
 * Every label any scorer can produce, on any page kind.
 *
 * Called with empty inputs on purpose: a scorer emits its full set of checks
 * whatever the page contains — that is what makes the maximum stable — so the
 * labels do not depend on the HTML. What they do depend on is the page kind,
 * which is why every kind is swept.
 */
function everyLabel(): Set<string> {
  const labels = new Set<string>();
  const sitemap = { outcome: "absent" as const, status: 404 };
  const robots = { outcome: "absent" as const, status: 404 };

  for (const kind of PAGE_KINDS) {
    const categories = [
      scoreStructuredData([], new Set<string>(), kind),
      scoreFreshness([], sitemap, kind, "https://example.com/"),
      scoreContentStructure(page("<html></html>"), kind),
      scoreAiCrawlerAccess(robots, "<html></html>", false),
      scoreAuthorEeat("<html></html>", [], kind),
      scoreTechnical(page("<html></html>"), 200),
      scoreContentCitability(page("<html></html>"), kind),
      scoreCitationSignals(page("<html></html>"), kind),
      scoreFreshnessSignals("<html></html>", {}, kind),
      scoreQueryOptimization(page("<html></html>"), [], kind),
    ];
    for (const cat of categories) for (const c of cat.checks) labels.add(c.label);
  }

  return labels;
}

/**
 * The `labelMap` keys, read from the source.
 *
 * Read rather than imported because the map is a local inside
 * `buildRecommendations`. Exporting it to make it testable would widen the
 * module's surface to satisfy a test, and the keys are the one thing about it a
 * regex can read without ambiguity: `LABEL.x` for the deduplicated ones and a
 * quoted literal for the rest.
 */
function labelMapKeys(): { viaConstant: string[]; viaLiteral: string[] } {
  const src = readFileSync(GEO_FILE, "utf8");
  const start = src.indexOf("const labelMap: Record<string, string> = {");
  expect(start, "labelMap moved or was renamed").toBeGreaterThan(-1);
  const body = src.slice(start, src.indexOf("\n  };", start));

  const viaConstant = [...body.matchAll(/^\s{4}\[LABEL\.(\w+)\]:/gm)].map((m) => m[1]);
  const viaLiteral = [...body.matchAll(/^\s{4}"((?:[^"\\]|\\.)*)":/gm)].map((m) =>
    m[1].replace(/\\"/g, '"')
  );
  return { viaConstant, viaLiteral };
}

describe("GEO recommendation keys point at labels that exist", () => {
  it("finds labels and keys to compare at all", () => {
    // Guards both readers. Either one silently returning nothing would make the
    // assertions below pass by having nothing to check, which is the same kind of
    // silence as the drift.
    expect(everyLabel().size).toBeGreaterThan(25);
    const { viaConstant, viaLiteral } = labelMapKeys();
    expect(viaConstant.length + viaLiteral.length).toBeGreaterThan(20);
  });

  it("has no recommendation keyed to a label no scorer produces", () => {
    const labels = everyLabel();
    const stale = labelMapKeys().viaLiteral.filter((k) => !labels.has(k));

    expect(
      stale,
      `These labelMap keys match no label any scorer emits, so the recommendation ` +
        `can never be reached and the check fails with no advice: ${stale.join(" | ")}. ` +
        `Fix the key, or delete the entry if the check is gone.`
    ).toEqual([]);
  });

  it("emits one label per check, whatever the page kind", () => {
    // The first direction of drift, asserted on the checks that actually had it:
    // a not-applicable branch and a scoring branch describing the same check.
    // Both spellings would appear in `everyLabel()`, one per kind.
    const labels = everyLabel();
    for (const stale of [
      "JSON-LD contains dateModified or datePublished",
      "article:modified_time or article:published_time meta tag",
      "dateModified within 90 days (10 pts) or 180 days (5 pts)",
      "Sitemap lastmod consistent with dateModified (±7 days)",
      "Article schema with author + datePublished + dateModified",
      "Person schema with sameAs or jobTitle",
    ]) {
      expect(labels.has(stale), `"${stale}" is still emitted on some page kind`).toBe(false);
    }
  });

  it("keeps JSON-key spelling out of the labels a client reads", () => {
    // The labels are prose now. A camelCase identifier here means a scorer is
    // showing a reader the name of a field in our code.
    const leaks = [...everyLabel()].filter((l) => /\b[a-z]+[A-Z][a-zA-Z]*\b/.test(l));

    expect(
      leaks,
      `These labels name a code identifier rather than the thing it holds: ` +
        `${leaks.join(" | ")}. Say it in prose; name the literal field in the ` +
        `recommendation, where the reader is being told what to edit.`
    ).toEqual([]);
  });
  it("keys each label once, so no entry can be shadowed by a later one", () => {
    // The real shape of the defect, and the one `tsc` cannot see. Three labels had
    // two entries each with different advice; the last key wins in an object
    // literal, so the reachable text was whichever copy sat lower in the file.
    // `tsc` rejects two identical string keys, but not a `[LABEL.x]` computed key
    // colliding with a literal of the same value.
    // `LABEL` is imported, not scraped. It used to be read back out of
    // `geo-analyzer.ts` with a regex, and when the table moved to its own module
    // that regex quietly matched nothing: every `[LABEL.x]` key resolved to the
    // *identifier* `"x"`, which can never equal a prose literal, so this test
    // stopped being able to see the collision it exists for and stayed green.
    const { viaConstant, viaLiteral } = labelMapKeys();
    expect(viaConstant.every((name) => name in LABEL), "labelMap names a LABEL key that does not exist").toBe(true);
    const resolved = [
      ...viaConstant.map((name) => LABEL[name as keyof typeof LABEL]),
      ...viaLiteral,
    ];

    const seen = new Set<string>();
    const dupes = resolved.filter((key) => {
      if (seen.has(key)) return true;
      seen.add(key);
      return false;
    });

    expect(
      dupes,
      `These labels are keyed twice in labelMap, so one entry's advice is ` +
        `unreachable: ${dupes.join(" | ")}. Keep one.`
    ).toEqual([]);
  });
});
