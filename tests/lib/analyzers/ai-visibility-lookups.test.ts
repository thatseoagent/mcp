import { describe, expect, it } from "vitest";
import { page } from "../../helpers/parsed-page";
import { scoreL1, scoreL4, type AiVisibilityCheck } from "@/lib/analyzers/ai-visibility-analyzer";
import { classifyRobotsStatus } from "@/lib/analyzers/robots-ruleset";
import { scoreAiCrawlerAccess } from "@/lib/analyzers/geo-analyzer";

/**
 * #337, slice 2: three L1/L4 checks are fed by external lookups, and a lookup that
 * did not answer used to be scored as a negative finding. The report said so out
 * loud — "robots.txt not accessible", "Could not compare" — and charged for it
 * anyway, which is the purest form of the class: a confident answer to a question
 * nobody managed to ask.
 *
 * The audit that produced these is `docs/research/checks-that-cannot-run.md` §6.3.
 */

const bare = "<html><head></head><body><h1>Acme</h1><p>We do things.</p></body></html>";
const ORG = [{ "@type": "Organization", name: "Acme", url: "https://acme.test" }];
const find = (checks: AiVisibilityCheck[], needle: string) =>
  checks.find((c) => c.name.includes(needle))!;

describe("a lookup that did not answer is not a finding", () => {
  it("leaves the Wikidata check out of the score when the API did not answer", () => {
    const l1 = scoreL1(ORG, bare, { found: null }, { found: false }, "saas", false);
    const check = find(l1.checks, "Wikidata");

    expect(check.status).toBe("not-evaluated");
    expect(check.passed).toBe(false);
    // The 6 points are in neither half: not awarded (which would flatter) and not
    // charged (which is what it used to do while printing that it had not looked).
    expect(l1.notEvaluated).toBeGreaterThanOrEqual(6);
    expect(check.detail).toMatch(/could not be reached/i);
  });

  it("still fails the Wikidata check when the lookup answered and found nothing", () => {
    const l1 = scoreL1(ORG, bare, { found: false }, { found: false }, "saas", false);
    const check = find(l1.checks, "Wikidata");

    // The distinction only earns its keep if a real negative stays a negative.
    expect(check.status).toBeUndefined();
    expect(check.passed).toBe(false);
  });

  it("passes the Wikidata check when the lookup found an entity", () => {
    expect(find(scoreL1(ORG, bare, { found: true }, { found: false }, "saas", false).checks, "Wikidata").passed).toBe(true);
  });
});

describe("a consistency check with nothing to compare has no answer either way", () => {
  const withBoth = `<html><head><meta property="og:site_name" content="Acme"></head><body>x</body></html>`;

  it("does not award 6 points for a comparison it never made", () => {
    // One source only: `Organization.name`. This used to set `nameConsistent = true`
    // and take the full 6 — a pass on no evidence (#341's half of the same check).
    const check = find(scoreL1(ORG, bare, { found: false }, { found: false }, "saas", false).checks, "Entity name consistent");

    expect(check.status).toBe("not-evaluated");
    expect(check.passed).toBe(false);
    expect(check.detail).toMatch(/nothing to compare/i);
  });

  it("does not deduct 6 points either, when neither source is present", () => {
    // Zero sources printed "Could not compare" and then docked all 6.
    const check = find(scoreL1([], bare, { found: false }, { found: false }, "saas", false).checks, "Entity name consistent");

    expect(check.status).toBe("not-evaluated");
    expect(check.detail).toMatch(/nothing to compare/i);
  });

  it("scores normally once there are two names to compare", () => {
    const check = find(scoreL1(ORG, withBoth, { found: false }, { found: false }, "saas", false).checks, "Entity name consistent");

    expect(check.status).toBeUndefined();
    expect(check.passed).toBe(true);
  });

  it("fails, rather than abstaining, when the two names disagree", () => {
    const mismatched = `<html><head><meta property="og:site_name" content="Widgets Inc"></head><body>x</body></html>`;
    const check = find(scoreL1(ORG, mismatched, { found: false }, { found: false }, "saas", false).checks, "Entity name consistent");

    expect(check.status).toBeUndefined();
    expect(check.passed).toBe(false);
  });
});

