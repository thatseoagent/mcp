/**
 * Every E-E-A-T content signal used to be matched against raw HTML, so markup
 * bought points that the copy had not earned:
 *
 * - "before" and "after" appear in class attributes on plenty of sites, so
 *   "Before/after evidence" passed without the copy saying anything.
 * - `/\d+%/` matches `width:100%`; `/\d{4}/` matches a build hash or an id.
 * - `"md"` was matched as a substring, so "markdown" counted as a medical degree.
 * - `/\b\w{12,}\b/` counted long class names as industry terminology.
 * - `/updated|modified|published/` matched `datePublished` inside JSON-LD, so
 *   "Update timestamp visible" was reported for pages showing no date at all.
 *
 * These pin both directions: markup alone earns nothing, and real copy still
 * earns what it should.
 */
import { describe, it, expect } from "vitest";

import { eeatOf } from "../../helpers/eeat";

// `fetchHtml` caches by URL for 60s, so every case serves from its own URL.
const url = (name: string) => `https://example.com/eeat-${name}`;

/** A page with almost no copy, dressed in the markup that used to score. */
const MARKUP_ONLY = `<!DOCTYPE html>
<html lang="en">
  <head>
    <title>A page with markup but no substance</title>
    <script type="application/ld+json">
      {"@type":"WebPage","datePublished":"2026-01-01","dateModified":"2026-02-01",
       "publisher":{"@type":"Organization","name":"Our Studio"},
       "description":"We build websites for us and for our clients"}
    </script>
  </head>
  <body class="antialiased">
    <div class="before:content-[''] after:block motion-safe:transition-transform">
      <div style="width:100%" id="section-1024" class="internationalization-wrapper">
        <main>
          <div class="implementation-container personalization-surface authentication-shell">
            <div class="instrumentation-layer categorization-grid normalization-stack">
              <div class="standardization-frame virtualization-panel orchestration-root">
                <div class="containerization-box infrastructure-column">
                  <p>Hola.</p>
                </div>
              </div>
            </div>
          </div>
        </main>
      </div>
    </div>
    <a href="https://example.com/markdown-cmd-reference">Docs</a>
    <script>window.__STATE__ = "${"payload ".repeat(200)}";</script>
  </body>
</html>`;

/** A page that genuinely carries the signals, in its visible copy. */
const REAL_CONTENT = `<!DOCTYPE html>
<html lang="en">
  <head><title>What I learned migrating 40 client sites</title></head>
  <body>
    <main>
      <p>I migrated 40 client sites last year, and my results surprised me.</p>
      <p>For instance, one case study stands out: a retailer whose traffic rose 38% after the change.</p>
      <p>Before the migration they ranked 14th; after it, 4th. The outcome held through 2025.</p>
      <p>I am a certified analytics consultant, and I hold an MBA.</p>
      <p>
        This required understanding internationalization, canonicalization,
        implementation, infrastructure, authentication, personalization,
        instrumentation, categorization, normalization, standardization,
        virtualization, containerization and orchestration.
      </p>
    </main>
    <footer><p>Last updated on 12 March 2026</p></footer>
  </body>
</html>`;


/**
 * No `serveHtml`. `scoreEeat` is pure now — the two fetches moved to
 * `eeat-tools`, where a **Tool Handler** does I/O and an **Analyzer** does not.
 */
function signalsOf(target: string, html: string) {
  return eeatOf(target, html);
}


/**
 * `points` is what an indicator is WORTH; `earned` is what the page got. These
 * used to assert `points === 0` for a failing indicator, which was true only
 * while the two meanings were swapped in this analyzer and nowhere else.
 */
