import { describe, it, expect } from "vitest";
import {
  isBotBlocked,
  scoreStructuredData,
  scoreContentStructure,
  scoreContentCitability,
  scoreCitationSignals,
  scoreAuthorEeat,
  scoreQueryOptimization,
  scoreFreshnessSignals,
  scoreFreshness,
  scoreAiCrawlerAccess,
  scoreTechnical,
  buildRecommendations,
  computeGeoScore,
  knowledgeGraphCheck,
  type GeoCategory,
} from "@/lib/analyzers/geo-analyzer";
import { getSchemaTypes } from "@/lib/analyzers/json-ld-graph";
import type { PageKind } from "@/lib/analyzers/page-identity";

/**
 * The two scorers below take a `WellKnownRead` since #337: a robots.txt or a sitemap
 * we could not read has to be distinguishable from one that said nothing. These
 * wrap a fixture string as the answer it used to be implicitly.
 */
const robotsFound = (text: string) => ({ outcome: "found" as const, text, status: 200 });
const sitemapFound = (text: string) => ({ outcome: "found" as const, text, status: 200 });
/**
 * The third outcome, which had no fixture and therefore no test — the
 * `!answered(sitemapRead)` branch and the `status: "not-evaluated"` it sets were
 * written for #337 and never exercised. #346 is what happens when the guard is
 * right and nothing proves it stays right: its caller laundered every
 * `unavailable` into `found` and nobody noticed.
 */
const sitemapUnavailable = (reason: string) =>
  ({ outcome: "unavailable" as const, reason, status: 0 });
const sitemapAbsent = () => ({ outcome: "absent" as const, status: 404 });


const findCheck = (cat: GeoCategory, needle: string) =>
  cat.checks.find((c) => c.label.toLowerCase().includes(needle.toLowerCase()));

// ── isBotBlocked ──────────────────────────────────────────────────────────────

describe("isBotBlocked", () => {
  it("returns true when a specific bot is explicitly disallowed", () => {
    const robotsTxt = "User-agent: GPTBot\nDisallow: /";
    expect(isBotBlocked(robotsTxt, "GPTBot")).toBe(true);
  });

  it("returns true when wildcard disallows all and bot has no specific rule", () => {
    const robotsTxt = "User-agent: *\nDisallow: /";
    expect(isBotBlocked(robotsTxt, "GPTBot")).toBe(true);
  });

  it("returns false when bot has an explicit Allow that overrides wildcard Disallow", () => {
    const robotsTxt = "User-agent: *\nDisallow: /\nUser-agent: GPTBot\nAllow: /";
    expect(isBotBlocked(robotsTxt, "GPTBot")).toBe(false);
  });

  it("returns false when disallow value is empty after stripping inline comment", () => {
    // "# was /" is a comment — after split("#")[0].trim() the value is ""
    const robotsTxt = "User-agent: GPTBot\nDisallow: # was /";
    expect(isBotBlocked(robotsTxt, "GPTBot")).toBe(false);
  });

  it("returns true with case-insensitive User-agent and Disallow directives", () => {
    const robotsTxt = "USER-AGENT: ClaudeBot\nDISALLOW: /";
    expect(isBotBlocked(robotsTxt, "ClaudeBot")).toBe(true);
  });
});

// ── scoreStructuredData ───────────────────────────────────────────────────────

describe("scoreStructuredData", () => {
  it("returns score > 0 with FAQPage + Article schemas and sameAs field", () => {
    const schemas = [
      { "@type": "FAQPage" },
      {
        "@type": "Article",
        author: "Jane Doe",
        datePublished: "2026-01-01",
        dateModified: "2026-03-01",
      },
      {
        "@type": "Organization",
        sameAs: ["https://linkedin.com/company/example", "https://twitter.com/example"],
      },
    ];
    const schemaTypes = getSchemaTypes(schemas);
    const result = scoreStructuredData(schemas, schemaTypes, "article");
    expect(result.score).toBeGreaterThan(0);
  });

  it("fails every applicable check with an empty schemas array on an article page", () => {
    const result = scoreStructuredData([], new Set(), "article");

    // An article is not an FAQ, so FAQPage is N/A here. Everything an article
    // actually owes must fail.
    const applicable = result.checks.filter((c) => !c.status);
    expect(applicable.length).toBeGreaterThan(0);
    expect(applicable.every((c) => !c.passed)).toBe(true);

    // Zero, not the N/A credit. An inapplicable check used to be awarded its points
    // and this assertion used to read `toBe(naCredit)` — which is the shape #337
    // named: a page earning marks for questions nobody asked it.
    expect(result.score).toBe(0);
    // And the ceiling drops with it, so the ratio is still honest.
    expect(result.maxScore).toBe(applicable.reduce((sum, c) => sum + c.points, 0));
  });

  it("identity links in Organization schema contribute to score", () => {
    const schemas = [
      {
        "@type": "Organization",
        sameAs: ["https://twitter.com/example", "https://linkedin.com/company/example"],
      },
    ];
    const schemaTypes = getSchemaTypes(schemas);
    const withSameAs = scoreStructuredData(schemas, schemaTypes, "article");
    const withoutSameAs = scoreStructuredData(
      [{ "@type": "Organization" }],
      new Set(["Organization"]),
      "article",
    );
    expect(withSameAs.score).toBeGreaterThan(withoutSameAs.score);
  });
});

// ── buildRecommendations ──────────────────────────────────────────────────────

describe("buildRecommendations", () => {
  it("returns empty array when all checks pass (no failed checks)", () => {
    const categories: GeoCategory[] = [
      {
        key: "technical" as const, name: "TEST",
        score: 10,
        maxScore: 10,
        checks: [
          { passed: true, label: "FAQPage schema present", points: 5 },
          { passed: true, label: "Word count > 500", points: 5 },
        ],
      },
    ];
    expect(buildRecommendations(categories)).toEqual([]);
  });

  it("returns non-empty array when checks fail and labels match the recommendation map", () => {
    const categories: GeoCategory[] = [
      {
        key: "technical" as const, name: "STRUCTURED DATA",
        score: 0,
        maxScore: 33,
        checks: [
          { passed: false, label: "FAQPage schema present", points: 8 },
          { passed: false, label: "Organization schema with 2+ sameAs URLs", points: 7 },
        ],
      },
    ];
    const recs = buildRecommendations(categories);
    expect(recs.length).toBeGreaterThan(0);
  });
});

