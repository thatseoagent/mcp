import { describe, it, expect } from "vitest";
import { page } from "../../helpers/parsed-page";
import {
  checkContentFreshness,
  toGrade,
  scoreL4,
  scoreL1,
  analyzeL2,
  detectVertical,
  entityDensity,
  buildTopActions,
} from "@/lib/analyzers/ai-visibility-analyzer";
import { qualifier } from "@/lib/analyzers/check-source";
import type { TrustPageFinding } from "@/lib/site-trust-pages";

// Fixed reference date for all freshness tests: 2026-04-01
const NOW = new Date("2026-04-01").getTime();

// ── checkContentFreshness ─────────────────────────────────────────────────────

describe("checkContentFreshness", () => {
  it("returns 'fresh' for dateModified 44 days ago", () => {
    // 2026-02-15 is 44 days before 2026-04-01
    const html = `<html><head></head><body>content</body></html>`;
    const schemas = [{ "@type": "Article", dateModified: "2026-02-15" }];
    expect(checkContentFreshness(html, schemas, NOW)).toBe("fresh");
  });

  it("returns 'aging' for datePublished 151 days ago with no dateModified", () => {
    // 2025-11-01 is 151 days before 2026-04-01 (Nov has 30 days: 30 days in Nov + 31 in Dec + 31 in Jan + 28 in Feb + 31 in Mar = 151)
    const html = `<html><head></head><body>content</body></html>`;
    const schemas = [{ "@type": "Article", datePublished: "2025-11-01" }];
    expect(checkContentFreshness(html, schemas, NOW)).toBe("aging");
  });

  it("returns 'stale' for article:modified_time 212 days ago with no schemas", () => {
    // 2025-09-01 is 212 days before 2026-04-01
    const html = `<html><head><meta property="article:modified_time" content="2025-09-01"></head><body>content</body></html>`;
    expect(checkContentFreshness(html, [], NOW)).toBe("stale");
  });

  it("returns 'unknown' for dateModified with invalid date string", () => {
    const html = `<html><head></head><body>content</body></html>`;
    const schemas = [{ "@type": "Article", dateModified: "not-a-date" }];
    expect(checkContentFreshness(html, schemas, NOW)).toBe("unknown");
  });

  it("returns 'aging' for dateModified 75 days ago (past the 60-day fresh window)", () => {
    // 2026-01-16 is 75 days before 2026-04-01 — fresh threshold is now ≤60 days
    const html = `<html><head></head><body>content</body></html>`;
    const schemas = [{ "@type": "Article", dateModified: "2026-01-16" }];
    expect(checkContentFreshness(html, schemas, NOW)).toBe("aging");
  });
});

// ── entityDensity (named-entity proxy, replaces Speakable check) ───────────────

describe("entityDensity", () => {
  it("scores entity-dense prose above the 8% threshold", () => {
    const text = "Top CRM options include Salesforce, HubSpot, and Pipedrive. Marketers at Acme Corp use Salesforce daily.";
    expect(entityDensity(text)).toBeGreaterThanOrEqual(0.08);
  });

  it("scores generic lowercase prose near zero", () => {
    const text = "there are several popular tools on the market and many of them work well for small teams.";
    expect(entityDensity(text)).toBeLessThan(0.08);
  });

  it("does not count the first word of a sentence as an entity", () => {
    // "Tools" is sentence-initial and should be skipped → density 0
    const text = "Tools matter a lot here.";
    expect(entityDensity(text)).toBe(0);
  });
});

// ── toGrade ───────────────────────────────────────────────────────────────────

describe("toGrade", () => {
  it("returns 'Strong' for score 85/100 (pct 0.85, exactly at threshold)", () => {
    expect(toGrade(85, 100)).toBe("Strong");
  });

  it("returns 'Moderate' for score 84/100 (pct 0.84, below Strong threshold)", () => {
    expect(toGrade(84, 100)).toBe("Moderate");
  });

  it("returns 'Moderate' for score 60/100 (pct 0.60, exactly at threshold)", () => {
    expect(toGrade(60, 100)).toBe("Moderate");
  });

  it("returns 'Weak' for score 59/100 (pct 0.59, below Moderate threshold)", () => {
    expect(toGrade(59, 100)).toBe("Weak");
  });

  it("returns 'Weak' for score 35/100 (pct 0.35, exactly at threshold)", () => {
    expect(toGrade(35, 100)).toBe("Weak");
  });

  it("returns 'Not Established' for score 34/100 (pct 0.34, below Weak threshold)", () => {
    expect(toGrade(34, 100)).toBe("Not Established");
  });
});