describe("scoreEeat on markup with no substance", () => {
  it("does not read 'before' and 'after' in a class attribute as evidence", async () => {
    const { get } = signalsOf(url("before-after"), MARKUP_ONLY);

    // The indicator is retired to 0 points (#341), so what is asserted here is that
    // it still reads the copy and not the markup: a class attribute contributes no
    // words to the line the reader sees.
    const indicator = get("Before/after evidence (informational — not detectable from HTML)");
    expect(indicator.points).toBe(0);
    expect(indicator.details).toMatch(/not something HTML can be read for/);
  });

  it("does not read width:100% or an element id as statistics and dates", async () => {
    const { get } = signalsOf(url("statistics"), MARKUP_ONLY);

    const indicator = get("Specific details / statistics");
    expect(indicator.found).toBe(false);
    expect(indicator.earned).toBe(0);
  });

  it("does not read a URL slug as a professional certification", async () => {
    // "markdown-cmd-reference" contains both "md" and "cmd".
    const { get } = signalsOf(url("certifications"), MARKUP_ONLY);

    const indicator = get("Professional certifications");
    expect(indicator.found).toBe(false);
    expect(indicator.earned).toBe(0);
  });

  it("does not read long class names as industry terminology", async () => {
    const { get } = signalsOf(url("terminology"), MARKUP_ONLY);

    // Retired to 0 points (#342), so what is pinned here is that it still counts the
    // copy and not the markup: thirteen long class names contribute nothing.
    const indicator = get("Industry terminology (informational — word length is not expertise)");
    expect(indicator.points).toBe(0);
    expect(indicator.details).toMatch(/^0 words of 12\+ letters/);
  });

  it("does not report a visible update date for a JSON-LD datePublished", async () => {
    const { get } = signalsOf(url("date"), MARKUP_ONLY);

    const indicator = get("Last updated date");
    expect(indicator.found).toBe(false);
    expect(indicator.earned).toBe(0);
  });

  it("does not read a first-person CSS class or attribute as narrative", async () => {
    const { get } = signalsOf(url("first-person"), MARKUP_ONLY);

    const indicator = get("First-person narrative");
    expect(indicator.found).toBe(false);
    expect(indicator.earned).toBe(0);
  });

  it("does not read example.com as a worked example", async () => {
    const { get } = signalsOf(url("case-studies"), MARKUP_ONLY);

    const indicator = get("Case studies / examples");
    expect(indicator.found).toBe(false);
    expect(indicator.earned).toBe(0);
  });
});

describe("scoreEeat ignores the page chrome", () => {
  /** Boilerplate every site has, around a page that says almost nothing. */
  const CHROME_ONLY = `<!DOCTYPE html>
<html lang="en"><head><title>A page that is mostly navigation</title></head>
<body>
  <nav><a href="/about">About us</a> <a href="/contact">Contact us</a></nav>
  <main><p>Hola.</p></main>
  <footer>© 2026 Example Ltd. All rights reserved.</footer>
</body></html>`;

  it("does not read a nav's 'Contact us' as first-person narrative", async () => {
    const { get } = signalsOf(url("chrome-first-person"), CHROME_ONLY);
    expect(get("First-person narrative").found).toBe(false);
  });

  it("does not read a copyright year as the page's own statistics", async () => {
    const { get } = signalsOf(url("chrome-stats"), CHROME_ONLY);

    const indicator = get("Specific details / statistics");
    expect(indicator.found).toBe(false);
    expect(indicator.earned).toBe(0);
  });

  it("still finds an update date in the footer, where it belongs", async () => {
    const dated = CHROME_ONLY.replace(
      "© 2026 Example Ltd. All rights reserved.",
      "Last updated 12 March 2026"
    );
    const { get } = signalsOf(url("chrome-date"), dated);

    expect(get("Last updated date").found).toBe(true);
  });
});

describe("scoreEeat number patterns", () => {
  /** Visible copy with digits that are not claims: a step count and an id. */
  const WEAK_NUMBERS = `<!DOCTYPE html>
<html lang="en"><head><title>A page with digits but no figures</title></head>
<body><main>
  <p>Pick 1 plan. Reference 8391 applies. Coverage is 5 of them.</p>
</main></body></html>`;

  it("does not read a lone digit as a specific figure", async () => {
    const { get } = signalsOf(url("weak-numbers"), WEAK_NUMBERS);

    const indicator = get("Specific details / statistics");
    // "8391" is four digits but not a plausible year, and no percentage appears.
    // Prose now, not a dump of three raw booleans.
    expect(indicator.details).toContain("no statistics or dates");
  });
});