// ── i18n: content-signal checks must recognize Spanish, not only English ────────

describe("Spanish content signals", () => {
  it("scoreContentCitability detects a Spanish definition and a Spanish question heading", () => {
    const html = `<html><body>
      <h2>¿Qué es el SEO?</h2>
      <p>El SEO es una técnica de optimización para buscadores que mejora la visibilidad.</p>
    </body></html>`;
    const cat = scoreContentCitability(html, "article");
    expect(findCheck(cat, "Definition")?.passed).toBe(true);
    // Question headings moved to QUERY OPTIMIZATION when the duplicate pair was
    // merged; the Spanish question words must still be recognised there.
    const qo = scoreQueryOptimization(html, [], "article");
    expect(findCheck(qo, "Question-phrased")?.passed).toBe(true);
  });

  it("scoreCitationSignals detects Spanish stats, source attribution and a references section", () => {
    const html = `<html><body>
      <p>Según un estudio de Nielsen, el 45 % de los usuarios y 3 de cada 10 compradores prefieren la marca.</p>
      <h2>Fuentes</h2>
      <ul><li>Nielsen 2025</li></ul>
    </body></html>`;
    const cat = scoreCitationSignals(html, "article");
    expect(findCheck(cat, "Statistics")?.passed).toBe(true); // "45 %" + "3 de cada 10"
    expect(findCheck(cat, "Source attribution")?.passed).toBe(true); // "según un estudio de"
    expect(findCheck(cat, "Reference")?.passed).toBe(true); // "Fuentes" heading
  });

  it("counts Spanish number words (millones) as statistics", () => {
    // Statistics moved to CITATION SIGNALS when the duplicate pair was merged.
    // The surviving pattern had to absorb the written magnitudes the dropped
    // copy detected, or Spanish pages would have quietly stopped scoring here.
    const html = `<html><body><p>En 2025, 3 millones de usuarios y un 45 % de crecimiento anual.</p></body></html>`;
    const cat = scoreCitationSignals(html, "article");
    expect(findCheck(cat, "Statistics & numerical data")?.passed).toBe(true);
  });

  it("scoreAuthorEeat recognizes a Spanish 'por <Nombre>' byline", () => {
    const html = `<html><body><p>por Juan Pérez</p><p>Contenido del artículo.</p></body></html>`;
    const cat = scoreAuthorEeat(html, [], "article");
    expect(findCheck(cat, "Named author")?.passed).toBe(true);
  });

  it("scoreQueryOptimization detects a Spanish summary and a Spanish question-word heading", () => {
    const html = `<html><body>
      <div class="resumen">Resumen ejecutivo del artículo.</div>
      <h3>Cómo elegir un CRM</h3>
    </body></html>`;
    const cat = scoreQueryOptimization(html, [], "article");
    expect(findCheck(cat, "summary")?.passed).toBe(true); // class="resumen"
    expect(findCheck(cat, "Question-phrased")?.passed).toBe(true); // "Cómo elegir…" (no '?')
  });

  it("listicle check recognizes a Spanish numbered heading", () => {
    // The check is part of CONTENT STRUCTURE rather than bolted on afterwards by
    // an exported mutator, so this reads it where it lives.
    const cat = scoreContentStructure(
      `<html><body><h2>10 mejores herramientas de SEO</h2></body></html>`,
      "article",
    );
    expect(findCheck(cat, "Listicle")?.passed).toBe(true);
  });
});

// ── computeGeoScore (#288: reweight so N/A checks don't inflate the score) ──────

describe("computeGeoScore", () => {
  it("excludes N/A points from BOTH numerator and denominator", () => {
    const categories: GeoCategory[] = [
      // A category made entirely of an N/A check. Its own totals are 0 / 0 now:
      // `tally` never counted it, so this fixture states what `category()` would
      // actually produce. Written as 15 / 15 before #337, which is precisely the
      // figure #339 reports the dashboard was painting green.
      {
        key: "technical" as const, name: "CONTENT FRESHNESS",
        score: 0,
        maxScore: 0,
        checks: [{ passed: true, status: "not-applicable" as const, label: "freshness", points: 15 }],
      },
      // A real category: earned 5 of 20 applicable points.
      {
        key: "technical" as const, name: "CITATION SIGNALS",
        score: 5,
        maxScore: 20,
        checks: [
          { passed: true, label: "stats", points: 5 },
          { passed: false, label: "quotes", points: 15 },
        ],
      },
    ];
    const r = computeGeoScore(categories);
    // Still reported, for the sentence the report prints beside the score.
    expect(r.naPoints).toBe(15);
    expect(r.unevaluatedPoints).toBe(0);
    // No subtraction happens here any more: the categories arrive net, and taking
    // `naPoints` off again would remove the same 15 points twice.
    expect(r.earned).toBe(5);
    expect(r.applicableMax).toBe(20);
    expect(r.score).toBe(25); // 5 / 20
    expect(r.grade).toBe("Low");
  });

  it("behaves like a plain percentage when there are no N/A checks", () => {
    const categories: GeoCategory[] = [
      {
        key: "technical" as const, name: "TECHNICAL",
        score: 17,
        maxScore: 20,
        checks: [{ passed: true, label: "https", points: 17 }],
      },
    ];
    const r = computeGeoScore(categories);
    expect(r.naPoints).toBe(0);
    expect(r.score).toBe(85);
    expect(r.grade).toBe("Excellent");
  });

  it("adds the Knowledge Graph bonus to both earned and applicable max", () => {
    const categories: GeoCategory[] = [
      {
        key: "technical" as const, name: "STRUCTURED DATA",
        score: 45,
        maxScore: 50,
        checks: [{ passed: true, label: "org", points: 45 }],
      },
    ];
    const r = computeGeoScore(categories, {
      knowledgeGraph: knowledgeGraphCheck({ found: true }, true),
    });
    expect(r.earned).toBe(50);
    expect(r.applicableMax).toBe(55);
    expect(r.score).toBe(91); // round(50/55*100)
  });

  it("regression #288: a homepage with 35 N/A points drops from inflated 'Excellent' to an honest 'Low'", () => {
    // Mirrors seolvl.com: it read 85 of 170 because 35 of those points were free
    // N/A credits. The category now reports 50 / 135 itself, so the inflation is
    // gone one level earlier than #288 fixed it.
    const categories: GeoCategory[] = [
      {
        key: "technical" as const, name: "GEO",
        score: 50,
        maxScore: 135,
        checks: [
          { passed: true, status: "not-applicable" as const, label: "na-bundle", points: 35 },
          { passed: true, label: "earned", points: 50 },
          { passed: false, label: "missed", points: 85 },
        ],
      },
    ];
    const r = computeGeoScore(categories);
    expect(r.earned).toBe(50);
    expect(r.applicableMax).toBe(135);
    expect(r.score).toBe(37); // round(50/135*100)
    expect(r.grade).toBe("Low");
  });

  it("says 'Not assessable' rather than 'Low' when no check could be scored", () => {
    // The state #337 calls the purest form of the bug: every check on the page was
    // either inapplicable or unevaluated, and the four bands would hand this page
    // the report's worst word for the one input that did not earn it.
    const r = computeGeoScore([
      {
        key: "technical" as const, name: "CONTENT FRESHNESS",
        score: 0,
        maxScore: 0,
        checks: [
          { passed: true, status: "not-applicable" as const, label: "freshness", points: 15 },
          { passed: false, status: "not-evaluated" as const, label: "sitemap lastmod", points: 5 },
        ],
      },
    ]);
    expect(r.applicableMax).toBe(0);
    expect(r.score).toBe(0);
    expect(r.grade).toBe("Not assessable");
    // Both counts survive so the report can say which kind of silence this was.
    expect(r.naPoints).toBe(15);
    expect(r.unevaluatedPoints).toBe(5);
  });
});

