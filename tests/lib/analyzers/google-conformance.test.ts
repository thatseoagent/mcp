import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

import { analyzeOnPageSeo } from "@/lib/analyzers/onpage-seo";
import { analyzeRobotsTxt } from "@/lib/analyzers/robots-analyzer";
import { scoreAiCrawlerAccess } from "@/lib/analyzers/geo-analyzer";
import * as geo from "@/lib/analyzers/geo-analyzer";
import { scoreL1 } from "@/lib/analyzers/ai-visibility-analyzer";

/**
 * `scoreAiCrawlerAccess` takes a `WellKnownRead` since #337: a robots.txt we could
 * not read has to be distinguishable from one that said nothing. This wraps a
 * fixture string as the answer it used to be implicitly.
 */
const robotsFound = (text: string) => ({ outcome: "found" as const, text, status: 200 });


/**
 * Pins the corrections from `docs/google-search-central-conformance.md`.
 *
 * Every case here is a rule this codebase used to enforce that Google does not
 * state, or states the opposite of. They are grouped by the sentence of Google's
 * that settles them, because that sentence is the only reason the behaviour is
 * what it is — a future reader deciding to "fix" one of these needs to be
 * arguing with Google, not with us.
 */

type FetchInput = Parameters<typeof fetch>[0];

function serve(routes: Record<string, { status?: number; body?: string; headers?: Record<string, string> }>) {
  return vi.fn(async (input: FetchInput): Promise<Response> => {
    const url =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.toString()
          : (input as Request).url;

    for (const [key, cfg] of Object.entries(routes)) {
      if (url.includes(key)) {
        return new Response(cfg.body ?? "", {
          status: cfg.status ?? 200,
          headers: new Headers(cfg.headers ?? {}),
        });
      }
    }
    return new Response("Not Found", { status: 404 });
  });
}

const originalFetch = global.fetch;
beforeEach(() => vi.restoreAllMocks());
afterEach(() => {
  global.fetch = originalFetch;
});

const page = (head: string, body = "<h1>Title</h1><p>Some copy.</p>") =>
  `<!DOCTYPE html><html lang="en"><head><title>A page</title>${head}</head><body>${body}</body></html>`;

/**
 * The canonical and the "noindex behind a Disallow" cases are pinned in the
 * retired suite against `crawlability-analyzer`, which belongs to a different
 * Tool group and has not been ported. They travel with it.
 */

describe('content length: "the length of the content alone doesn\'t matter"', () => {
  it("raises nothing about a short page", async () => {
    global.fetch = serve({ "/short": { body: page("", "<h1>Contact</h1><p>Call us.</p>") } });

    const result = await analyzeOnPageSeo("https://example.com/short");
    expect(result.issues.some((i) => /word count/i.test(i))).toBe(false);
  });
});

describe('headings: "it doesn\'t matter if you\'re using them out of order"', () => {
  it("labels a second H1 as accessibility, never as a Google rule", async () => {
    global.fetch = serve({
      "/two-h1": { body: page("", "<h1>One</h1><h1>Two</h1><p>Copy.</p>") },
    });

    const result = await analyzeOnPageSeo("https://example.com/two-h1");
    const finding = result.issues.find((i) => i.includes("Multiple H1"));

    expect(finding).toBeDefined();
    expect(finding).toContain("Accessibility");
    expect(finding).toContain("do not affect ranking");
  });
});