// ── scoreL4 ───────────────────────────────────────────────────────────────────

describe("scoreL4", () => {
  const allowedAccess = { blocked: [], status: "ok" as const };
  const _blockedAccess = { blocked: ["GPTBot"], status: "blocked" as const };

  it("returns score > 0 with allBotsAllowed and fresh content", () => {
    // Minimal valid HTML with some content to trigger at least one check
    const html = `<html><body><p>This is a test page with some basic content for scoring.</p></body></html>`;
    const result = scoreL4(page(html), allowedAccess, "fresh", "article");
    expect(result.score).toBeGreaterThan(0);
  });

  it("passes the word-count sweet spot at ~1000 words (within 800–1500)", () => {
    const words = Array.from({ length: 1000 }, (_, i) => `word${i}`).join(" ");
    const html = `<html><body><p>${words}</p></body></html>`;
    const result = scoreL4(page(html), allowedAccess, "unknown", "article");
    const wordCountCheck = result.checks.find((c) => c.name.includes("800–1500"));
    expect(wordCountCheck?.passed).toBe(true);
  });

  it("fails the word-count sweet spot at 600 words (below the 800-word floor)", () => {
    const words = Array.from({ length: 600 }, (_, i) => `word${i}`).join(" ");
    const html = `<html><body><p>${words}</p></body></html>`;
    const result = scoreL4(page(html), allowedAccess, "unknown", "article");
    const wordCountCheck = result.checks.find((c) => c.name.includes("800–1500"));
    expect(wordCountCheck?.passed).toBe(false);
  });

  it("passes FAQPage schema check with FAQ JSON-LD and 2 H2 questions", () => {
    const faqSchema = JSON.stringify({
      "@type": "FAQPage",
      "mainEntity": [
        { "@type": "Question", "name": "What is SEO?" },
        { "@type": "Question", "name": "How does SEO work?" },
      ],
    });
    const html = `<html><body>
      <script type="application/ld+json">${faqSchema}</script>
      <h2>What is SEO?</h2>
      <p>SEO is a method for improving search rankings.</p>
      <h2>How does SEO work?</h2>
      <p>SEO works by optimizing content and links.</p>
    </body></html>`;
    const result = scoreL4(page(html), allowedAccess, "unknown", "article");
    const faqCheck = result.checks.find((c) => c.name.includes("FAQPage"));
    expect(faqCheck?.passed).toBe(true);
    const questionCheck = result.checks.find((c) => c.name.includes("question"));
    expect(questionCheck?.passed).toBe(true);
  });

  it("scores lower with freshness 'aging' than with freshness 'fresh'", () => {
    const html = `<html><body><p>Basic content page.</p></body></html>`;
    const freshResult = scoreL4(page(html), allowedAccess, "fresh", "article");
    const agingResult = scoreL4(page(html), allowedAccess, "aging", "article");
    expect(agingResult.score).toBeLessThan(freshResult.score);
  });

  it("scores named-entity density and no longer scores Speakable schema", () => {
    const html = `<html><body><p>content</p></body></html>`;
    const result = scoreL4(page(html), allowedAccess, "unknown", "article");
    expect(result.checks.some((c) => c.name.includes("Named-entity density"))).toBe(true);
    expect(result.checks.some((c) => c.name.toLowerCase().includes("speakable"))).toBe(false);
  });
});

// ── Source-attribution guards (#244 follow-up: framework alignment) ───────────
// These lock in the corrections from cross-checking the AI Visibility Framework
// against original sources (Yext, ConvertMate, Kevin Indig).