describe("checks that only apply to dated, authored pages", () => {
  // Both of these used to be scored against every page type, so auditing a
  // homepage was told to add Open Graph article timestamps it has no article
  // for, and was docked points for not shipping FAQPage schema.
  const NA_TYPES = ["homepage", "landing", "product", "faq"] as const;
  const find = (cat: GeoCategory, label: string) =>
    cat.checks.find((c) => c.label.includes(label))!;

  describe("Open Graph article:modified_time / article:published_time", () => {
    const LABEL = "Open Graph meta tag";
    const bare = "<html><head></head><body><h1>Home</h1></body></html>";

    it.each(["homepage", "landing", "product", "faq"] as const)(
      "is not applicable to a %s",
      (pageType) => {
        const c = find(scoreFreshnessSignals(bare, {}, pageType), LABEL);
        expect(c.status).toBe("not-applicable");
        expect(c.detail).toMatch(new RegExp(`N/A for ${pageType}`));
      }
    );

    it("is still expected on an article, and still fails when absent", () => {
      const c = find(scoreFreshnessSignals(bare, {}, "article"), LABEL);
      expect(c.status).toBeUndefined();
      expect(c.passed).toBe(false);
    });

    it("passes on an article that ships the timestamp", () => {
      const html = `<html><head><meta property="article:modified_time" content="2026-07-30"></head><body></body></html>`;
      const c = find(scoreFreshnessSignals(html, {}, "article"), LABEL);
      expect(c.passed).toBe(true);
      expect(c.status).toBeUndefined();
    });
  });

  describe("FAQPage schema", () => {
    const LABEL = "FAQPage schema";

    it.each(["homepage", "landing", "product", "article"] as const)(
      "is not applicable to a %s",
      (pageType) => {
        // FAQPage belongs on a page that is an FAQ. Rewarding it anywhere else
        // pushes the reader toward schema that misdescribes the page, and
        // Google deprecated FAQ rich results in May 2026 regardless.
        const c = find(scoreStructuredData([], new Set<string>(), pageType), LABEL);
        expect(c.status).toBe("not-applicable");
      }
    );

    it("is expected on an actual FAQ page", () => {
      const c = find(scoreStructuredData([], new Set<string>(), "faq"), LABEL);
      expect(c.status).toBeUndefined();
      expect(c.passed).toBe(false);
    });

    it("does not award points for FAQPage on a homepage that ships it anyway", () => {
      const withFaq = scoreStructuredData([], new Set(["FAQPage"]), "homepage");
      const without = scoreStructuredData([], new Set<string>(), "homepage");
      expect(withFaq.score).toBe(without.score);
    });
  });

  it("keeps every N/A check out of the applicable maximum", () => {
    // The N/A convention in this file is auto-credit plus exclusion from the
    // denominator. A check that is N/A must never make a page look worse.
    for (const pageType of NA_TYPES) {
      const cat = scoreFreshnessSignals("<html></html>", {}, pageType);
      const na = cat.checks.filter((c) => c.status);
      expect(na.length).toBeGreaterThan(0);
      for (const c of na) expect(c.passed).toBe(true);
    }
  });
});

