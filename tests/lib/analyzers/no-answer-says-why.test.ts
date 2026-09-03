import { describe, expect, it } from "vitest";
import { page } from "../../helpers/parsed-page";
import { notScored } from "@/lib/analyzers/scored-checks";
import { scoreL1, scoreL4, type EntityLookup } from "@/lib/analyzers/ai-visibility-analyzer";
import { scoreFreshness, scoreAiCrawlerAccess } from "@/lib/analyzers/geo-analyzer";

/**
 * The invariant this file exists to keep: **a check with no answer says why.**
 *
 * `render-check.ts` unified the marks after four handlers drifted to five
 * wordings. Nothing unified the sentence underneath, so the same drift happened
 * again in prose — five templates by #337, three more by #346, and four of the
 * five never said the part that matters most, that this is not a finding about
 * the reader's page.
 *
 * #346 is why this is a test and not a convention. There, the correct type, the
 * correct guard and the correct check were all present and the distinction died
 * anyway, in a function that could construct the envelope by hand. A rule nobody
 * checks is a rule that holds until the next contributor. `notScored` gives the
 * sentence one shape; this pins that every producer of the state uses it.
 */

/** The two halves `notScored` guarantees, whatever the reason says. */
const SAYS_WHY = /^Not scored: .+\. This is not a finding about the page — .+\.$/;

/**
 * `not-evaluated` has two causes, and only one of them is ours.
 *
 * Writing this test surfaced the distinction, which the codebase had been
 * conflating. Most unevaluated checks are unevaluated because *we* could not find
 * out: an API 503'd, robots.txt timed out, the language has no pattern set. Those
 * take `notScored`, whose sentence promises the reader this is not their fault —
 * and the promise is true.
 *
 * But `Entity name consistent` is unevaluated because the page supplies neither
 * `og:site_name` nor `Organization.name`, so there is nothing to compare. That is
 * squarely a finding about the page, it ends in actionable advice ("add both"),
 * and running it through `notScored` would print a sentence that is simply false.
 *
 * So the universal invariant is the weaker one: **say why**. The strict shape is
 * required only of the checks whose cause is on our side of the wire.
 */
const EXPLAINS_ITSELF = (detail: string) => detail.trim().length > 30;

const unread = { outcome: "unavailable" as const, reason: "robots.txt returned HTTP 503", status: 503 };
const noLookup: EntityLookup = { found: null, reason: "the API returned HTTP 503" };
const answered: EntityLookup = { found: false };

const ARTICLE = `<!DOCTYPE html><html lang="en"><body><article>
  <h1>A piece</h1><p>${"word ".repeat(400)}</p>
</article></body></html>`;

describe("notScored", () => {
  it("always states the reason and that the page is not at fault", () => {
    expect(notScored("Wikidata returned HTTP 503")).toMatch(SAYS_WHY);
    expect(notScored("Wikidata returned HTTP 503")).toContain("not a finding about the page");
  });

  it("carries a hint when there is something to do, and does not invent one otherwise", () => {
    expect(notScored("robots.txt timed out", "check that /robots.txt is reachable"))
      .toContain("check that /robots.txt is reachable");
    // The default is honest rather than actionable. Most of these have no action.
    expect(notScored("robots.txt timed out")).toContain("try again");
  });
});

/**
 * Walks the real check lists rather than asserting on individual strings, so a
 * check added later is covered by this the day it is written.
 */
describe("every check that could not be evaluated says why", () => {
  type Checked = { detail?: string; status?: string; name?: string; label?: string };

  const nameOf = (c: Checked) => c.name ?? c.label ?? "(unnamed)";

  /**
   * `only` names the checks whose no-answer is caused by the page rather than by
   * us. They must still explain themselves; they must not claim innocence on the
   * page's behalf.
   */
  const assertAllSayWhy = (checks: readonly Checked[], where: string, pageCaused: string[] = []) => {
    const unevaluated = checks.filter((c) => c.status === "not-evaluated");
    expect(unevaluated.length, `${where}: nothing was unevaluated, so this proves nothing`).toBeGreaterThan(0);
    for (const c of unevaluated) {
      const detail = c.detail ?? "";
      expect(EXPLAINS_ITSELF(detail), `${where}: "${nameOf(c)}" is unevaluated and says nothing`).toBe(true);
      if (pageCaused.some((n) => nameOf(c).includes(n))) continue;
      expect(detail, `${where}: "${nameOf(c)}" blames nobody and cites no reason`).toMatch(SAYS_WHY);
    }
  };

  it("holds for the L1 entity lookups", () => {
    process.env.GOOGLE_KG_API_KEY = "test-key";
    try {
      const l1 = scoreL1([], "<html><body></body></html>", noLookup, noLookup, "saas", false);
      // "Entity name consistent" is the page-caused one: the markup supplies
      // nothing to compare, which the page can fix and we cannot.
      assertAllSayWhy(l1.checks, "scoreL1", ["Entity name consistent"]);
    } finally {
      delete process.env.GOOGLE_KG_API_KEY;
    }
  });

  it("holds for the L4 robots read", () => {
    const l4 = scoreL4(
      page(ARTICLE),
      { status: "unavailable", blocked: [], reason: "robots.txt returned HTTP 503" },
      "unknown",
      "article",
    );
    assertAllSayWhy(l4.checks, "scoreL4");
  });

  it("holds for the GEO sitemap read", () => {
    const cat = scoreFreshness(
      [{ "@type": "Article", dateModified: "2026-08-01" }],
      { outcome: "unavailable", reason: "the sitemap index's children could not be read", status: 0 },
      "article",
      "https://example.com/a",
    );
    assertAllSayWhy(cat.checks, "scoreFreshness");
  });

  it("holds for all four GEO bot checks at once", () => {
    // Four identical `status:` lines and one shared detail. If the sentence ever
    // drifts on one of them it drifts on all four, which is the argument for a
    // walk rather than four assertions.
    const cat = scoreAiCrawlerAccess(unread, "<html></html>", false);
    assertAllSayWhy(cat.checks, "scoreAiCrawlerAccess");
    expect(cat.checks.filter((c) => c.status === "not-evaluated").length).toBeGreaterThanOrEqual(4);
  });

  it("leaves a check that DID get an answer alone", () => {
    // The guard must not creep: an answered check keeps its own wording, which is
    // where all the useful advice lives.
    const l1 = scoreL1([], "<html><body></body></html>", answered, answered, "saas", false);
    const wikidata = l1.checks.find((c) => c.name.includes("Wikidata"));
    expect(wikidata?.status).toBeUndefined();
    expect(wikidata?.detail).not.toMatch(SAYS_WHY);
  });
});