describe("title and description length", () => {
  it("does not call a 65-character title too long", async () => {
    const title = "A".repeat(65);
    global.fetch = serve({
      "/title": { body: `<!DOCTYPE html><html lang="en"><head><title>${title}</title></head><body><h1>H</h1></body></html>` },
    });

    const result = await analyzeOnPageSeo("https://example.com/title");
    expect(result.issues.some((i) => /too long/i.test(i))).toBe(false);
  });

  it("does not demand a minimum description length", async () => {
    global.fetch = serve({
      "/desc": { body: page('<meta name="description" content="Short but true.">') },
    });

    const result = await analyzeOnPageSeo("https://example.com/desc");
    expect(result.issues.some((i) => /too short/i.test(i))).toBe(false);
  });

  it("says a very long title may be truncated, without calling it an error", async () => {
    global.fetch = serve({
      "/long": { body: `<!DOCTYPE html><html lang="en"><head><title>${"B".repeat(120)}</title></head><body><h1>H</h1></body></html>` },
    });

    const result = await analyzeOnPageSeo("https://example.com/long");
    const finding = result.issues.find((i) => i.includes("truncated"));
    expect(finding).toContain("device width");
  });
});

describe("links Google cannot follow", () => {
  it("finds href on a non-anchor, which HTML gives no meaning", async () => {
    global.fetch = serve({
      "/spans": { body: page("", '<span href="/products">Products</span>') },
    });

    const result = await analyzeOnPageSeo("https://example.com/spans");
    expect(result.issues.some((i) => i.includes("Google cannot follow"))).toBe(true);
  });

  it("finds a router attribute standing in for href", async () => {
    global.fetch = serve({
      "/router": { body: page("", '<a routerLink="/products">Products</a>') },
    });

    const result = await analyzeOnPageSeo("https://example.com/router");
    expect(result.issues.some((i) => i.includes("Google cannot follow"))).toBe(true);
  });

  it("leaves a plain anchor alone", async () => {
    global.fetch = serve({
      "/fine": { body: page("", '<a href="/products">Products</a>') },
    });

    const result = await analyzeOnPageSeo("https://example.com/fine");
    expect(result.issues.some((i) => i.includes("Google cannot follow"))).toBe(false);
  });
});

describe("robots.txt directives Google does not support", () => {
  it("says crawl-delay is ignored rather than accepting it silently", async () => {
    global.fetch = serve({
      "/robots.txt": { body: "User-agent: *\nCrawl-delay: 10\nDisallow: /admin" },
    });

    const result = await analyzeRobotsTxt("https://example.com");
    expect(result.success).toBe(true);
    if (!result.success) return;

    expect(result.data.issues.some((i) => i.message.includes("ignored by Google"))).toBe(true);
  });

  it("catches Noindex in robots.txt, which reads like it works and does not", async () => {
    global.fetch = serve({
      "/robots.txt": { body: "User-agent: *\nNoindex: /secret" },
    });

    const result = await analyzeRobotsTxt("https://example.com");
    expect(result.success).toBe(true);
    if (!result.success) return;

    const finding = result.data.issues.find((i) => i.message.includes("not a robots.txt directive"));
    expect(finding?.type).toBe("conflict");
  });
});

describe("llms.txt, which Google states it does not use", () => {
  it("awards no points either way", () => {
    const robots = "User-agent: *\nAllow: /";
    const html = page("");

    const withFile = scoreAiCrawlerAccess(robotsFound(robots), html, true);
    const without = scoreAiCrawlerAccess(robotsFound(robots), html, false);

    expect(withFile.score).toBe(without.score);

    const check = withFile.checks.find((c) => c.label.includes("llms.txt"));
    expect(check?.points).toBe(0);
  });
});

/**
 * Removing points from a check is only safe if the maximum follows.
 *
 * When llms.txt dropped from 7 points to 0, `scoreL1` still declared
 * `const MAX = 40`, so the best a flawless site could reach was 33/40 and every
 * grade came out a tier low. The maximum is derived now; this proves it.
 */