describe("more page-type-blind checks found reviewing the whole breakdown", () => {
  const find = (cat: GeoCategory, needle: string) =>
    cat.checks.find((c) => c.label.includes(needle))!;

  describe('"Visible Q&A pattern" must require visible Q&A', () => {
    const FAQ_SCHEMA_ONLY = [{ "@type": "FAQPage", mainEntity: [] }];
    const noQaHtml = "<html><body><h2>Our services</h2><p>Prose.</p></body></html>";

    it("is gone from Content Structure, which scored the identical DOM test", () => {
      expect(scoreContentStructure(noQaHtml, "article").checks
        .some((c) => /Visible Q&A/i.test(c.label))).toBe(false);
    });

    it("does not pass on FAQPage schema alone", () => {
      const c = find(scoreQueryOptimization(noQaHtml, FAQ_SCHEMA_ONLY, "article"), "Visible Q&A");
      expect(c.passed).toBe(false);
    });

    it("still passes on a real disclosure pattern with no schema at all", () => {
      const html = "<html><body><details><summary>What is it?</summary><p>This.</p></details></body></html>";
      expect(find(scoreQueryOptimization(html, [], "article"), "Visible Q&A").passed).toBe(true);
    });
  });

  describe("Person schema, now measured only in AUTHOR / E-E-A-T", () => {
    it.each(["homepage", "landing", "product"] as const)(
      "is not applicable to a %s",
      (pageType) => {
        expect(find(scoreAuthorEeat("<html></html>", [], pageType), "Person schema").status).toBe("not-applicable");
      }
    );

    it("is still expected on an article", () => {
      expect(find(scoreAuthorEeat("<html></html>", [], "article"), "Person schema").status).toBeUndefined();
    });

    it("is gone from STRUCTURED DATA, which used to score the same markup", () => {
      expect(scoreStructuredData([], new Set<string>(), "article").checks
        .some((c) => /Person schema/i.test(c.label))).toBe(false);
    });
  });

  describe("statistics, now measured only in CITATION SIGNALS", () => {
    const bare = "<html><body><p>No numbers here at all.</p></body></html>";

    it("is not applicable to a homepage", () => {
      expect(find(scoreCitationSignals(bare, "homepage"), "Statistic").status).toBe("not-applicable");
    });

    it("is still expected on an article", () => {
      expect(find(scoreCitationSignals(bare, "article"), "Statistic").status).toBeUndefined();
    });

    it("is gone from CONTENT STRUCTURE, which used to score it by density", () => {
      expect(scoreContentStructure(bare, "article").checks
        .some((c) => /Statistic/i.test(c.label))).toBe(false);
    });
  });

  describe("article conventions are not demanded of a homepage", () => {
    const bare = "<html><body><h1>Welcome</h1><p>We do things.</p></body></html>";

    it.each([
      ["Blockquote elements present", "citationSignals"],
      ["Reference links", "citationSignals"],
    ])("marks %s as not applicable", (label) => {
      expect(find(scoreCitationSignals(bare, "homepage"), label).status).toBe("not-applicable");
    });

    it("marks TL;DR / summary as not applicable", () => {
      expect(find(scoreQueryOptimization(bare, [], "homepage"), "TL;DR / summary").status).toBe("not-applicable");
    });

    it("marks listicle formatting as not applicable", () => {
      // Listicle lives in CONTENT STRUCTURE.
      expect(find(scoreContentStructure(bare, "homepage"), "Listicle formatting").status)
        .toBe("not-applicable");
    });

    it("still expects all of them on an article", () => {
      const cs = scoreCitationSignals(bare, "article");
      const qo = scoreQueryOptimization(bare, [], "article");
      expect(find(cs, "Blockquote elements present").status).toBeUndefined();
      expect(find(cs, "Reference links").status).toBeUndefined();
      expect(find(qo, "TL;DR / summary").status).toBeUndefined();
      expect(find(scoreContentStructure(bare, "article"), "Listicle formatting").status)
        .toBeUndefined();
    });
  });
});

describe("Speakable schema is a bonus, never a penalty", () => {
  // Google restricts speakable results to publishers approved for Google News,
  // in specific locales. Page type cannot tell us whether a site is one, and for
  // almost every site implementing it produces nothing — so scoring its absence
  // as a 3-point failure docked points for not shipping a feature that would
  // have done nothing, and the recommendation told every site to add it.
  const PAGE_TYPES = ["homepage", "article", "product", "faq", "landing", "generic"] as const;
  const speakableOf = (cat: GeoCategory) =>
    cat.checks.find((c) => c.label.includes("Speakable"))!;

  it.each(PAGE_TYPES)("is not scored as a requirement on a %s", (pageType) => {
    const c = speakableOf(scoreStructuredData([], new Set<string>(), pageType));
    expect(c.status).toBe("not-applicable");
    expect(c.passed).toBe(true);
  });

  it("explains that it is unscored rather than claiming N/A for the page type", () => {
    const c = speakableOf(scoreStructuredData([], new Set<string>(), "article"));
    expect(c.detail).toMatch(/Google News/i);
    expect(c.detail).not.toMatch(/^N\/A for/);
  });

  it("acknowledges the schema when a site does ship it", () => {
    const c = speakableOf(
      scoreStructuredData([{ "@type": "WebPage", speakable: {} }], new Set(["SpeakableSpecification"]), "article")
    );
    expect(c.detail).toMatch(/present/i);
    expect(c.status).toBe("not-applicable");
  });

  it("never recommends adding it", () => {
    for (const pageType of PAGE_TYPES) {
      const cat = scoreStructuredData([], new Set<string>(), pageType);
      expect(buildRecommendations([cat]).join(" ")).not.toMatch(/Speakable/i);
    }
  });
});

describe("a category derives its own arithmetic", () => {
  // score and maxScore used to be maintained by hand beside the checks, so a
  // points value was written up to four times with nothing keeping them in step.
  // Getting one wrong silently changed a page's score.
  const ALL = (pageType: PageKind) => {
    const html = "<html><body><h1>x</h1></body></html>";
    return [
      scoreStructuredData([], new Set<string>(), pageType),
      scoreFreshness([], sitemapFound(""), pageType),
      scoreContentStructure(html, pageType),
      scoreAiCrawlerAccess(robotsFound(""), html, false),
      scoreAuthorEeat(html, [], pageType),
      scoreTechnical(html, 200),
      scoreContentCitability(html, pageType),
      scoreCitationSignals(html, pageType),
      scoreFreshnessSignals(html, {}, pageType),
      scoreQueryOptimization(html, [], pageType),
    ];
  };

  it.each(["homepage", "article", "product", "faq", "landing", "collection", "profile", "generic"] as const)(
    "keeps maxScore equal to the sum of its checks on a %s",
    (pageType) => {
      for (const cat of ALL(pageType)) {
        // Summed over the scorable checks only. A ceiling that includes a question
        // we never asked the page is the bug in #339: it is what made a homepage
        // print `CONTENT FRESHNESS: 15 / 15` and render as a green card.
        const sum = cat.checks
          .filter((c) => !c.status)
          .reduce((s, c) => s + c.points, 0);
        expect(cat.maxScore, `${cat.name} on a ${pageType}`).toBe(sum);
      }
    }
  );

  it.each(["homepage", "article", "generic"] as const)(
    "keeps score equal to what the checks earned on a %s",
    (pageType) => {
      for (const cat of ALL(pageType)) {
        // No `c.status ? c.points` branch: that branch WAS the defect. A check with
        // no answer contributes to neither side.
        const earned = cat.checks.reduce(
          (s, c) => s + (c.status ? 0 : c.earned ?? (c.passed ? c.points : 0)),
          0
        );
        expect(cat.score, `${cat.name} on a ${pageType}`).toBe(earned);
      }
    }
  );

  it("never lets score exceed maxScore", () => {
    for (const pageType of ["homepage", "article", "product", "faq"] as const) {
      for (const cat of ALL(pageType)) {
        expect(cat.score).toBeLessThanOrEqual(cat.maxScore);
      }
    }
  });

  it("derives the totals from every check the category holds, listicle included", () => {
    const html = "<html><body><h2>10 best tools</h2><ol><li>a</li><li>b</li><li>c</li></ol></body></html>";

    const article = scoreContentStructure(html, "article");
    const homepage = scoreContentStructure(html, "homepage");

    // This used to assert that a mutator rebuilt the totals it had just
    // invalidated. One function builds the category, so what is left to pin is
    // the property that mattered: the numbers come from the checks.
    expect(article.maxScore).toBe(article.checks.reduce((s, c) => s + c.points, 0));
    expect(findCheck(article, "Listicle")).toBeDefined();
    // A homepage owes no listicle, so those points leave the maximum entirely.
    expect(homepage.maxScore).toBeLessThan(article.maxScore);
  });
});

