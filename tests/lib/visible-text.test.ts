import { describe, it, expect } from "vitest";
import { load } from "cheerio";

import { mainContentText, readableDocument, visibleTexts } from "@/lib/visible-text";

describe("visibleTexts", () => {
  it("turns a <br> into a space instead of fusing the words around it", () => {
    const $ = load("<h1>Análisis SEO, directo<br><span>en tu agente de IA.</span></h1>");
    expect(visibleTexts($, "h1")).toEqual(["Análisis SEO, directo en tu agente de IA."]);
  });

  it("handles the self-closing form React renders", () => {
    const $ = load("<h2>foo<br/>bar</h2>");
    expect(visibleTexts($, "h2")).toEqual(["foo bar"]);
  });

  it("separates block children, which also render on their own lines", () => {
    const $ = load("<h1><div>foo</div><div>bar</div></h1>");
    expect(visibleTexts($, "h1")).toEqual(["foo bar"]);
  });

  it("collapses the runs of whitespace that formatted markup leaves behind", () => {
    const $ = load(`<h1>
        First line
        <br />
        <span>  second   line  </span>
      </h1>`);
    expect(visibleTexts($, "h1")).toEqual(["First line second line"]);
  });

  it("does not insert a space where an inline element joined two words", () => {
    const $ = load("<h1>Cost<em>ly</em></h1>");
    expect(visibleTexts($, "h1")).toEqual(["Costly"]);
  });

  it("returns one entry per match, in document order", () => {
    const $ = load("<h2>first<br>one</h2><p>skip</p><h2>second</h2>");
    expect(visibleTexts($, "h2")).toEqual(["first one", "second"]);
  });

  it("drops elements that render no text", () => {
    const $ = load("<h1><br></h1><h1>real</h1><h1>   </h1>");
    expect(visibleTexts($, "h1")).toEqual(["real"]);
  });

  it("returns an empty list when nothing matches", () => {
    const $ = load("<p>no headings here</p>");
    expect(visibleTexts($, "h1")).toEqual([]);
  });

  it("leaves the document intact so later extractions see the same tree", () => {
    const $ = load("<h1>foo<br>bar</h1>");

    expect(visibleTexts($, "h1")).toEqual(["foo bar"]);
    // Same result the second time round: the first call must not have mutated
    // the tree it read from.
    expect(visibleTexts($, "h1")).toEqual(["foo bar"]);
    expect($("h1 br").length).toBe(1);
  });
});

describe("visibleTexts non-content elements", () => {
  it("ignores a script that happens to sit inside the element", () => {
    const $ = load(`<h1>Real<script>var x = "fake heading text";</script></h1>`);
    expect(visibleTexts($, "h1")).toEqual(["Real"]);
  });
});

describe("mainContentText", () => {
  it("leaves out <script> contents, which are not words on the page", () => {
    // The shape that inflated seo_analyze_page 24x: serialized state in a
    // sibling script at the end of <body> (issue #291).
    const $ = load(`<html><body>
      <main><p>One two three.</p></main>
      <script>window.__STATE__ = "${"payload ".repeat(500)}";</script>
    </body></html>`);

    expect(mainContentText($)).toBe("One two three.");
  });

  it("leaves out style, noscript, template and svg contents too", () => {
    const $ = load(`<html><body><main>
      <p>Visible.</p>
      <style>.a { color: red }</style>
      <noscript>Enable JavaScript</noscript>
      <template><p>Not rendered</p></template>
      <svg><title>Icon label</title></svg>
    </main></body></html>`);

    expect(mainContentText($)).toBe("Visible.");
  });

  it("strips a script nested inside the content container", () => {
    // The latent half of the bug: semantic scoping only dodged the payload by
    // accident, and an inline analytics or JSON-LD block inside <main> put it
    // straight back.
    const $ = load(`<html><body><main>
      <p>One two.</p>
      <script type="application/ld+json">{"@type":"Article","headline":"noise noise noise"}</script>
    </main></body></html>`);

    expect(mainContentText($)).toBe("One two.");
  });

  it("prefers the semantic container over the whole body", () => {
    const $ = load(`<html><body>
      <nav>Navigation link</nav>
      <main><p>Body copy.</p></main>
      <footer>Footer boilerplate</footer>
    </body></html>`);

    expect(mainContentText($)).toBe("Body copy.");
  });

  it("falls back to the body when no semantic container exists", () => {
    // The fallback path had the script bug outright, so it needs its own pin.
    const $ = load(`<html><body>
      <div class="wrapper"><p>Only copy.</p></div>
      <script>var noise = "${"junk ".repeat(200)}";</script>
    </body></html>`);

    expect(mainContentText($)).toBe("Only copy.");
  });

  it("separates text across block boundaries, so words do not fuse", () => {
    const $ = load(`<html><body><main>
      <h1>Servidor MCP</h1><p>Análisis SEO</p>
    </main></body></html>`);

    expect(mainContentText($)).toBe("Servidor MCP Análisis SEO");
  });

  it("leaves the document intact for later extractions", () => {
    const $ = load(`<html><body><main><p>Copy.</p><script>x</script></main></body></html>`);

    expect(mainContentText($)).toBe("Copy.");
    expect(mainContentText($)).toBe("Copy.");
    expect($("main script").length).toBe(1);
  });

  it("returns an empty string for a document with no text", () => {
    const $ = load("<html><body><script>var a = 1;</script></body></html>");
    expect(mainContentText($)).toBe("");
  });
});