describe("source-attribution corrections", () => {
  it("scoreL1 directory detail does NOT misattribute the Yext stat as '48.7% local citations'", () => {
    // No Org schema, no directory links → triggers the not-found detail
    const html = `<html><body><p>plain page with no directory links</p></body></html>`;
    const { checks } = scoreL1([], html, { found: false }, { found: false }, "saas", false);
    const dirCheck = checks.find((c) => c.name.toLowerCase().includes("director"));
    expect(dirCheck).toBeDefined();
    expect(dirCheck?.detail).not.toContain("48.7%");
    expect(dirCheck?.detail).not.toMatch(/gates/i);
  });

  it("analyzeL2 author signal does NOT claim 'author schema = 3x' (that 3x is ConvertMate review profiles)", () => {
    const html = `<html><body><p>page with no person schema</p></body></html>`;
    const { signals } = analyzeL2(page(html), [], { answer: "absent" });
    const authorSignal = signals.find((s) => s.name.toLowerCase().includes("author"));
    expect(authorSignal).toBeDefined();
    expect(authorSignal?.detail).not.toContain("3x");
  });

  // Detecting the about page itself moved to `site-trust-pages`, which is where the
  // localized-slug and schema cases are now tested. What is left here is what this
  // analyzer still decides: what it tells the reader about the answer it was handed.
  const aboutSignal = (finding: TrustPageFinding) =>
    analyzeL2(page("<html><body><p>contenido</p></body></html>"), [], finding)
      .signals.find((s) => s.name.toLowerCase().includes("about"));

  it("analyzeL2 reports an about page found on the site as found, not as missing", () => {
    const about = aboutSignal({ answer: "present", where: "home" });
    expect(about?.found).toBe(true);
    // The advice this issue exists to stop: telling a site with a full about page to
    // go and write one, because the analyzed page's template did not link it (#340).
    expect(about?.detail).not.toMatch(/create one/i);
    expect(about?.detail).toMatch(/site home/i);
  });

  it("analyzeL2 still asks for an about page when the site genuinely has none", () => {
    const about = aboutSignal({ answer: "absent" });
    expect(about?.found).toBe(false);
    expect(about?.detail).toMatch(/create one/i);
  });

  it("analyzeL2 does not advise anything when the site could not be checked", () => {
    const about = aboutSignal({ answer: "unknown", reason: "the site home could not be read on this run" });
    expect(about?.found).toBe(false);
    expect(about?.detail).toMatch(/not checked/i);
    expect(about?.detail).not.toMatch(/create one/i);
  });
});

// ── detectVertical ────────────────────────────────────────────────────────────