describe("a score's maximum is the sum of what it asks for", () => {
  it("never exceeds the maximum, and the maximum matches the checks", () => {
    const l1 = scoreL1([], page(""), { found: false }, { found: false }, "saas", false);

    // Over the scorable checks only. A bare page has neither `og:site_name` nor
    // `Organization.name`, so the name-consistency check has nothing to compare and
    // is out of both sides of the fraction (#337) — a maximum that counted it would
    // be a ceiling this page was never eligible for.
    const scorable = l1.checks.filter((c) => !c.status);
    expect(l1.max).toBe(scorable.reduce((sum, c) => sum + c.points, 0));
    expect(l1.score).toBeLessThanOrEqual(l1.max);
    expect(l1.notEvaluated).toBe(l1.checks.filter((c) => c.status).reduce((sum, c) => sum + c.points, 0));
  });

  it("counts a passing check's points toward both the score and the maximum", () => {
    const withOrg = scoreL1(
      [{ "@type": "Organization", name: "Acme", url: "https://acme.test" }],
      page(""),
      { found: false },
      { found: false },
      "saas",
      false
    );
    const without = scoreL1([], page(""), { found: false }, { found: false }, "saas", false);

    // Same checks asked of both pages, so the same ceiling; only the score moves.
    expect(withOrg.max).toBe(without.max);
    expect(withOrg.score).toBeGreaterThan(without.score);
  });
});

/**
 * The AI-optimization guide, read 2026-08-01.
 *
 * `docs/google-search-central-conformance.md` §1.6 already removed the points
 * llms.txt used to earn, on the strength of this guide listing it among the
 * things Google does not use. The same guide rules out three more techniques in
 * the same breath, and the GEO analyzer was still recommending two of them:
 *
 * > "Not necessary to divide content into small pieces for AI understanding"
 * > "Not necessary to write in a specific way only for generative AI"
 *
 * §1.6's diagnosis applies unchanged: a recommendation spent on a technique
 * nobody has published support for, in language nobody has published support
 * for. What made it invisible is that `geo-analyzer` is the one analyzer with no
 * `annotate()` call, so its findings reached the reader indistinguishable from
 * the ones that quote Google.
 */
describe("the AI-optimization guide — no unpublished mechanism claims", () => {
  const { buildRecommendations, scoreQueryOptimization, scoreCitationSignals } = geo;

  /** Every recommendation the analyzer can emit, across every category. */
  function allRecommendations(): string[] {
    const empty = "<html><head><title>t</title></head><body><p>short</p></body></html>";
    const categories = [
      scoreQueryOptimization(empty, [], "article"),
      scoreCitationSignals(empty, "article"),
      geo.scoreContentCitability(empty, "article"),
      geo.scoreFreshnessSignals(empty, {}, "article"),
      geo.scoreStructuredData([], new Set(), "article"),
    ];
    // One category at a time: `buildRecommendations` caps its output at 8, so
    // passing all five together would hide most of the lines under test.
    return categories.flatMap((c) => buildRecommendations([c]));
  }

  it("quantifies no claim about AI engines it cannot source", () => {
    const recs = allRecommendations().join("\n");

    // "~2x", "~3×", "at ~3× the rate", "the most cited". No publisher of any AI
    // engine has released citation rates, so a multiplier here is invented.
    expect(recs).not.toMatch(/~?\d+\s*[x×]/i);
    expect(recs).not.toMatch(/most cited|far more frequently|sweet spot/i);
  });

  it("owns its word-count threshold instead of prescribing it", () => {
    // The action used to read "Write a 40-60 word paragraph immediately after key
    // headings — this length is the sweet spot for featured snippet and AI answer
    // extraction". Two separate problems, and only one is the number: the reader
    // does need to know what the check measured, or a failure is unactionable.
    // What they must not be told is to write to it, or that an engine rewards it.
    const rec = allRecommendations().find((r) => /40-60 word/.test(r));
    expect(rec, "the threshold should still be disclosed").toBeDefined();
    expect(rec).not.toMatch(/^• Write a 40-60 word/);
    expect(rec).toMatch(/the number is ours/);
  });

  it("marks a heuristic check as ours where it reaches the reader", () => {
    // `scoreQueryOptimization` is the category built entirely from our own
    // reading of how answer engines pick passages. Not one of its checks has a
    // Google sentence behind it, so not one may look like it does.
    const cat = scoreQueryOptimization(
      "<html><body><h2>Overview</h2><p>text</p></body></html>",
      [],
      "article"
    );
    const heuristics = cat.checks.filter((c) => !c.status);
    expect(heuristics.length).toBeGreaterThan(0);
    for (const check of heuristics) {
      expect(check.source, `check "${check.label}" declares no source`).toBeDefined();
    }
  });

  it("keeps the qualifier out of the structured name, which is an identifier", () => {
    const cat = geo.scoreQueryOptimization("<html><body><h2>Overview</h2></body></html>", [], "article");
    const check = cat.checks.find((c) => !c.status)!;

    // Prose carries it inline; structured output keeps it in its own field. The
    // first version appended it to `name`, which type-checked and silently broke
    // every `checks.find(c => c.name === "…")` in the report and the tests.
    expect(geo.describeCheck(check)).toContain(check.label);
    expect(geo.describeCheck(check)).toMatch(/That SEO Agent heuristic/);
    expect(geo.checkProvenance(check)).toBe("That SEO Agent heuristic, not a Google rule");
    expect(geo.checkProvenance(check)).not.toContain(check.label);
  });

  it("leaves a Google-backed check unmarked, so the marking still means something", () => {
    // HTTP 200 is one of Google's three technical requirements. Tagging it as a
    // heuristic would be as wrong as leaving a heuristic bare.
    const cat = geo.scoreTechnical("<html><body>hi</body></html>", 200);
    const http = cat.checks.find((c) => c.label.includes("HTTP 200"));
    expect(http?.source?.kind).toBe("google");
    expect(geo.checkProvenance(http!)).toBeUndefined();
    expect(geo.describeCheck(http!)).toBe(http!.label);
  });
});