describe("partial credit is reported as partial, not as zero", () => {
  const dateModified = (iso: string) =>
    scoreFreshness([{ "@type": "Article", dateModified: iso }], sitemapFound(""), "article")
      .checks.find((c) => c.label.includes("Date modified"))!;

  const daysAgo = (n: number) => new Date(Date.now() - n * 86_400_000).toISOString();

  it("states what a half-earned check is worth and what it earned", () => {
    // `points` used to hold the EARNED amount for this one check, so a page
    // scoring 5 of 10 rendered as "0/5" and a stale page as a literal "0/0".
    const c = dateModified(daysAgo(120));
    expect(c.points).toBe(10);
    expect(c.earned).toBe(5);
    expect(c.passed).toBe(false);
  });

  it("earns nothing, out of ten, when the date is too old", () => {
    const c = dateModified(daysAgo(400));
    expect(c.points).toBe(10);
    expect(c.earned).toBe(0);
  });

  it("earns the full ten when fresh", () => {
    const c = dateModified(daysAgo(10));
    expect(c.points).toBe(10);
    expect(c.earned).toBe(10);
    expect(c.passed).toBe(true);
  });

  it("counts partial credit toward the category score", () => {
    const cat = scoreFreshness([{ "@type": "Article", dateModified: daysAgo(120) }], sitemapFound(""), "article");
    expect(cat.score).toBe(5);
    expect(cat.maxScore).toBe(15);
  });
});

describe("the freshness signal the audit of all 41 checks missed", () => {
  const bare = "<html><body><h1>Welcome</h1></body></html>";
  const find = (cat: GeoCategory, needle: string) =>
    cat.checks.find((c) => c.label.includes(needle))!;

  it.each(["homepage", "landing", "product", "faq"] as const)(
    "marks the JSON-LD freshness date as not applicable on a %s",
    (pageType) => {
      // The largest ungated value in GEO at 7 points, and the same signal that
      // CONTENT FRESHNESS and `article:*` already excuse. A homepage was N/A for
      // both of those and then still lost 7 points for the third.
      const c = find(scoreFreshnessSignals(bare, {}, pageType), "JSON-LD states when");
      expect(c.status).toBe("not-applicable");
    }
  );

  it("still expects it on an article, and still fails when absent", () => {
    const c = find(scoreFreshnessSignals(bare, {}, "article"), "JSON-LD states when");
    expect(c.status).toBeUndefined();
    expect(c.passed).toBe(false);
  });

  it("treats all three freshness-date checks consistently on one page", () => {
    // One signal, one verdict. These three used to disagree about a homepage.
    const structure = find(scoreFreshness([], sitemapFound(""), "homepage"), "Date modified within 90 days");
    const signals = scoreFreshnessSignals(bare, {}, "homepage");
    expect(structure.status).toBe("not-applicable");
    expect(find(signals, "JSON-LD states when").status).toBe("not-applicable");
    expect(find(signals, "Open Graph meta tag").status).toBe("not-applicable");
  });
});

describe("each signal is counted once", () => {
  // Four page properties used to be measured in two GEO Categories each, so one
  // piece of markup earned twice: Person schema was worth 9 points across
  // STRUCTURED DATA and AUTHOR / E-E-A-T, and statistics, visible Q&A and
  // question headings did the same. 34 of 165 points came from four signals.
  const html = "<html><body><h1>x</h1></body></html>";
  const every = (pageType: PageKind) => {
    return [
      scoreStructuredData([], new Set<string>(), pageType),
      scoreFreshness([], sitemapFound(""), pageType),
      scoreContentStructure(html, pageType),
      scoreAiCrawlerAccess(robotsFound(""), html, false),
      scoreAuthorEeat(html, [], pageType),
      scoreTechnical(html, 200),
      scoreContentCitability(html, pageType),
      scoreCitationSignals(html, pageType),
      scoreFreshnessSignals(html, {}, pageType),
      scoreQueryOptimization(html, [], pageType),
    ];
  };

  it.each([
    ["Person schema", /Person schema/i],
    ["statistics", /statistic/i],
    ["visible Q&A", /Visible Q&A/i],
    ["question headings", /question.{0,10}(?:based|phrased) H2\/H3/i],
  ])("measures %s in exactly one category", (_name, pattern) => {
    const hits = every("article").flatMap((c) =>
      c.checks.filter((k) => pattern.test(k.label)).map((k) => `${c.name}: ${k.label}`)
    );
    expect(hits, hits.join(" | ")).toHaveLength(1);
  });

  it("puts each merged signal in the category that owns the concept", () => {
    const home = (pattern: RegExp) =>
      every("article").find((c) => c.checks.some((k) => pattern.test(k.label)))!.name;

    // Person schema is an authority claim about a named human.
    expect(home(/Person schema/i)).toBe("AUTHOR / E-E-A-T");
    // Statistics are what an AI engine quotes — a citation signal.
    expect(home(/statistic/i)).toBe("CITATION SIGNALS");
    // Q&A and question headings both answer "does this match how people ask".
    expect(home(/Visible Q&A/i)).toBe("QUERY OPTIMIZATION");
    expect(home(/question.{0,10}(?:based|phrased) H2\/H3/i)).toBe("QUERY OPTIMIZATION");
  });

  it("no page newly fails a check it used to pass", () => {
    // Each merge kept the union of the two predicates, so a page that satisfied
    // either of the originals still satisfies the survivor.
    const withJobTitleOnly = scoreAuthorEeat(html, [{ "@type": "Person", jobTitle: "CTO" }], "article");
    expect(withJobTitleOnly.checks.find((c) => /Person schema/i.test(c.label))!.passed).toBe(true);

    // Statistics: two absolute matches but a low density in a long body.
    const long = `<html><body><p>${"word ".repeat(3000)} 40% and $50</p></body></html>`;
    expect(scoreCitationSignals(long, "article").checks.find((c) => /statistic/i.test(c.label))!.passed).toBe(true);

    // Question heading without a question mark, which only the broader test caught.
    const q = "<html><body><h2>How does indexing work</h2></body></html>";
    expect(scoreQueryOptimization(q, [], "article").checks.find((c) => /question.{0,10}phrased/i.test(c.label))!.passed).toBe(true);
  });
});

