import { describe, expect, it } from "vitest";
import {
  countQuestionHeadings,
  countStatistics,
  definesSomething,
  hasSummarySection,
  isListicle,
  listicleShape,
  statesAStatistic,
} from "@/lib/analyzers/content-signals";
import { page } from "../../helpers/parsed-page";

/**
 * The invariant this file exists to keep: **a Content Signal is detected the same
 * way wherever it is scored, and a language we cannot read is said out loud.**
 *
 * Four detectors existed in three implementations. `geo-analyzer` had the
 * bilingual originals, `seo-content-analysis` had a line-for-line fork with the
 * Spanish alternatives dropped from all four, and `answer-patterns` — the module
 * built for exactly this problem, with an honest `unsupported` state — had one
 * caller while `geo-analyzer` carried a hardcoded EN+ES regex for the same two
 * concepts.
 *
 * The Spanish assertions used to live only in `geo-analyzer.test.ts`, which is
 * why the fork's regression went unnoticed: nothing tested Spanish on the surface
 * that had lost it. They are here now, against the detector, so every caller
 * inherits them.
 */

describe("a stated figure", () => {
  it("counts the shapes that cross the language line", () => {
    expect(countStatistics("Conversion rose 42% after the change")).toBe(1);
    expect(countStatistics("It costs $1,200 and saves 3 out of 4 teams time")).toBe(2);
    expect(countStatistics("A 5x improvement in throughput")).toBe(1);
  });

  it("counts written magnitudes in English", () => {
    expect(statesAStatistic("serving 80 million requests")).toBe(true);
    expect(statesAStatistic("2.5 billion rows")).toBe(true);
  });

  it("counts written magnitudes in Spanish, which a fork had dropped", () => {
    // The regression `geo-analyzer` documents as already fixed: "dropping it
    // would have quietly stopped counting 'más de 80 millones' as a statistic on
    // every Spanish page."
    expect(statesAStatistic("más de 80 millones de peticiones")).toBe(true);
    expect(statesAStatistic("1 millón de usuarios")).toBe(true);
    expect(statesAStatistic("ahorra 3 de cada 4 equipos")).toBe(true);
    expect(statesAStatistic("2 mil clientes")).toBe(true);
  });

  it("finds nothing in prose that states nothing", () => {
    expect(statesAStatistic("We help teams move faster and work better")).toBe(false);
    expect(countStatistics("")).toBe(0);
  });

  it("does not carry a matcher's position between calls", () => {
    // `STATISTIC` is a `g` regex. A shared instance keeps `lastIndex`, so the
    // second caller would start mid-string and undercount.
    const text = "42% and 80 million and $12";
    expect(countStatistics(text)).toBe(countStatistics(text));
    expect(countStatistics(text)).toBe(3);
  });
});

describe("a question-phrased heading", () => {
  const withHeadings = (...headings: string[]) =>
    page(
      `<!DOCTYPE html><html lang="en"><body><main>${headings
        .map((h) => `<h2>${h}</h2><p>Copy.</p>`)
        .join("")}</main></body></html>`,
    ).readable;

  it("recognises an English question word, and a trailing question mark", () => {
    expect(countQuestionHeadings(withHeadings("How does pricing work"))).toBe(1);
    expect(countQuestionHeadings(withHeadings("Pricing, explained?"))).toBe(1);
  });

  it("recognises a Spanish question word, opening ¿ included", () => {
    // The fork was English-only, so a Spanish page asking four questions scored
    // as though it asked none. And the original it forked from was broken too:
    // its `\b` terminator is ASCII, so every accented alternative was dead.
    expect(countQuestionHeadings(withHeadings("¿Cómo funciona el precio?"))).toBe(1);
    expect(countQuestionHeadings(withHeadings("Qué incluye el plan"))).toBe(1);
    expect(countQuestionHeadings(withHeadings("Por qué elegirnos"))).toBe(1);
    expect(countQuestionHeadings(withHeadings("Cuándo se factura"))).toBe(1);
  });

  it("does not need a question mark to see an accented question word", () => {
    // `\b` after `qué` never matched, because `é` is not a `\w`. These four
    // headings all scored as statements.
    expect(countQuestionHeadings(withHeadings("Qué incluye el plan"))).toBe(1);
    expect(countQuestionHeadings(withHeadings("Cómo empezar"))).toBe(1);
    expect(countQuestionHeadings(withHeadings("Dónde se aloja"))).toBe(1);
    expect(countQuestionHeadings(withHeadings("Cuál elegir"))).toBe(1);
  });

  it("still needs the word to end where the heading says it does", () => {
    // The lookahead is a boundary, not a prefix match: `Esfuerzo` starts with
    // `es` and is not a question.
    expect(countQuestionHeadings(withHeadings("Esfuerzo y resultados"))).toBe(0);
    expect(countQuestionHeadings(withHeadings("Cuántos" + "abcd"))).toBe(0);
  });

  it("counts every question, because one caller reports the figure", () => {
    expect(
      countQuestionHeadings(withHeadings("How it works", "Why us", "Our team")),
    ).toBe(2);
  });

  it("ignores a heading in the site's chrome, which is not this page asking", () => {
    const doc = page(
      `<!DOCTYPE html><html lang="en"><body>
        <nav><h2>What is this?</h2></nav>
        <main><h2>Our approach</h2><p>Copy.</p></main>
      </body></html>`,
    ).readable;

    // `textsInContent` draws the distinction the old markup scan could not: a
    // site-wide nav heading counted as this page asking a question.
    expect(countQuestionHeadings(doc)).toBe(0);
  });
});

