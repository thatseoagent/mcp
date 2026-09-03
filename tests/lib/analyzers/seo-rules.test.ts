import { describe, expect, it } from "vitest";

import {
  evaluatePage,
  asIssueLine,
  asFinding,
  ALL_RULE_IDS,
  TITLE_LIKELY_TRUNCATED,
  type PageFacts,
} from "@/lib/analyzers/seo-rules";

/** A page with nothing wrong, so each test can break exactly one thing. */
const healthy: PageFacts = {
  titleLength: 40,
  descriptionLength: 120,
  h1Count: 1,
  canonical: "https://example.com/",
  viewport: "width=device-width",
  lang: "en",
  imagesTotal: 4,
  imagesMissingAlt: 0,
  contentArrivedInStaticHtml: true,
};

const facts = (over: Partial<PageFacts> = {}): PageFacts => ({ ...healthy, ...over });
const idsFor = (over: Partial<PageFacts> = {}) =>
  evaluatePage(facts(over)).verdicts.map((v) => v.id);

describe("a healthy page", () => {
  it("fires no rule", () => {
    expect(evaluatePage(healthy)).toEqual({ verdicts: [], notEvaluated: [] });
  });
});

/**
 * The guard that had no caller.
 *
 * `needsRenderedContent(verdict)` was exported for a caller to filter with, and
 * none did — so `seo_analyze_page` reported "Missing H1 heading" about React
 * shells, which is a claim about the bytes we were served rather than about the
 * page Google indexes. `evaluatePage` applies it now, and reports what it could
 * not ask rather than dropping it in silence.
 */
describe("a page whose copy did not arrive", () => {
  const shell = facts({ h1Count: 0, contentArrivedInStaticHtml: false });

  it("does not claim the H1 is missing", () => {
    expect(evaluatePage(shell).verdicts.map((v) => v.id)).not.toContain("h1-missing");
  });

  it("says the rule could not be asked", () => {
    expect(evaluatePage(shell).notEvaluated).toEqual(["h1-missing"]);
  });

  it("still judges the rules that do not need the copy", () => {
    // The title and the canonical are in the `<head>`, which arrived. Dropping
    // every rule would be the other half of the same mistake.
    const shellWithBadHead = facts({
      h1Count: 0,
      titleLength: 0,
      canonical: null,
      contentArrivedInStaticHtml: false,
    });

    const ids = evaluatePage(shellWithBadHead).verdicts.map((v) => v.id);
    expect(ids).toContain("title-missing");
    expect(ids).toContain("canonical-missing");
    expect(ids).not.toContain("h1-missing");
  });

  it("says nothing extra when the rule would not have fired anyway", () => {
    // A shell that does have an H1. There is no unanswered question here, so
    // reporting one would be noise.
    expect(evaluatePage(facts({ contentArrivedInStaticHtml: false })).notEvaluated).toEqual([]);
  });

  it("judges the H1 normally once the copy is there", () => {
    expect(evaluatePage(facts({ h1Count: 0 })).verdicts.map((v) => v.id)).toContain("h1-missing");
  });
});

describe("rules fire on what they measure", () => {
  it("catches a missing title, and does not also call it long", () => {
    expect(idsFor({ titleLength: 0 })).toEqual(["title-missing"]);
  });

  it("says nothing about a title at the threshold", () => {
    expect(idsFor({ titleLength: TITLE_LIKELY_TRUNCATED })).toEqual([]);
  });

  it("catches a title past it", () => {
    expect(idsFor({ titleLength: TITLE_LIKELY_TRUNCATED + 1 })).toEqual(["title-long"]);
  });

  it("catches a missing H1 but not a second one as the same rule", () => {
    expect(idsFor({ h1Count: 0 })).toEqual(["h1-missing"]);
    expect(idsFor({ h1Count: 2 })).toEqual(["h1-multiple"]);
  });

  it("catches an absent canonical, viewport and lang", () => {
    expect(idsFor({ canonical: null })).toEqual(["canonical-missing"]);
    expect(idsFor({ viewport: null })).toEqual(["viewport-missing"]);
    expect(idsFor({ lang: null })).toEqual(["lang-missing"]);
  });

  it("catches images with no alt text", () => {
    expect(idsFor({ imagesMissingAlt: 2 })).toEqual(["images-alt"]);
  });
});