describe("scoreEeat keyword matching", () => {
  /** Visible copy whose words *contain* the keywords without mentioning them. */
  const SUBSTRINGS = `<!DOCTYPE html>
<html lang="en"><head><title>A reference page about formats and palettes</title></head>
<body><main>
  <p>The cmd reference explains every colour palette in the theme.</p>
</main></body></html>`;

  it("does not read a roman numeral as the English pronoun 'I'", async () => {
    // "Capítulo I" and "Fase i" are list markers, not a first-person narrator.
    const numerals = `<!DOCTYPE html>
<html lang="es"><head><title>Un documento numerado por capítulos</title></head>
<body><main>
  <p>Capítulo I. La migración se hizo en tres fases.</p>
  <p>Fase i: preparar el inventario de páginas.</p>
</main></body></html>`;

    const { get } = signalsOf(url("roman-numeral"), numerals);
    expect(get("First-person narrative").found).toBe(false);
  });

  it("does not read a certification named only in an attribute", async () => {
    const attrOnly = `<!DOCTYPE html>
<html lang="en"><head><title>A page whose markup mentions a degree</title></head>
<body><main>
  <img src="/badge.png" alt="certified partner badge" data-degree="mba" />
  <p>Hola.</p>
</main></body></html>`;

    const { get } = signalsOf(url("attr-certification"), attrOnly);
    expect(get("Professional certifications").found).toBe(false);
  });

  it("does not read 'cmd' as the degree 'md'", async () => {
    const { get } = signalsOf(url("substring-md"), SUBSTRINGS);
    expect(get("Professional certifications").found).toBe(false);
  });

  it("does not read 'colour' as the first-person 'our'", async () => {
    const { get } = signalsOf(url("substring-our"), SUBSTRINGS);
    expect(get("First-person narrative").found).toBe(false);
  });
});

describe("scoreEeat on Spanish copy", () => {
  /** The same signals as REAL_CONTENT, written in Spanish. */
  const SPANISH = `<!DOCTYPE html>
<html lang="es"><head><title>Lo que aprendí migrando 40 sitios de clientes</title></head>
<body>
  <main>
    <p>Migré 40 sitios de clientes el año pasado, y nuestros resultados fueron una sorpresa.</p>
    <p>Por ejemplo, un caso de estudio destaca: una tienda cuyo tráfico subió 38% tras el cambio.</p>
    <p>Antes de la migración estaban en la posición 14; después, en la 4. El resultado se mantuvo en 2025.</p>
    <p>Soy consultor certificado en analítica, y tengo un máster.</p>
  </main>
  <footer><p>Actualizado el 12 de marzo de 2026</p></footer>
</body></html>`;

  // The repo already treats English-only matching as a defect that unfairly
  // lowers scores for Spanish sites — see lib/utils/localized-page-detection.ts.
  it("credits first-person narrative written in Spanish", async () => {
    const { get } = signalsOf(url("es-first-person"), SPANISH);
    expect(get("First-person narrative").found).toBe(true);
  });

  it("credits a worked example described in Spanish", async () => {
    const { get } = signalsOf(url("es-case-study"), SPANISH);
    expect(get("Case studies / examples").found).toBe(true);
  });

  it("still notices before/after words written in Spanish, without scoring them", async () => {
    const { get } = signalsOf(url("es-before-after"), SPANISH);
    const indicator = get("Before/after evidence (informational — not detectable from HTML)");
    expect(indicator.details).toMatch(/before\/after words in the copy/);
    expect(indicator.earned).toBe(0);
  });

  it("credits a certification stated in Spanish", async () => {
    const { get } = signalsOf(url("es-certs"), SPANISH);
    expect(get("Professional certifications").found).toBe(true);
  });

  it("credits an update date written in Spanish", async () => {
    const { get } = signalsOf(url("es-date"), SPANISH);
    expect(get("Last updated date").found).toBe(true);
  });
});