describe("robots.txt: the site's answer, our failure, and the difference", () => {
  const FRESH = "fresh" as const;

  it("does not charge 8 points for a robots.txt we could not read", () => {
    const l4 = scoreL4(page(bare), { status: "unavailable", blocked: [], reason: "robots.txt returned HTTP 503" }, FRESH, "article");
    const check = find(l4.checks, "AI crawlers allowed");

    expect(check.status).toBe("not-evaluated");
    expect(check.passed).toBe(false);
    expect(l4.notEvaluated).toBeGreaterThanOrEqual(8);
    // The reason travels into the report rather than being flattened to a generic
    // "not accessible", so the reader can tell a 503 from a timeout.
    expect(check.detail).toContain("503");
  });

  it("passes on a site that allows every AI crawler", () => {
    const l4 = scoreL4(page(bare), { status: "ok", blocked: [] }, FRESH, "article");
    const check = find(l4.checks, "AI crawlers allowed");

    expect(check.status).toBeUndefined();
    expect(check.passed).toBe(true);
  });

  it("fails on a site that blocks one", () => {
    const l4 = scoreL4(page(bare), { status: "blocked", blocked: ["GPTBot"] }, FRESH, "article");
    const check = find(l4.checks, "AI crawlers allowed");

    expect(check.status).toBeUndefined();
    expect(check.passed).toBe(false);
    expect(check.detail).toContain("GPTBot");
  });
});

/**
 * The classification the above depends on, tested without a network.
 *
 * `checkAiBotAccess` had no test at all, and the branch it got wrong was exactly
 * this one: it asked "did the request complete" and never "what did the server say",
 * so a 5xx that served a body reported a clean 8/8 pass.
 */
describe("what a robots.txt status actually tells you", () => {
  it("treats a missing file as a definite answer, not a failure", () => {
    // No robots.txt means no rules, which means everything is allowed. This is the
    // one case where "allowed" is safe to conclude from an error status.
    expect(classifyRobotsStatus(404)).toBe("absent");
    expect(classifyRobotsStatus(410)).toBe("absent");
  });

  it("treats a server error as no answer, even though the body may parse", () => {
    expect(classifyRobotsStatus(500)).toBe("unavailable");
    expect(classifyRobotsStatus(503)).toBe("unavailable");
  });

  it("treats a request that never completed as no answer", () => {
    expect(classifyRobotsStatus(0)).toBe("unavailable");
  });

  it("reads any 2xx", () => {
    expect(classifyRobotsStatus(200)).toBe("read");
    expect(classifyRobotsStatus(204)).toBe("read");
  });

  it("does not read a redirect or an auth challenge as a file", () => {
    // A 301 body is not robots.txt, and a 401/403 is a refusal to tell us.
    expect(classifyRobotsStatus(301)).toBe("unavailable");
    expect(classifyRobotsStatus(403)).toBe("unavailable");
  });
});

/**
 * #288 arriving in the second of the two modules it was about.
 *
 * #288's complaint was that `geo_score` and `ai_visibility_score` contradicted each
 * other on the same homepage. The fix landed in `geo-analyzer`, which marks this exact
 * signal N/A for undated page kinds at three call sites; this module kept docking a
 * homepage 5 points for not being an article (#337).
 */
describe("freshness is not asked of a page that is not published on a date", () => {
  const BOTS_OK = { status: "ok" as const, blocked: [] };

  it("excuses the freshness check on a homepage", () => {
    const l4 = scoreL4(page(bare), BOTS_OK, "unknown", "homepage");
    const check = find(l4.checks, "Content freshness");

    expect(check.status).toBe("not-applicable");
    expect(check.detail).toMatch(/N\/A for homepage pages/);
  });

  it("takes its 5 points out of the maximum as well as the score", () => {
    const homepage = scoreL4(page(bare), BOTS_OK, "unknown", "homepage");
    const article = scoreL4(page(bare), BOTS_OK, "unknown", "article");

    expect(article.max - homepage.max).toBe(5);
    // Not counted as unevaluated: we know perfectly well that a homepage has no
    // publication date, which is a settled answer and not a retryable failure.
    expect(homepage.notEvaluated).toBe(0);
  });

  it("still asks it of an article, and still fails an undated one", () => {
    const check = find(scoreL4(page(bare), BOTS_OK, "unknown", "article").checks, "Content freshness");

    expect(check.status).toBeUndefined();
    expect(check.passed).toBe(false);
    expect(check.detail).toMatch(/No modified date found/);
  });

  it("scores a fresh article on its date, not on its page kind", () => {
    const check = find(scoreL4(page(bare), BOTS_OK, "fresh", "article").checks, "Content freshness");

    expect(check.status).toBeUndefined();
    expect(check.earned).toBe(5);
  });
});