/**
 * The two audiences, from one verdict.
 *
 * A practitioner gets the measurement and the provenance; the site's owner gets
 * what it costs them. Neither wording lives in the module that renders it, which
 * is what stopped the two from drifting apart.
 */
describe("one verdict, two renderings", () => {
  it("gives the practitioner the measurement", () => {
    const [verdict] = evaluatePage(facts({ titleLength: 84 })).verdicts;
    expect(asIssueLine(verdict)).toContain("84 characters");
    expect(asIssueLine(verdict)).toContain("device width");
  });

  it("gives the reader a cost, not a measurement", () => {
    const [verdict] = evaluatePage(facts({ titleLength: 84 })).verdicts;
    const finding = asFinding(verdict, "seo");
    expect(finding?.title).toBe("Page title may be cut short in results");
    expect(finding?.value).toBe("84 chars");
    expect(finding?.severity).toBe("opportunity");
  });

  it("marks a heuristic as ours in the practitioner channel", () => {
    const [verdict] = evaluatePage(facts({ h1Count: 2 })).verdicts;
    expect(asIssueLine(verdict)).toContain("Accessibility");
    expect(asIssueLine(verdict)).toContain("do not affect ranking");
  });

  it("leaves a Google-sourced line unqualified, since that is the baseline", () => {
    const [verdict] = evaluatePage(facts({ titleLength: 0 })).verdicts;
    expect(asIssueLine(verdict)).toBe("Missing <title> tag");
  });
});

/**
 * Google says these are fine, so they are not the owner's problem.
 *
 * They still reach a practitioner, who has a reason to know. `asFinding`
 * returning null is how one rule serves both without a fourth severity tier for
 * things that require no action.
 */
describe("rules that are not the reader's problem", () => {
  it.each([
    ["canonical-missing", { canonical: null }],
    ["h1-multiple", { h1Count: 2 }],
    ["description-long", { descriptionLength: 400 }],
  ])("%s reaches the practitioner and stops there", (id, over) => {
    const [verdict] = evaluatePage(facts(over as Partial<PageFacts>)).verdicts;
    expect(verdict.id).toBe(id);
    expect(asIssueLine(verdict)).toBeTruthy();
    expect(asFinding(verdict, "seo")).toBeNull();
  });
});

describe("severity stays inside the glossary", () => {
  it("never invents a fourth tier", () => {
    const allowed = ["critical", "warning", "opportunity"];
    const broken: PageFacts = {
      titleLength: 0, descriptionLength: 0, h1Count: 0,
      canonical: null, viewport: null, lang: null,
      imagesTotal: 3, imagesMissingAlt: 3,
      contentArrivedInStaticHtml: true,
    };

    for (const verdict of evaluatePage(broken).verdicts) {
      const finding = asFinding(verdict, "seo");
      if (finding) expect(allowed, finding.id).toContain(finding.severity);
    }
  });
});

/**
 * The report layer this file also guarded — `report-findings.ts`, which read the
 * same measurements and compared them to its own numbers — retired with the web
 * app, so the duplicate-threshold check retired with it. If a second consumer of
 * `PageFacts` ever appears, that guard is worth writing again: the 60-character
 * title the report kept enforcing after the analyzers moved to 70 is what it was
 * written for.
 */
describe("the rule set", () => {
  it("has a unique id for every rule", () => {
    expect(new Set(ALL_RULE_IDS).size).toBe(ALL_RULE_IDS.length);
  });

  it("can fire every rule it declares, so none is unreachable", () => {
    const fired = new Set([
      ...idsFor({ titleLength: 0 }),
      ...idsFor({ titleLength: 500 }),
      ...idsFor({ descriptionLength: 0 }),
      ...idsFor({ descriptionLength: 500 }),
      ...idsFor({ h1Count: 0 }),
      ...idsFor({ h1Count: 3 }),
      ...idsFor({ canonical: null }),
      ...idsFor({ viewport: null }),
      ...idsFor({ lang: null }),
      ...idsFor({ imagesMissingAlt: 1 }),
    ]);

    expect([...fired].sort()).toEqual([...ALL_RULE_IDS].sort());
  });
});