describe("scoreEeat on copy that carries the signals", () => {
  it("credits first-person narrative written in the copy", async () => {
    const { get } = signalsOf(url("real-first-person"), REAL_CONTENT);
    expect(get("First-person narrative").earned).toBe(5);
  });

  it("credits a worked example described in the copy", async () => {
    const { get } = signalsOf(url("real-case-study"), REAL_CONTENT);
    expect(get("Case studies / examples").found).toBe(true);
  });

  it("scores nothing for before/after evidence, in either direction", async () => {
    // 5 points for two words out of nine appearing in the copy. No better word list
    // fixes that: a page can document a transformation without any of them, and use
    // all nine without documenting one. Retired on the llms.txt precedent — named for
    // the reader, worth nothing to the score (#341).
    const { get } = signalsOf(url("real-before-after"), REAL_CONTENT);
    const indicator = get("Before/after evidence (informational — not detectable from HTML)");
    expect(indicator.points).toBe(0);
    expect(indicator.earned).toBe(0);
  });

  it("credits a real percentage and a real year", async () => {
    const { get } = signalsOf(url("real-stats"), REAL_CONTENT);

    const indicator = get("Specific details / statistics");
    expect(indicator.found).toBe(true);
    expect(indicator.details).toContain("Has statistics, numbers and dates");
  });

  it("credits a certification stated in the copy", async () => {
    const { get } = signalsOf(url("real-certs"), REAL_CONTENT);
    expect(get("Professional certifications").earned).toBe(5);
  });

  it("no longer scores long words as expertise, in either language", async () => {
    // Spanish morphology produces 12-letter words far more often than English, so
    // this measured the language and not the vocabulary (#342). A per-language
    // threshold would only make the nonsense equitable.
    const { get } = signalsOf(url("real-terminology"), REAL_CONTENT);
    const indicator = get("Industry terminology (informational — word length is not expertise)");
    expect(indicator.points).toBe(0);
    expect(indicator.earned).toBe(0);
    expect(indicator.details).toMatch(/measured the language and not the vocabulary/);
  });

  it("credits an update date the reader can actually see", async () => {
    const { get } = signalsOf(url("real-date"), REAL_CONTENT);
    expect(get("Last updated date").found).toBe(true);
  });

  it("scores the real page above the markup-only one", async () => {
    const real = signalsOf(url("compare-real"), REAL_CONTENT);
    const markup = signalsOf(url("compare-markup"), MARKUP_ONLY);

    expect(real.data.score).toBeGreaterThan(markup.data.score);
  });
});

/**
 * A detail line has to say something its own label does not.
 *
 * These four read "Site uses HTTPS", "Privacy policy link found", "About page link
 * found" and "Contact info found" under labels reading "HTTPS encryption",
 * "Privacy policy", "About page" and "Contact information" — each next to a green
 * tick and a `+5`, so the same word three times on one row.
 *
 * It cost nothing while the shared report discarded details on scored rows. Once
 * `CheckRow` started printing them, the Trustworthiness card was four rows of
 * restatement, which is what the details were restored to avoid.
 *
 * The failing and partial states keep their line, and that is the distinction:
 * "linked from the site home, but not from this page" is a template problem,
 * "nowhere on the site" is a missing page, and "HTTP (insecure)" names a
 * consequence the label does not carry.
 */