describe("schema in an @graph is found, not missed", () => {
  // Auditing joost.blog exposed this: the page ships one ld+json block whose
  // @graph holds WebSite, Person, BreadcrumbList and eight Organizations, and
  // every node check here ran a flat `schemas.find(s => s["@type"] === X)` so all
  // of them failed. That is the shape Yoast and Rank Math emit.
  const graph = [{
    "@context": "https://schema.org",
    "@graph": [
      { "@type": "WebSite", url: "https://joost.blog/" },
      { "@type": "Person", name: "Joost de Valk", sameAs: ["https://x.com/jdevalk", "https://linkedin.com/in/jdevalk"] },
      {
        "@type": "Organization", name: "Yoast", url: "https://yoast.com", logo: { "@type": "ImageObject" },
        sameAs: ["https://x.com/yoast", "https://linkedin.com/company/yoast"],
      },
      { "@type": "Article", author: { "@type": "Person" }, datePublished: "2026-01-01", dateModified: "2026-07-01" },
    ],
  }];
  const flat = [
    { "@type": "WebSite" },
    { "@type": "Organization", name: "Yoast", url: "https://yoast.com", logo: { "@type": "ImageObject" }, sameAs: ["https://x.com/yoast", "https://linkedin.com/company/yoast"] },
  ];
  const html = "<html><body><h1>x</h1></body></html>";
  const find = (cat: GeoCategory, needle: string) => cat.checks.find((c) => c.label.includes(needle))!;

  it("finds a publishing entity's sameAs inside a graph", () => {
    expect(find(scoreStructuredData(graph, new Set(["Organization"]), "article"), "Publishing entity with 2 or more identity links").passed).toBe(true);
  });

  it("finds a complete Article inside a graph", () => {
    expect(find(scoreStructuredData(graph, new Set(["Article"]), "article"), "Article schema naming an author").passed).toBe(true);
  });

  it("finds Person sameAs inside a graph", () => {
    expect(find(scoreAuthorEeat(html, graph, "article"), "Person schema").passed).toBe(true);
  });

  it("finds a publishing entity's url + logo inside a graph", () => {
    expect(find(scoreAuthorEeat(html, graph, "article"), "Publishing entity with url + logo").passed).toBe(true);
  });

  it("scores a graph page the same as the equivalent flat page", () => {
    const a = find(scoreStructuredData(graph, new Set(["Organization"]), "article"), "Publishing entity with 2 or more identity links");
    const b = find(scoreStructuredData(flat, new Set(["Organization"]), "article"), "Publishing entity with 2 or more identity links");
    expect(a.passed).toBe(b.passed);
  });

  it("still returns false when the graph genuinely lacks the node", () => {
    const thin = [{ "@graph": [{ "@type": "WebSite" }] }];
    expect(find(scoreStructuredData(thin, new Set(["WebSite"]), "article"), "Publishing entity with 2 or more identity links").passed).toBe(false);
    expect(find(scoreAuthorEeat(html, thin, "article"), "Person schema").passed).toBe(false);
  });
});

describe("the named author is read from schema, not only from prose", () => {
  // Auditing joost.blog/agent-native/ exposed this: the post declares
  // `Person: Joost de Valk` in its @graph and as the Article's author, names him
  // ten times in the body, and still failed "Named author" — because the check
  // only matched a literal "by <Name>" prose pattern that the page never writes.
  const graph = (author: unknown) => [{
    "@graph": [
      { "@type": "Article", headline: "x", author },
      { "@type": "Person", name: "Joost de Valk" },
    ],
  }];
  const bare = "<html><body><h1>A post</h1><p>Words about agents.</p></body></html>";
  const find = (cat: GeoCategory) => cat.checks.find((c) => c.label.includes("Named author"))!;

  it("accepts an author declared as a nested Person node", () => {
    const c = find(scoreAuthorEeat(bare, graph({ "@type": "Person", name: "Joost de Valk" }), "article"));
    expect(c.passed).toBe(true);
    expect(c.detail).toMatch(/Joost de Valk/);
  });

  it("accepts an author given as a plain string", () => {
    expect(find(scoreAuthorEeat(bare, graph("Joost de Valk"), "article")).passed).toBe(true);
  });

  it("accepts an author referenced by @id and resolved from the graph", () => {
    // Yoast emits `author: { "@id": "…#/schema/person/…" }` and the Person node
    // separately, which is a reference, not an inline object.
    const referenced = [{
      "@graph": [
        { "@type": "Article", author: { "@id": "https://joost.blog/#/schema/person/1" } },
        { "@type": "Person", "@id": "https://joost.blog/#/schema/person/1", name: "Joost de Valk" },
      ],
    }];
    expect(find(scoreAuthorEeat(bare, referenced, "article")).passed).toBe(true);
  });

  it("still rejects a generic author, however it is declared", () => {
    expect(find(scoreAuthorEeat(bare, graph({ "@type": "Person", name: "Editorial Team" }), "article")).passed).toBe(false);
    expect(find(scoreAuthorEeat(bare, graph("Admin"), "article")).passed).toBe(false);
  });

  it("still reads a prose byline when there is no schema at all", () => {
    const prose = "<html><body><p>by Marieke Rakt</p></body></html>";
    expect(find(scoreAuthorEeat(prose, [], "article")).passed).toBe(true);
  });

  it("prefers schema over prose for a name the prose pattern cannot parse", () => {
    // The prose regex wants two capitalised words, so Dutch and Spanish names
    // carrying a lowercase particle — "van de Rakt", "de Valk", "del Toro" —
    // never matched it. Reading the declaration instead sidesteps that entirely.
    const prose = "<html><body><p>by Marieke van de Rakt</p></body></html>";
    expect(find(scoreAuthorEeat(prose, [], "article")).passed).toBe(false);

    const declared = [{ "@graph": [{ "@type": "Article", author: { "@type": "Person", name: "Marieke van de Rakt" } }] }];
    const c = find(scoreAuthorEeat(prose, declared, "article"));
    expect(c.passed).toBe(true);
    expect(c.detail).toMatch(/van de Rakt/);
  });

  it("fails when neither source names anyone", () => {
    expect(find(scoreAuthorEeat(bare, [], "article")).passed).toBe(false);
  });
});