describe("a summary block", () => {
  it("recognises the English markings", () => {
    for (const marking of ["tldr", "summary", "takeaway", "overview"]) {
      expect(hasSummarySection(`<div class="${marking}">…</div>`)).toBe(true);
    }
  });

  it("recognises the Spanish markings, which a fork had dropped", () => {
    for (const marking of ["resumen", "claves", "puntos-clave"]) {
      expect(hasSummarySection(`<section id="${marking}">…</section>`)).toBe(true);
    }
  });

  it("finds nothing where nothing is marked", () => {
    expect(hasSummarySection("<div class=\"hero\">…</div>")).toBe(false);
  });
});

describe("listicle formatting", () => {
  const shapes = (html: string) => listicleShape(html);

  it("recognises an English numbered heading", () => {
    expect(shapes("<h2>10 best SEO tools</h2>").numberedHeading).toBe(true);
    expect(shapes("<h1>Top 5 mistakes</h1>").numberedHeading).toBe(true);
  });

  it("recognises a Spanish numbered heading, which a fork had dropped", () => {
    expect(shapes("<h2>10 mejores herramientas de SEO</h2>").numberedHeading).toBe(true);
    expect(shapes("<h2>7 formas de mejorar el CTR</h2>").numberedHeading).toBe(true);
    expect(shapes("<h2>5 pasos para empezar</h2>").numberedHeading).toBe(true);
    expect(shapes("<h1>Los 3 mejores planes</h1>").numberedHeading).toBe(true);
  });

  it("needs three items before an ordered list is a sequence", () => {
    expect(shapes("<ol><li>a</li><li>b</li></ol>").orderedList).toBe(false);
    expect(shapes("<ol><li>a</li><li>b</li><li>c</li></ol>").orderedList).toBe(true);
  });

  it("needs three rows before a table is a comparison", () => {
    expect(shapes("<table><tr><td>a</td></tr><tr><td>b</td></tr></table>").comparisonTable)
      .toBe(false);
    expect(
      shapes("<table><tr><td>a</td></tr><tr><td>b</td></tr><tr><td>c</td></tr></table>")
        .comparisonTable,
    ).toBe(true);
  });

  it("is a listicle when any one shape is present, and not otherwise", () => {
    expect(isListicle(shapes("<h2>10 best tools</h2>"))).toBe(true);
    expect(isListicle(shapes("<p>Prose, and nothing else.</p>"))).toBe(false);
  });

  it("scans every container, not just the first", () => {
    // A shared `g` regex would stop after the first `<ol>`.
    const html = "<ol><li>a</li></ol><ol><li>a</li><li>b</li><li>c</li></ol>";
    expect(shapes(html).orderedList).toBe(true);
  });
});

describe("definitional phrasing", () => {
  it("reads English", () => {
    expect(definesSomething("An audit is a review of a site", "en"))
      .toEqual({ outcome: "answered", defines: true });
    expect(definesSomething("We move fast", "en"))
      .toEqual({ outcome: "answered", defines: false });
  });

  it("reads Spanish", () => {
    expect(definesSomething("Una auditoría es una revisión del sitio", "es"))
      .toEqual({ outcome: "answered", defines: true });
    expect(definesSomething("El GEO se refiere a la optimización para motores", "es"))
      .toEqual({ outcome: "answered", defines: true });
  });

  it("says which language it cannot read, rather than failing a correct page", () => {
    // The whole reason `answer-patterns` is a module and not a longer regex:
    // "adding Spanish alternatives beside the English ones fixes Spanish and
    // leaves German exactly as broken, silently". `geo-analyzer` carried that
    // longer regex.
    const german = definesSomething("Ein Audit ist eine Prüfung der Seite", "de");

    expect(german.outcome).toBe("unsupported");
    if (german.outcome !== "unsupported") return;
    expect(german.languageName).toMatch(/german/i);
  });

  it("tries every set it has when the page declares no language", () => {
    // Deliberately generous: `html[lang]` is missing on a great many real pages
    // and is reported separately, so treating its absence as unscorable would
    // empty the score of half the web over an attribute already flagged.
    expect(definesSomething("Una auditoría es una revisión", null))
      .toEqual({ outcome: "answered", defines: true });
    expect(definesSomething("An audit is a review", null))
      .toEqual({ outcome: "answered", defines: true });
  });

  it("reduces a regional tag to the language it is", () => {
    expect(definesSomething("Una auditoría es una revisión", "es-419"))
      .toEqual({ outcome: "answered", defines: true });
    expect(definesSomething("An audit is a review", "en-GB"))
      .toEqual({ outcome: "answered", defines: true });
  });
});