describe("readableDocument paragraphs", () => {
  it("counts the prose blocks a reader sees as separate paragraphs", () => {
    const $ = load(`<html><body><main>
      <h1>Title</h1>
      <p>First paragraph.</p>
      <p>Second paragraph.</p>
      <blockquote>A quote.</blockquote>
      <ul><li>Item one</li><li>Item two</li></ul>
    </main></body></html>`);

    expect(readableDocument($).paragraphs()).toEqual([
      "First paragraph.",
      "Second paragraph.",
      "A quote.",
      "Item one",
      "Item two",
    ]);
  });

  it("ignores layout wrappers, which are not paragraphs", () => {
    const $ = load(`<html><body><main>
      <div><div><section><p>The only paragraph.</p></section></div></div>
    </main></body></html>`);

    expect(readableDocument($).paragraphs()).toEqual(["The only paragraph."]);
  });

  it("keeps a wrapper block's own text as well as its nested blocks", () => {
    // Innermost-only selection dropped "outer" entirely: the text of a list item
    // that also contains a sub-list is copy the reader sees.
    const $ = load(`<html><body><main><ul>
      <li>outer<ul><li>a</li><li>b</li></ul></li>
      <li>plain</li>
    </ul></main></body></html>`);

    expect(readableDocument($).paragraphs()).toEqual(["outer", "a", "b", "plain"]);
  });

  it("splits a quote that wraps its own paragraph", () => {
    const $ = load(
      `<html><body><main><blockquote>Intro<p>Quoted.</p></blockquote></main></body></html>`
    );

    expect(readableDocument($).paragraphs()).toEqual(["Intro", "Quoted."]);
  });

  it("counts definition terms as well as their definitions", () => {
    const $ = load(
      `<html><body><main><dl><dt>Term</dt><dd>Definition.</dd></dl></main></body></html>`
    );

    expect(readableDocument($).paragraphs()).toEqual(["Term", "Definition."]);
  });

  it("counts a <summary>, which this repo's FAQ pattern uses for the question", () => {
    const $ = load(`<html><body><main><details>
      <summary>How does it work?</summary>
      <p>Like this.</p>
    </details></main></body></html>`);

    expect(readableDocument($).paragraphs()).toEqual(["How does it work?", "Like this."]);
  });

  it("ignores prose blocks that render no text", () => {
    const $ = load(`<html><body><main><p>Real.</p><p></p><p>   </p></main></body></html>`);
    expect(readableDocument($).paragraphs()).toEqual(["Real."]);
  });

  it("falls back to the wrappers that hold copy when a page has no <p> at all", () => {
    const $ = load(`<html><body><main>
      <h1>Not a paragraph</h1>
      <div>First block.</div>
      <div>Second block.</div>
    </main></body></html>`);

    // Headings are not paragraphs, so they stay out of the count.
    expect(readableDocument($).paragraphs()).toEqual(["First block.", "Second block."]);
  });

  it("counts no paragraphs on a page with no copy at all", () => {
    const $ = load(`<html><body><main><script>var a = 1;</script></main></body></html>`);
    expect(readableDocument($).paragraphs()).toEqual([]);
  });

  it("looks only inside the content container, not the whole page", () => {
    const $ = load(`<html><body>
      <nav><p>Nav blurb</p></nav>
      <main><p>Real paragraph.</p></main>
      <footer><p>Footer blurb</p></footer>
    </body></html>`);

    expect(readableDocument($).paragraphs()).toEqual(["Real paragraph."]);
  });
});