describe("a Person can be the publishing entity", () => {
  // joost.blog declares eight Organizations — all companies its author is involved
  // with, none of them the publisher — and identifies the site through a Person.
  // Demanding an Organization there is the same error as demanding Article of a
  // homepage: the wrong type for what the page is.
  const html = "<html><body><h1>x</h1></body></html>";
  const find = (cat: GeoCategory, needle: string) => cat.checks.find((c) => c.label.includes(needle))!;

  const personSite = [{
    "@graph": [
      { "@type": "WebSite", url: "https://joost.blog/" },
      {
        "@type": "Person", name: "Joost de Valk", url: "https://joost.blog/about-me/",
        image: { "@type": "ImageObject", url: "https://joost.blog/portrait.jpg" },
        sameAs: ["https://x.com/jdevalk", "https://linkedin.com/in/jdevalk", "https://www.wikidata.org/wiki/Q1"],
      },
      { "@type": "Organization", name: "Yoast", url: "https://yoast.com/" },
      { "@type": "Organization", name: "Emilia Capital", url: "https://emilia.capital/" },
    ],
  }];

  it("accepts a Person's sameAs as the entity's identity links", () => {
    const c = find(scoreStructuredData(personSite, new Set(["Person"]), "article"), "Publishing entity with 2 or more identity links");
    expect(c.passed).toBe(true);
  });

  it("accepts a Person's image where an Organization would carry a logo", () => {
    const c = find(scoreAuthorEeat(html, personSite, "article"), "Publishing entity with url + logo");
    expect(c.passed).toBe(true);
    expect(c.detail).toMatch(/Person with url and image/);
  });

  it("still prefers an Organization that qualifies over a Person that does not", () => {
    const companySite = [{
      "@graph": [
        { "@type": "Person", name: "An employee" },
        { "@type": "Organization", name: "Yoast", url: "https://yoast.com/", logo: { "@type": "ImageObject" }, sameAs: ["https://x.com/yoast", "https://linkedin.com/company/yoast"] },
      ],
    }];
    const c = find(scoreAuthorEeat(html, companySite, "article"), "Publishing entity with url + logo");
    expect(c.passed).toBe(true);
    expect(c.detail).toMatch(/Organization with url and logo/);
  });

  it("still fails when neither an Organization nor a Person carries the identity", () => {
    const thin = [{ "@graph": [{ "@type": "WebSite" }, { "@type": "Person", name: "Someone" }] }];
    expect(find(scoreStructuredData(thin, new Set(["Person"]), "article"), "Publishing entity with 2 or more identity links").passed).toBe(false);
    expect(find(scoreAuthorEeat(html, thin, "article"), "Publishing entity with url + logo").passed).toBe(false);
  });
});

// ── #312: the Article check and the sitemap lastmod check ─────────────────────

describe("Article schema check accepts every Article subtype (#312)", () => {
  const find = (cat: GeoCategory, needle: string) => findCheck(cat, needle)!;
  const LABEL = "Article schema naming an author";
  const complete = (type: string) => [{
    "@type": type,
    author: { "@id": "#founder" },
    datePublished: "2026-01-01",
    dateModified: "2026-08-01",
  }];

  // page-identity classifies a page as an article using ARTICLE_TYPES, which includes
  // TechArticle and Report. The check used a narrower list, so those pages were
  // classified as articles and then failed for not being one — 7 points no markup
  // could earn.
  it.each(["Article", "BlogPosting", "NewsArticle", "TechArticle", "Report"])(
    "awards the full 7 points to a complete %s",
    (type) => {
      const check = find(scoreStructuredData(complete(type), new Set([type]), "article"), LABEL);
      expect(check.passed).toBe(true);
    }
  );

  it("still fails an Article subtype that is missing a required field", () => {
    const partial = [{ "@type": "TechArticle", author: { "@id": "#founder" }, datePublished: "2026-01-01" }];
    const check = find(scoreStructuredData(partial, new Set(["TechArticle"]), "article"), LABEL);
    expect(check.passed).toBe(false);
    expect(check.detail).toMatch(/missing author, datePublished or dateModified/);
  });

  it("reports no article schema at all differently from an incomplete one", () => {
    const check = find(scoreStructuredData([{ "@type": "WebPage" }], new Set(["WebPage"]), "article"), LABEL);
    expect(check.passed).toBe(false);
    expect(check.detail).toBe("No Article schema found");
  });
});