describe("detectVertical", () => {
  it("detects 'local' from LocalBusiness schema type", () => {
    const html = `<html><head></head><body>Our business</body></html>`;
    const schemas = [{ "@type": "LocalBusiness", name: "Joe's Plumbing" }];
    expect(detectVertical(html, schemas)).toBe("local");
  });

  it("detects 'healthcare' from MedicalOrganization schema type", () => {
    const html = `<html><head></head><body>Medical services</body></html>`;
    const schemas = [{ "@type": "MedicalOrganization", name: "City Clinic" }];
    expect(detectVertical(html, schemas)).toBe("healthcare");
  });

  it("returns 'generic' for HTML with no schemas and no keyword signals", () => {
    const html = `<html><head></head><body>Welcome to our website. We offer great value.</body></html>`;
    expect(detectVertical(html, [])).toBe("generic");
  });

  it("does NOT classify a SEO monitoring SaaS as 'finance' (regression #287: bare 'portfolio' triggered finance)", () => {
    // seolvl.com-like copy: "portfolio" means a portfolio of SITES, not investments.
    const html = `<html><body>
      <h1>SEO health & authority for the sites you ship</h1>
      <p>Bootstrappers & portfolio operators. Monitor your backlink authority score
      across every site from one dashboard. Add a domain and it's monitored from minute one.</p>
    </body></html>`;
    const vertical = detectVertical(html, []);
    expect(vertical).not.toBe("finance");
    // SaaS signals present (dashboard, monitor across sites) → should read as saas
    expect(vertical).toBe("saas");
  });

  it("still classifies genuine finance content as 'finance' (guard against over-correction)", () => {
    const html = `<html><body><p>Grow your investment portfolio with our wealth management
      and brokerage services. Talk to a financial advisor about your mortgage today.</p></body></html>`;
    expect(detectVertical(html, [])).toBe("finance");
  });

  it("schema-first: WebApplication schema wins over finance keywords in body text", () => {
    // Body mentions finance terms, but the page declares itself a web app via schema.
    const html = `<html><body><p>Manage your investment portfolio and mortgage.</p></body></html>`;
    const schemas = [{ "@type": "WebApplication", name: "Fintools" }];
    expect(detectVertical(html, schemas)).toBe("saas");
  });

  // ── i18n: Spanish copy must classify like its English equivalent (not 'generic') ──

  it("classifies a Spanish SaaS as 'saas'", () => {
    const html = `<html><body><p>La plataforma de software para tu equipo. Empieza tu
      prueba gratis y explora el panel y las integraciones.</p></body></html>`;
    expect(detectVertical(html, [])).toBe("saas");
  });

  it("classifies a Spanish law firm as 'legal'", () => {
    const html = `<html><body><p>Bufete de abogados con amplia experiencia en litigio.
      Ofrecemos servicios legales a medida.</p></body></html>`;
    expect(detectVertical(html, [])).toBe("legal");
  });

  it("classifies a Spanish clinic as 'healthcare'", () => {
    const html = `<html><body><p>Nuestro centro medico ofrece telemedicina y atencion
      al paciente. Reserva tu cita medica hoy.</p></body></html>`;
    expect(detectVertical(html, [])).toBe("healthcare");
  });

  it("classifies a Spanish finance site as 'finance'", () => {
    const html = `<html><body><p>Solicita tu hipoteca y habla con un asesor financiero
      sobre la gestion de patrimonio.</p></body></html>`;
    expect(detectVertical(html, [])).toBe("finance");
  });

  it("classifies a Spanish ecommerce as 'ecommerce'", () => {
    const html = `<html><body><p>Agregar al carrito. Envio gratis en tu compra.
      Finalizar compra en nuestra tienda online.</p></body></html>`;
    expect(detectVertical(html, [])).toBe("ecommerce");
  });

  it("classifies a Spanish marketing agency as 'agency'", () => {
    const html = `<html><body><p>Somos una agencia de marketing digital. Ayudamos a
      marcas a crecer.</p></body></html>`;
    expect(detectVertical(html, [])).toBe("agency");
  });
});

/**
 * Where each L1/L4 finding gets its authority.
 *
 * This analyzer is the best-sourced thing in the product and read like the worst.
 * `cerebro/visibility_framework/sources.md` traces every figure it reports — the
 * 44.2% to Kevin Indig / Gauge over 1.2M citations, the 20.6% entity density to
 * the same work, the 3× to ConvertMate on active review profiles, the 42% to Yext
 * over 6.8M citations — and even records the misattributions that were caught and
 * corrected. None of that reached the reader. A user saw "44.2% of AI citations
 * come from the first 30% of content" as our bare assertion.
 *
 * `docs/google-search-central-conformance.md` §4 gave findings three kinds:
 * Google's, ours, and accessibility. None of the three is true of a third-party
 * study, which is why this analyzer could not simply copy its sibling's fix:
 * calling Indig a `heuristic` throws away the study, and `google` would be a lie.
 * Hence the fourth kind.
 */
describe("provenance", () => {
  const html = "<html><body><p>short</p></body></html>";
  const BOTS_OK = { blocked: [], status: "ok" as const, allBotsAllowed: true };

  it("marks a research-backed check with the study, not as our own judgement", () => {
    const l4 = scoreL4(page(html), BOTS_OK, "unknown", "article");
    const check = l4.checks.find((c) => c.name.includes("first 30%"))!;

    expect(check.source?.kind).toBe("research");
    if (check.source?.kind !== "research") return;
    expect(check.source.study).toMatch(/Indig|Gauge/);
    // The reader gets the study name, so the figure stops looking like ours.
    expect(qualifier(check.source)).toMatch(/Indig|Gauge/);
    expect(qualifier(check.source)).not.toMatch(/That SEO Agent heuristic/);
  });

  it("declares a source on every L1 and L4 check", () => {
    const l1 = scoreL1([], html, { found: false }, { found: false }, "generic", false);
    const l4 = scoreL4(page(html), BOTS_OK, "unknown", "article");

    for (const check of [...l1.checks, ...l4.checks]) {
      expect(check.source, `check "${check.name}" declares no source`).toBeDefined();
    }
  });

  it("declares a source on every L2 signal", () => {
    for (const signal of analyzeL2(page(html), [], { answer: "absent" }).signals) {
      expect(signal.source, `signal "${signal.name}" declares no source`).toBeDefined();
    }
  });

  it("still calls our own judgement ours", () => {
    // The fourth kind is not an excuse to relabel heuristics as research. A check
    // with no study behind it must still say it is ours.
    const l1 = scoreL1([], html, { found: false }, { found: false }, "generic", false);
    const ours = l1.checks.filter((c) => c.source?.kind === "heuristic");

    expect(ours.length).toBeGreaterThan(0);
    for (const check of ours) {
      expect(qualifier(check.source!)).toMatch(/That SEO Agent heuristic/);
    }
  });
});