describe("readableDocument and hidden content", () => {
  // These two pin a deliberate limit, documented on NON_CONTENT: we parse HTML,
  // we do not compute layout, so "visible" means what the markup declares.
  it("drops the text of an element the markup declares hidden", () => {
    const $ = load(
      `<html><body><main><p>Shown.</p><p hidden>Declared hidden.</p></main></body></html>`
    );

    expect(readableDocument($).mainContent()).toBe("Shown.");
  });

  it("keeps text hidden only by CSS, which we cannot see from the markup", () => {
    const $ = load(`<html><body><main>
      <p>Shown.</p>
      <p class="hidden">Hidden by a class.</p>
      <p style="display:none">Hidden by a style.</p>
    </main></body></html>`);

    // Not what a browser paints, but the honest answer from HTML alone: a class
    // named "hidden" is a class name, and we do not apply stylesheets. Widening
    // this to chase CSS would cover one mechanism and miss the rest.
    expect(readableDocument($).mainContent()).toBe(
      "Shown. Hidden by a class. Hidden by a style."
    );
  });
});

describe("readableDocument and React streaming containers (#397)", () => {
  /**
   * Why this exception exists is written once, on `REACT_STREAM_CONTAINER` in
   * `lib/utils/visible-text.ts`. What is local to these tests is the shape below
   * and where it came from: it mirrors the real commet.co response (#397), down
   * to the empty marker div React emits beside the container that holds the page.
   */
  const streamed = (inner: string) =>
    load(
      `<html><body>` +
        `<div hidden><!--$--><!--/$--></div>` +
        `<template id="B:2"></template>` +
        `<div hidden id="S:2">${inner}</div>` +
        `<script>$RC("B:2","S:2")</script>` +
        `</body></html>`
    );

  it("reads the headings React parked in a streaming container", () => {
    const $ = streamed("<main><h1>The billing infrastructure</h1></main>");

    expect(readableDocument($).texts("h1")).toEqual(["The billing infrastructure"]);
  });

  it("finds the <main> that was trapped inside it", () => {
    // Without the unwrap this is the second failure and the quieter one:
    // CONTENT_CONTAINERS never matches, contentRoot() falls back to an empty
    // body, and every content metric reads zero rather than erroring.
    const $ = streamed("<main><p>Real copy.</p></main><footer>Chrome.</footer>");

    expect(readableDocument($).mainContent()).toBe("Real copy.");
  });

  it("leaves the wrapper's own children in document order", () => {
    const $ = streamed("<main><h2>First</h2><h2>Second</h2></main>");

    expect(readableDocument($).texts("h2")).toEqual(["First", "Second"]);
  });

  it("unwraps a container carrying React's identifierPrefix", () => {
    // `identifierPrefix` prepends to both the boundary and segment ids, so the
    // scheme is "<prefix>S:<n>" rather than a bare "S:<n>".
    const $ = load(
      `<html><body><div hidden id="app-S:7"><main><h1>Prefixed</h1></main></div></body></html>`
    );

    expect(readableDocument($).texts("h1")).toEqual(["Prefixed"]);
  });

  it("still drops an element the markup declares hidden", () => {
    // The exception must not widen into "count hidden text". A closed drawer is
    // still not on the page.
    const $ = load(
      `<html><body><main><p>Shown.</p></main>` +
        `<nav hidden><a href="/x">Closed drawer</a></nav></body></html>`
    );

    expect(readableDocument($).allText()).toBe("Shown.");
  });

  it("still drops a hidden div that is not a React container", () => {
    const $ = load(
      `<html><body><main><p>Shown.</p></main>` +
        `<div hidden id="cookie-banner"><p>Not a boundary.</p></div></body></html>`
    );

    expect(readableDocument($).allText()).toBe("Shown.");
  });

  it("does not mistake an id that merely ends in a capital S", () => {
    // `\\S*S:\\d+` accepted this. The prefix has to end in a non-letter, because
    // React builds the id as `${identifierPrefix}S:${n}` and a prefix that runs
    // straight into the S is not a prefix, it is a different word.
    const $ = load(
      `<html><body><main><p>Shown.</p></main>` +
        `<div hidden id="TABS:2"><p>Not a boundary.</p></div></body></html>`
    );

    expect(readableDocument($).allText()).toBe("Shown.");
  });

  it("does not unwrap a container that is not a child of the body", () => {
    // React streams these into the body. An app's own hidden markup lives
    // wherever its component does, so depth is the cheapest thing separating
    // the two.
    const $ = load(
      `<html><body><main><p>Shown.</p>` +
        `<div hidden id="S:2"><p>Not a boundary.</p></div></main></body></html>`
    );

    expect(readableDocument($).allText()).toBe("Shown.");
  });

  it("does not mistake an id that merely ends in a digit", () => {
    const $ = load(
      `<html><body><main><p>Shown.</p></main>` +
        `<div hidden id="section-2"><p>Not a boundary.</p></div></body></html>`
    );

    expect(readableDocument($).allText()).toBe("Shown.");
  });

  it("does not fuse the container's text with the text around it", () => {
    const $ = load(
      `<html><body><p>Before</p>` +
        `<div hidden id="S:2"><main><p>One</p><p>Two</p></main></div>` +
        `<p>After</p></body></html>`
    );

    expect(readableDocument($).allText()).toBe("Before One Two After");
  });

  it("leaves a document with no streaming containers untouched", () => {
    const $ = load(
      `<html><body><main><h1>Plain</h1><p>Server rendered.</p></main></body></html>`
    );

    expect(readableDocument($).texts("h1")).toEqual(["Plain"]);
    expect(readableDocument($).mainContent()).toBe("Plain Server rendered.");
  });

  it("leaves the live document intact, as every other extraction does", () => {
    const $ = streamed("<main><h1>Once</h1></main>");

    expect(readableDocument($).texts("h1")).toEqual(["Once"]);
    // Read twice: the unwrap happens on the clone, so the caller's tree still
    // has the container and a second call still finds the heading.
    expect(readableDocument($).texts("h1")).toEqual(["Once"]);
    expect($('div[hidden][id="S:2"]').length).toBe(1);
  });
});