/**
 * The geo half of the same defect, which slice 2 of #337 missed.
 *
 * `scoreAiCrawlerAccess` took `robotsTxt: string` and `geo-tools` handed it `""`
 * whenever the fetch failed. `isBotBlocked("", "GPTBot")` finds no rule, so all four
 * bot checks **passed**: a robots.txt we never read awarded 13 points across GPTBot
 * (5), PerplexityBot (3), ClaudeBot (3) and Google-Extended (2).
 */
describe("GEO does not award points for a robots.txt it could not read", () => {
  const html = "<html><head></head><body><h1>Home</h1></body></html>";
  const BOTS = ["GPTBot", "PerplexityBot", "ClaudeBot", "Google-Extended"];
  type Check = { label: string; points: number; status?: string; passed: boolean; detail?: string };
  const botChecks = (cat: { checks: Check[] }) =>
    cat.checks.filter((c) => BOTS.some((b) => c.label.startsWith(b)));
  // The category also holds a `nosnippet` check (2 pts) read from the HTML and an
  // informational llms.txt check (0 pts). Neither comes from robots.txt, so both stay
  // scored when the read fails — which is why these assertions are about the four bot
  // checks' contribution and not about the category total.
  const botPoints = (cat: { checks: Check[] }) =>
    botChecks(cat).reduce((sum, c) => sum + (c.status ? 0 : c.points), 0);

  it("marks all four bot checks unevaluated when the read failed", () => {
    const cat = scoreAiCrawlerAccess(
      { outcome: "unavailable", reason: "/robots.txt returned HTTP 503", status: 503 },
      html,
      false,
    );

    const bots = botChecks(cat);
    expect(bots).toHaveLength(4);
    for (const c of bots) {
      expect(c.status, c.label).toBe("not-evaluated");
      expect(c.detail, c.label).toContain("503");
    }
    // 13 points out of both sides, rather than awarded. The 2 that remain are the
    // HTML-derived `nosnippet` check, which robots.txt has nothing to do with.
    expect(botPoints(cat)).toBe(0);
    expect(cat.maxScore).toBe(2);
  });

  it("still passes all four when the site simply has no robots.txt", () => {
    // 404 is a definite answer: no file, no rules, every crawler allowed. This is the
    // case the old code got right by accident and now gets right on purpose.
    const cat = scoreAiCrawlerAccess({ outcome: "absent", status: 404 }, html, false);

    const bots = botChecks(cat);
    for (const c of bots) {
      expect(c.status, c.label).toBeUndefined();
      expect(c.passed, c.label).toBe(true);
    }
    expect(botPoints(cat)).toBe(13);
    expect(cat.score).toBe(15); // 13 bots + 2 nosnippet
  });

  it("still blocks when robots.txt actually blocks", () => {
    const cat = scoreAiCrawlerAccess(
      { outcome: "found", text: "User-agent: GPTBot\nDisallow: /", status: 200 },
      html,
      false,
    );

    const gpt = cat.checks.find((c) => c.label.startsWith("GPTBot"))!;
    expect(gpt.status).toBeUndefined();
    expect(gpt.passed).toBe(false);
  });
});

describe("the Organization check can see the markup WordPress actually emits (C3)", () => {
  it("finds an Organization inside @graph", () => {
    // `findSchema` only looked at top-level array elements, so an Organization
    // inside `@graph` — what Yoast, RankMath and every WordPress SEO plugin emit
    // — was invisible, and this 7-point check failed on those sites for markup
    // they had. Replaced by `findNodeInAll`, which flattens the graph.
    const graph = [{
      "@context": "https://schema.org",
      "@graph": [
        { "@type": "WebPage", "@id": "https://acme.test/#webpage" },
        { "@type": "Organization", name: "Acme", url: "https://acme.test" },
      ],
    }];
    const check = find(
      scoreL1(graph, bare, { found: false }, { found: false }, "saas", false).checks,
      "Organization",
    );
    expect(check.passed).toBe(true);
  });
});