/**
 * The one buildable thing in the AI-optimization guide.
 *
 * > "Agents may interact with your site by analyzing visual rendering, inspecting
 * > the DOM, and interpreting the accessibility tree."
 *
 * Everything else the guide recommends is either already covered (technical
 * requirements, crawlability, duplicate content) or is advice about writing. This
 * sentence names a mechanism, and the accessibility tree is derived from the DOM
 * by published rules, so it is checkable without a browser — which makes it the
 * only AI-era check in the product that is a fact rather than a model.
 */
describe("operability by agents", () => {
  it("reports a control an agent cannot name, as accessibility rather than as a Google rule", async () => {
    global.fetch = serve({
      "/icons": {
        body: page("", '<main><h1>Shop</h1><button><svg></svg></button></main>'),
      },
    });

    const result = await analyzeOnPageSeo("https://example.com/icons");
    const finding = result.issues.find((i) => i.includes("cannot operate"));

    expect(finding).toBeDefined();
    // Marked, and marked as what it is: Google names the mechanism, it does not
    // say an unnamed button costs you ranking.
    expect(finding).toContain("Accessibility");
    expect(finding).toContain("WCAG 2.2 §4.1.2");
    expect(finding).toMatch(/rather than how it ranks/);
  });

  it("counts the whole problem but shows one example", async () => {
    const buttons = Array.from({ length: 12 }, () => "<button><svg></svg></button>").join("");
    global.fetch = serve({
      "/many": { body: page("", `<main><h1>Shop</h1>${buttons}</main>`) },
    });

    const result = await analyzeOnPageSeo("https://example.com/many");
    const finding = result.issues.find((i) => i.includes("cannot operate"))!;

    // A broken component template repeats. The count is the size of the job; the
    // example is where to start.
    expect(finding).toContain("12 element(s)");
    expect(finding).toContain("and 11 more");
  });

  it("says nothing about a page an agent can already operate", async () => {
    global.fetch = serve({
      "/good": {
        body: page(
          "",
          '<main><h1>Shop</h1><form><label for="q">Search</label><input id="q"></form>' +
            '<button aria-label="Close"><svg></svg></button></main>'
        ),
      },
    });

    const result = await analyzeOnPageSeo("https://example.com/good");
    expect(result.issues.some((i) => i.includes("cannot operate"))).toBe(false);
  });
});
