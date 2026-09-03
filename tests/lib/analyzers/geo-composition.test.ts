import { describe, expect, it } from "vitest";
import {
  KNOWLEDGE_GRAPH_POINTS,
  knowledgeGraphCheck,
  scoreGeo,
  type GeoCategoryKey,
} from "@/lib/analyzers/geo-analyzer";
import { readPage } from "@/lib/analyzers/parsed-page";
import { tally } from "@/lib/analyzers/scored-checks";

/**
 * The invariant this file exists to keep: **the GEO run is the analyzer's, and
 * every point in it is written once.**
 *
 * The run used to live in the Tool handler — ten `score*` calls, a mutation of a
 * category built two lines earlier, a ten-element array, three hand-written
 * expressions for the Knowledge Graph points, then `computeGeoScore`. Twelve
 * steps a caller had to sequence, with the one ordering constraint among them
 * expressed nowhere in a type. None of it was testable without standing up HTTP,
 * so none of it was tested: the category set, the order, and the Knowledge Graph
 * three-case branch were all a handler's private business.
 *
 * The Knowledge Graph part is the sharper half. `scored-checks.ts` was written
 * because "`ai-visibility` wrote every value twice … with nothing keeping them in
 * step", and the handler wrote the number 5 three times — `kgApplicable`,
 * `kgEarned`, `kgUnevaluated` — with a fourth `+5 pts` in the render. No test
 * covered any of it, because the suite never sets `GOOGLE_KG_API_KEY`.
 */

const ARTICLE = `<!DOCTYPE html><html lang="en"><body><article>
  <h1>A piece</h1>
  <h2>What this covers</h2>
  <p>${"word ".repeat(400)}</p>
</article></body></html>`;

const found = { outcome: "found" as const, text: "", status: 200 };

function reading(
  overrides: Partial<Parameters<typeof scoreGeo>[0]> = {},
): ReturnType<typeof scoreGeo> {
  return scoreGeo({
    page: readPage("https://example.com/post", ARTICLE),
    html: ARTICLE,
    httpStatus: 200,
    responseHeaders: {},
    robotsRead: found,
    sitemapRead: found,
    llmsTxtExists: false,
    knowledgeGraph: { lookup: { found: false }, keyConfigured: false },
    ...overrides,
  });
}

describe("the Knowledge Graph check", () => {
  it("does not exist when no key is configured", () => {
    // Our deployment, not the site's business. `null` rather than
    // `not-applicable`: the latter would put the points into the report's "these
    // do not apply to this page" sentence, blaming the page for a variable the
    // Operator did not set.
    expect(knowledgeGraphCheck({ found: null }, false)).toBeNull();
    expect(knowledgeGraphCheck({ found: true }, false)).toBeNull();
  });

  it("leaves both sides of the fraction when the API did not answer", () => {
    const check = knowledgeGraphCheck(
      { found: null, reason: "the API returned HTTP 503" },
      true,
    )!;

    expect(check.status).toBe("not-evaluated");
    expect(check.points).toBe(KNOWLEDGE_GRAPH_POINTS);
    // Telling a brand with a Knowledge Panel to strengthen its entity signals
    // because the API 503'd is the failure this state exists to avoid.
    expect(check.detail).toContain("the API returned HTTP 503");
    expect(check.detail).toContain("not a finding about the page");

    const walked = tally([check]);
    expect(walked.max).toBe(0);
    expect(walked.notEvaluated).toBe(KNOWLEDGE_GRAPH_POINTS);
  });

  it("scores when there is an answer, either way", () => {
    const yes = knowledgeGraphCheck({ found: true }, true)!;
    const no = knowledgeGraphCheck({ found: false }, true)!;

    expect(tally([yes])).toMatchObject({ score: KNOWLEDGE_GRAPH_POINTS, max: KNOWLEDGE_GRAPH_POINTS });
    expect(tally([no])).toMatchObject({ score: 0, max: KNOWLEDGE_GRAPH_POINTS });
  });

  it("reaches the score through one arithmetic, not three expressions", () => {
    const without = reading();
    const unevaluated = reading({
      knowledgeGraph: { lookup: { found: null }, keyConfigured: true },
    });
    const earned = reading({
      knowledgeGraph: { lookup: { found: true }, keyConfigured: true },
    });

    // No key: the ceiling does not move, because the check does not exist.
    expect(unevaluated.applicableMax).toBe(without.applicableMax);
    // No answer: the points are reported as uncovered rather than as a miss.
    expect(unevaluated.unevaluatedPoints).toBe(without.unevaluatedPoints + KNOWLEDGE_GRAPH_POINTS);
    // An answer: both sides move by the same amount.
    expect(earned.applicableMax).toBe(without.applicableMax + KNOWLEDGE_GRAPH_POINTS);
    expect(earned.earned).toBe(without.earned + KNOWLEDGE_GRAPH_POINTS);
  });
});

describe("the GEO reading", () => {
  /**
   * The order the report prints, and the persisted keys. `freshnesSignals` is
   * misspelled on purpose — it is a key in `context_json` and in frozen
   * `shared_reports.snapshot_json`, so correcting it would drop a whole category
   * from every already-published report.
   */
  const EXPECTED: GeoCategoryKey[] = [
    "structuredData",
    "contentFreshness",
    "contentStructure",
    "aiCrawlerAccess",
    "authorEeat",
    "technical",
    "contentCitability",
    "citationSignals",
    "freshnesSignals",
    "queryOptimization",
  ];

  it("has ten categories, in the order the report prints them", () => {
    expect(reading().categories.map((category) => category.key)).toEqual(EXPECTED);
  });

  it("puts the listicle check inside content structure, with no second call", () => {
    const contentStructure = reading().categories.find((c) => c.key === "contentStructure")!;

    // It used to arrive via an exported `applyListicleCheck(category, html,
    // pageType)` the handler called on the line after the category was built.
    expect(contentStructure.checks.some((check) => /Listicle/i.test(check.label))).toBe(true);
    // And the totals are derived, not adjusted: the mutator had to rebuild them
    // with `Object.assign` because appending a check invalidated them.
    expect(contentStructure.maxScore).toBe(tally(contentStructure.checks).max);
  });

  it("normalises against what this page could be scored on", () => {
    const result = reading();

    expect(result.score).toBeGreaterThanOrEqual(0);
    expect(result.score).toBeLessThanOrEqual(100);
    expect(result.applicableMax).toBeGreaterThan(0);
    // Every declared point is accounted for on exactly one side.
    const declared = result.categories.reduce(
      (sum, category) => sum + category.checks.reduce((s, check) => s + check.points, 0),
      0,
    );
    expect(result.applicableMax + result.naPoints + result.unevaluatedPoints).toBe(declared);
  });

  it("scores a homepage on fewer points than an article, and says so", () => {
    const home = scoreGeo({
      page: readPage("https://example.com/", ARTICLE),
      html: ARTICLE,
      httpStatus: 200,
      responseHeaders: {},
      robotsRead: found,
      sitemapRead: found,
      llmsTxtExists: false,
      knowledgeGraph: { lookup: { found: false }, keyConfigured: false },
    });

    // A homepage owes no author, no date and no listicle. Those points leave both
    // sides, and `naPoints` is what lets the report say which run this is not
    // comparable to.
    expect(home.naPoints).toBeGreaterThan(0);
    expect(home.applicableMax).toBeLessThan(reading().applicableMax);
  });

  it("recommends from the categories it scored, and bounds the list", () => {
    const result = reading();

    expect(result.recommendations.length).toBeLessThanOrEqual(8);
  });
});