/**
 * Two claims that exceeded their own sources.
 *
 * Both survived the sweep that removed "~3× the rate" and "the sweet spot" from
 * the GEO analyzer, because they live here. Having a source is not the same as
 * saying what the source says.
 */
describe("claims held to what the study found", () => {
  const BOTS_OK = { blocked: [], status: "ok" as const, allBotsAllowed: true };
  it("does not call a word-count range an AI sweet spot", () => {
    // Indig and Dejan measured grounding *coverage* by page length. That is not a
    // rule about how long a page should be, and `docs/…-conformance.md` §1.1
    // records that Google has no such rule. "Sweet spot" is also the exact phrase
    // §1.11 struck from the sibling analyzer.
    const l4 = scoreL4(page("<html><body><p>short</p></body></html>"), BOTS_OK, "unknown", "article");
    const lengthCheck = l4.checks.find((c) => /800/.test(c.name))!;

    expect(lengthCheck).toBeDefined();
    expect(lengthCheck.name).not.toMatch(/sweet spot/i);
    expect(lengthCheck.detail).not.toMatch(/sweet spot/i);
    // The measurement itself stays — it is what makes the check actionable.
    expect(lengthCheck.detail).toMatch(/grounding/i);
  });

  it("does not call Q&A the most-cited format", () => {
    // The source says 72.4% of ChatGPT-cited posts had answer capsules. That is
    // not "the most-cited content format", and no platform publishes a ranking of
    // formats at all.
    const bare = "<html><body><p>x</p></body></html>";
    const l1 = scoreL1([], bare, { found: false }, { found: false }, "generic", false);
    const l4 = scoreL4(page(bare), BOTS_OK, "unknown", "article");
    const actions = buildTopActions(
      { checks: l1.checks },
      { checks: l4.checks, wordCount: l4.wordCount },
      analyzeL2(page("<html><body></body></html>"), [], { answer: "absent" }),
      "generic"
    ).join("\n");

    expect(actions).not.toMatch(/most-cited|most cited/i);
  });
});

describe("a claim about someone else's site is not settled by a page fetch (#341)", () => {
  const l1Of = (html: string) =>
    scoreL1([{ "@type": "Organization", name: "Acme", url: "https://acme.example" }], html, { found: false }, { found: false }, "generic", false);

  const dirCheck = (html: string) =>
    l1Of(html).checks.find((c) => c.name.includes("vertical directories"));

  it("does not fail a brand for a directory listing this page cannot see", () => {
    // The name asserted the brand is listed on G2/Clutch/Yelp; the method measured
    // outbound links from one document. A brand genuinely listed and not linking out
    // lost 7 points for it.
    const check = dirCheck(`<html><body><p>no links at all</p></body></html>`);
    expect(check?.status).toBe("not-evaluated");
    expect(check?.detail).toMatch(/cannot be read from here/);
  });

  it("still credits a page that does link its directory profile", () => {
    // The evidence is asymmetric, the same way #340's trust pages are: a link is weak
    // but real evidence the profile exists, its absence is evidence of nothing.
    const check = dirCheck(`<html><body><a href="https://www.crunchbase.com/organization/acme">Crunchbase</a><a href="https://www.trustpilot.com/review/acme">Trustpilot</a></body></html>`);
    expect(check?.status).toBeUndefined();
    expect(check?.passed).toBe(true);
  });

  it("says what it measures in its name", () => {
    expect(dirCheck(`<html><body></body></html>`)?.name).toMatch(/^Links to /);
  });
});