describe("readableDocument allText", () => {
  it("includes the chrome that mainContent deliberately leaves out", () => {
    const $ = load(`<html><body>
      <nav>Privacy policy</nav>
      <main><p>Body copy.</p></main>
      <footer>Last updated March 2026</footer>
    </body></html>`);

    const readable = readableDocument($);
    expect(readable.mainContent()).toBe("Body copy.");
    expect(readable.allText()).toBe("Privacy policy Body copy. Last updated March 2026");
  });

  it("still leaves out script and style contents", () => {
    const $ = load(
      `<html><body><p>Copy.</p><script>var noise = "words words";</script></body></html>`
    );

    expect(readableDocument($).allText()).toBe("Copy.");
  });
});

describe("countInContent", () => {
  const doc = (html: string) => readableDocument(load(html));

  it("counts elements inside the page's copy, not the chrome around it", () => {
    // The structural half of the distinction `mainContent()` already drew for text.
    // Without it, a breadcrumb `<ol>` proved the page shows worked examples and a
    // footer of social icons proved its author publishes elsewhere (#341).
    const page = doc(`<html><body>
      <nav><ol><li>Home</li><li>Blog</li></ol></nav>
      <main><p>Copy</p><ol><li>step one</li></ol></main>
      <footer><a href="https://linkedin.com/company/x">LinkedIn</a></footer>
    </body></html>`);

    expect(page.countInContent("ol")).toBe(1);
    expect(page.countInContent('a[href*="linkedin"]')).toBe(0);
  });

  it("falls back to the body when the page declares no content container", () => {
    const page = doc(`<html><body><ol><li>only list</li></ol></body></html>`);
    expect(page.countInContent("ol")).toBe(1);
  });

  it("does not count what a reader never sees", () => {
    const page = doc(`<html><body><main>
      <script>var ol = "<ol><li>x</li></ol>";</script>
      <div hidden><ol><li>drawer</li></ol></div>
    </main></body></html>`);
    expect(page.countInContent("ol")).toBe(0);
  });
});