describe("sitemap lastmod is matched to the analyzed page (#312)", () => {
  const find = (cat: GeoCategory) => findCheck(cat, "Sitemap lastmod agrees")!;
  const PAGE = "https://example.com/b";
  const schemas = [{ "@type": "Article", dateModified: "2026-08-01" }];

  const sitemap = (entries: Array<[string, string?]>) =>
    `<urlset>${entries
      .map(([loc, lastmod]) => `<url><loc>${loc}</loc>${lastmod ? `<lastmod>${lastmod}</lastmod>` : ""}</url>`)
      .join("")}</urlset>`;

  it("ignores an earlier entry belonging to a different page", () => {
    // The old implementation took the first <lastmod> in the document. Here that
    // belongs to /a and is 8 months stale; /b's own date matches the schema.
    const xml = sitemap([["https://example.com/a", "2026-01-01"], [PAGE, "2026-08-01"]]);
    expect(find(scoreFreshness(schemas, sitemapFound(xml), "article", PAGE)).passed).toBe(true);
  });

  it("fails when the page's own lastmod disagrees with dateModified", () => {
    const xml = sitemap([[PAGE, "2026-01-01"]]);
    const check = find(scoreFreshness(schemas, sitemapFound(xml), "article", PAGE));
    expect(check.passed).toBe(false);
    expect(check.detail).toMatch(/differs by \d+ days/);
  });

  it("treats a page absent from the sitemap as its own finding, not a date mismatch", () => {
    const xml = sitemap([["https://example.com/a", "2026-08-01"]]);
    const check = find(scoreFreshness(schemas, sitemapFound(xml), "article", PAGE));
    expect(check.passed).toBe(false);
    expect(check.detail).toBe("Page is not listed in the sitemap");
  });

  it("distinguishes a listed page with no lastmod from an unlisted one", () => {
    const xml = sitemap([[PAGE]]);
    expect(find(scoreFreshness(schemas, sitemapFound(xml), "article", PAGE)).detail)
      .toBe("Sitemap lists this page but publishes no lastmod for it");
  });

  it("matches regardless of a trailing slash", () => {
    const xml = sitemap([[`${PAGE}/`, "2026-08-01"]]);
    expect(find(scoreFreshness(schemas, sitemapFound(xml), "article", PAGE)).passed).toBe(true);
  });

  it("says why it could not run rather than comparing against an unrelated entry", () => {
    const xml = sitemap([["https://example.com/a", "2026-01-01"]]);
    expect(find(scoreFreshness(schemas, sitemapFound(xml), "article")).detail)
      .toBe("No page URL supplied, cannot match a sitemap entry");
    expect(find(scoreFreshness(schemas, sitemapFound(""), "article", PAGE)).detail)
      .toBe("No sitemap available to check");
  });

  it("does not call a sitemap it could not read a page that is not listed (#346)", () => {
    const check = find(scoreFreshness(schemas, sitemapUnavailable("the index's children 5xx'd"), "article", PAGE));

    expect(check.status).toBe("not-evaluated");
    // The canonical sentence, since #337's follow-up: reason first, then the half
    // that four of the five old wordings never said.
    expect(check.detail).toContain("Not scored: the index's children 5xx'd");
    expect(check.detail).toContain("not a finding about the page");
    // Out of both halves of the fraction, which is the point of the status.
    expect(check.detail).not.toContain("not listed");
  });

  it("still scores a site with no sitemap at all as a failure", () => {
    // `absent` is a finding: the site has no sitemap. Telling that apart from
    // "we could not read one" is the whole reason the read is three-state.
    const check = find(scoreFreshness(schemas, sitemapAbsent(), "article", PAGE));

    expect(check.status).toBeUndefined();
    expect(check.passed).toBe(false);
    expect(check.detail).toBe("No sitemap available to check");
  });
});

/**
 * A crawler check must say something its own label does not.
 *
 * Each of the four read "GPTBot is allowed" under a label reading "GPTBot allowed
 * in robots.txt". That was harmless while `CheckRow` discarded details on scored
 * rows and became four rows of the same sentence twice the moment it stopped.
 *
 * The replacement is not just different wording: it distinguishes the two ways a
 * crawler can be allowed, which the label cannot and which the three-state read
 * already knows.
 */
describe("scoreAiCrawlerAccess — the detail earns its line", () => {
  const BOTS = ["GPTBot", "PerplexityBot", "ClaudeBot", "Google-Extended"];

  const detailFor = (cat: ReturnType<typeof scoreAiCrawlerAccess>, bot: string) =>
    cat.checks.find((c) => c.label === `${bot} allowed in robots.txt`)?.detail;

  it("never restates the label it sits under", () => {
    const cat = scoreAiCrawlerAccess(robotsFound("User-agent: *\nAllow: /"), "<html></html>", false);
    for (const bot of BOTS) {
      expect(detailFor(cat, bot), bot).not.toBe(`${bot} is allowed`);
    }
  });

  it("tells 'no robots.txt' apart from 'a robots.txt with no rule against you'", () => {
    // Both are a pass, for different reasons, and only one changes meaning if the
    // site later publishes a robots.txt.
    const absent = scoreAiCrawlerAccess(
      { outcome: "absent" as const, status: 404 } as Parameters<typeof scoreAiCrawlerAccess>[0],
      "<html></html>",
      false
    );
    const present = scoreAiCrawlerAccess(robotsFound("User-agent: *\nAllow: /"), "<html></html>", false);

    expect(detailFor(absent, "GPTBot")).toContain("No /robots.txt");
    expect(detailFor(present, "GPTBot")).toContain("no Disallow rule matching GPTBot");
    expect(detailFor(absent, "GPTBot")).not.toBe(detailFor(present, "GPTBot"));
  });

  it("names the reason when a bot is blocked", () => {
    const cat = scoreAiCrawlerAccess(
      robotsFound("User-agent: GPTBot\nDisallow: /"),
      "<html></html>",
      false
    );
    expect(detailFor(cat, "GPTBot")).toContain("Disallow rule");
    // And the others in the same file are untouched by it.
    expect(detailFor(cat, "ClaudeBot")).toContain("no Disallow rule matching ClaudeBot");
  });

  it("still scores all four, with their own weights", () => {
    // The loop replaced four hand-written blocks; the points must not have moved.
    const cat = scoreAiCrawlerAccess(robotsFound("User-agent: *\nAllow: /"), "<html></html>", false);
    expect(BOTS.map((b) => cat.checks.find((c) => c.label === `${b} allowed in robots.txt`)?.points))
      .toEqual([5, 3, 3, 2]);
  });
});