describe("the expand-your-page action is reachable again (#341)", () => {
  const BOTS_OK = { blocked: [], status: "ok" as const, allBotsAllowed: true };
  const actionsFor = (html: string) => {
    const l1 = scoreL1([], html, { found: false }, { found: false }, "generic", false);
    const l4 = scoreL4(page(html), BOTS_OK, "unknown", "article");
    return buildTopActions(
      { checks: l1.checks },
      { checks: l4.checks, wordCount: l4.wordCount },
      analyzeL2(page(html), [], { answer: "absent" }),
      "generic",
    ).join("\n");
  };

  it("fires for a page below the measured range", () => {
    // Keyed on `c.detail.includes("below")` against a detail rewritten to stop calling
    // the range a rule, so it could never be emitted.
    expect(actionsFor(`<html><body><main><p>Three words only.</p></main></body></html>`)).toMatch(/Expand key pages/);
  });

  it("does not tell a 4,000-word page to expand", () => {
    const long = `<html><body><main><p>${"palabra ".repeat(4000)}</p></main></body></html>`;
    expect(actionsFor(long)).not.toMatch(/Expand key pages/);
  });
});

describe("a page is not marked down for the language it is written in (#342)", () => {
  const BOTS_OK = { blocked: [], status: "ok" as const, allBotsAllowed: true };
  const l4Of = (html: string) => scoreL4(page(html), BOTS_OK, "unknown", "article");
  const check = (html: string, name: string) =>
    l4Of(html).checks.find((c) => c.name.includes(name));

  const SPANISH = `<!DOCTYPE html><html lang="es"><body><main>
    <h2>¿Qué es el <strong>SEO técnico</strong>?</h2>
    <p>El SEO técnico es una disciplina que se ocupa del rastreo y de la indexación,
       y atendemos a 2 millones de usuarios cada mes desde que Ángel dirige el equipo
       en México con un enfoque medible y honesto.</p>
    <h3>¿Cómo <em>funciona</em>?</h3>
    <p>Se define como el conjunto de ajustes que hacen que la web resulte legible para
       un buscador, y consiste en revisar la arquitectura, los tiempos de carga y la
       forma en la que el sitio declara sus contenidos.</p>
    <p>${"Cada ajuste se documenta y se vuelve a medir en la siguiente revisión. ".repeat(6)}</p>
  </main></body></html>`;

  it("credits a definition written in Spanish", () => {
    // 6 points no Spanish page could earn: the pattern had no Spanish path at all.
    expect(check(SPANISH, "Definition patterns")?.passed).toBe(true);
  });

  it("credits a figure written in Spanish as a data point", () => {
    expect(check(SPANISH, "first 30%")?.passed).toBe(true);
  });

  it("reads a question heading through the tags wrapped around it", () => {
    // `[^<]*` could not match a heading containing any nested tag, and a Spanish
    // question opens with `¿`, which templates very often wrap.
    expect(check(SPANISH, "question-based")?.passed).toBe(true);
  });

  it("counts an accented proper noun as a named entity", () => {
    expect(entityDensity("Ángel dirige el equipo en México y en Öhlins.")).toBeGreaterThan(0);
  });

  it("does not score what it cannot read, instead of failing it", () => {
    // A German page has definitions. We cannot read them yet, and saying "no
    // definition patterns" about a page full of them is the lie this issue is about.
    const german = `<!DOCTYPE html><html lang="de"><body><main><p>Technisches SEO ist eine Disziplin.</p></main></body></html>`;
    const definitions = check(german, "Definition patterns");
    expect(definitions?.status).toBe("not-evaluated");
    expect(definitions?.detail).toMatch(/German/);
    expect(check(german, "first 30%")?.status).toBe("not-evaluated");
  });

  it("still reads an English page that declares nothing", () => {
    const bare = `<html><body><main><p>Technical SEO is a discipline concerned with crawling and indexing, and it matters a great deal to anyone running a website today.</p></main></body></html>`;
    expect(check(bare, "Definition patterns")?.passed).toBe(true);
    expect(check(bare, "Definition patterns")?.status).toBeUndefined();
  });
});