describe("E-E-A-T details earn their line", () => {
  const onPage = { answer: "present", where: "page" } as const;
  const onHome = { answer: "present", where: "home" } as const;

  it("says nothing extra when the page itself carries the trust page", () => {
    const { get } = eeatOf(url("trust-on-page"), REAL_CONTENT, {
      privacy: onPage,
      about: onPage,
      contact: onPage,
    });

    for (const signal of ["Privacy policy", "About page", "Contact information"]) {
      const indicator = get(signal);
      // Still the full award: what changed is only what is said about it.
      expect(indicator.earned, signal).toBe(5);
      expect(indicator.details, signal).toBeUndefined();
    }
  });

  it("keeps the line that tells a template problem from a missing page", () => {
    const home = eeatOf(url("trust-on-home"), REAL_CONTENT, { privacy: onHome });
    const gone = eeatOf(url("trust-absent"), REAL_CONTENT);

    expect(home.get("Privacy policy").details).toMatch(/site home, but not from this page/);
    expect(gone.get("Privacy policy").details).toMatch(/on this page or the site home/);
  });

  it("says nothing extra for HTTPS, and names the consequence for HTTP", () => {
    expect(eeatOf("https://example.com/x", REAL_CONTENT).get("HTTPS encryption").details)
      .toBeUndefined();
    expect(eeatOf("http://example.com/x", REAL_CONTENT).get("HTTPS encryption").details)
      .toMatch(/insecure/);
  });

  it("keeps the case-study line, which names the method rather than the verdict", () => {
    // "Case study keywords found" is not a restatement: it tells the reader the
    // check is keyword matching and not comprehension, which changes how much the
    // tick is worth to them.
    expect(eeatOf(url("case-study"), REAL_CONTENT).get("Case studies / examples").details)
      .toBeDefined();
  });
});

/**
 * Partial-credit details are sentences, not a dump of raw booleans.
 *
 * Four indicators award points per sub-signal, and they reported which sub-signal
 * was missing as `Statistics: false, Numbers: true, Dates: true` — the shape of a
 * console.log. A client reading their own audit met three raw JavaScript booleans
 * and had to work out that `false` was the bad one. The other three read
 * `Word count: 899, Code: false, Diagrams: false`, `Footnotes: false,
 * Bibliography: false, External links: 23` and `Testimonials: true, Ratings:
 * false`.
 */
describe("E-E-A-T details read as prose", () => {
  const RICH = `<html><body><h1>H</h1><p>We built this. In 2026 we served 1,200 people, a 45% rise.</p></body></html>`;
  const BARE = `<html><body><h1>H</h1><p>Nothing here at all.</p></body></html>`;

  it("never shows a raw boolean", () => {
    for (const html of [RICH, BARE]) {
      const { data } = eeatOf(url("prose"), html);
      const all = [
        ...data.signals.experience.indicators,
        ...data.signals.expertise.indicators,
        ...data.signals.authoritativeness.indicators,
        ...data.signals.trustworthiness.indicators,
      ];
      for (const i of all) {
        expect(i.details ?? "", i.signal).not.toMatch(/\b(true|false)\b/);
      }
    }
  });

  it("negates a list with 'or', not 'and'", () => {
    // "No code samples and captioned figures" reads as though only the pair
    // together were missing. Both are, and each separately is.
    const { get } = eeatOf(url("negation"), BARE);
    expect(get("Detailed technical content").details).toContain("No code samples or captioned figures");
    expect(get("Social proof / testimonials").details).toBe("No testimonials or ratings");
    expect(get("Specific details / statistics").details).toBe("No statistics, numbers or dates");
  });

  it("names what is present before what is missing", () => {
    // The reader is looking at a score and wants to know what earned it; the
    // missing part is what they can act on, so it comes second.
    const { get } = eeatOf(url("mixed"), `<html><body><h1>H</h1><p>Served 1,200 people.</p></body></html>`);
    const details = get("Specific details / statistics").details ?? "";
    if (details.includes(";")) {
      expect(details.indexOf("Has")).toBeLessThan(details.indexOf("no "));
    }
  });

  it("leads the technical-content line with the measurement", () => {
    // Word count carries 3 of the 6 points and is the only part of that
    // indicator that is a number rather than a yes/no.
    expect(eeatOf(url("count"), BARE).get("Detailed technical content").details)
      .toMatch(/^\d+ words\. /);
  });
});
