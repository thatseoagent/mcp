import type { CheerioAPI } from "cheerio";

/**
 * Elements that start a new line when rendered, so the text on either side of
 * them is two words to a reader even though it is adjacent in the markup.
 */
const LINE_BREAKING =
  "br,hr,p,div,li,ul,ol,dl,dt,dd,table,caption,thead,tbody,tfoot,tr,td,th," +
  "h1,h2,h3,h4,h5,h6,hgroup,header,footer,section,article,aside,nav,main," +
  "address,blockquote,figure,figcaption,form,fieldset,legend,pre," +
  "details,summary,dialog,menu";

/**
 * Elements whose text content a reader never sees: code, styling, and the
 * fallback copy inside embeds that only shows when the embed fails.
 *
 * Cheerio's `.text()` walks every descendant text node, and the body of a
 * `<script>` is a text node. Any page that ships serialized state inline
 * therefore reported that state as content — 44,500 words of it in the case
 * that surfaced this (issue #291).
 *
 * ## What "visible" can and cannot mean here
 *
 * This list is a deliberate approximation, not an oversight. We parse HTML over
 * HTTP; we do not apply stylesheets or compute layout, so we cannot know what a
 * browser would actually paint. What we can read is what the markup declares,
 * and the list stops there.
 *
 * `[hidden]` is the HTML *attribute*, so `<nav hidden>` is dropped but
 * `<nav class="hidden">` is not — the second is a class name that happens to
 * read like a state. The consequences run both ways:
 *
 * - Text hidden by CSS (`class="hidden"`, `display:none`, `opacity:0`, offscreen
 *   positioning) is counted even though nobody sees it. This is the likelier of
 *   the two, and the one worth remembering when a word count looks high.
 * - Text inside `[hidden]` is dropped even though a script may reveal it, so a
 *   link that lives *only* in a closed drawer *and* has an unrecognised slug can
 *   go undetected. It needs both to be true: `hasLocalizedLink` reads hrefs from
 *   the live document, so a recognisable slug is found either way.
 *
 * Chasing CSS with more selectors would cover one mechanism and miss twenty,
 * which reads as precision without being it. Real precision here means
 * rendering the page, which is a different product decision, not a wider list.
 *
 * One `[hidden]` element is not a UI state at all — see
 * {@link REACT_STREAM_CONTAINER}.
 */
const NON_CONTENT =
  "script,style,noscript,template,svg,iframe,object,canvas,audio,video,[hidden]";

/**
 * React's streaming buffer, which is `[hidden]` without being hidden content.
 *
 * When React 18 streams SSR, each Suspense boundary that resolves after the
 * shell is written arrives as `<div hidden id="S:n">` appended to the body, with
 * a `<template id="B:n">` holding its place further up. An inline
 * `$RC("B:n","S:n")` then moves the children across. The attribute is there so a
 * browser paints nothing during the instant between the two.
 *
 * So the markup does declare it hidden, and the reader still sees every word of
 * it. Dropping it dropped whole pages: commet.co served an H1, four H2s,
 * thirteen H3s and 660 words, and we reported zero headings, zero words, and
 * "Missing H1 heading" as the site's only critical issue (#397). Its `<main>`
 * was inside the container too, so {@link CONTENT_CONTAINERS} matched nothing
 * and every content metric read zero rather than failing loudly.
 *
 * The match is React's own id scheme and nothing else: a `div`, carrying the
 * `hidden` attribute, sitting directly in the `body`, whose id is `S:<digits>`.
 * All four conditions have to hold.
 *
 * The optional leading group covers `identifierPrefix`, which React prepends to
 * both the boundary and the segment id. It has to end in a non-letter, because
 * `\S*` alone also accepts an id that merely *ends* in a capital S — `TABS:2`
 * would have been unwrapped, which is the widening this is supposed to prevent.
 *
 * Deliberately narrow. The failure to fear is not "we missed a container", which
 * shows up as a visibly empty report; it is widening until we count the closed
 * drawers and cookie banners that `[hidden]` is in the list for. A page that
 * still parses empty is a bug report. A page that counts its own hidden menus is
 * a wrong number nobody notices.
 */
const REACT_STREAM_CONTAINER = /^(?:\S*[^A-Za-z])?S:\d+$/;

/**
 * Where a page's own copy lives. The first match in document order wins; the
 * whole body is the fallback. Boilerplate — nav, footer, cookie banners — sits
 * outside these, and counting it as content makes every page that shares a
 * layout look more substantial than it is.
 */
const CONTENT_CONTAINERS =
  "main, article, [role='main'], #main, #content, .main-content";

/**
 * Blocks that hold a unit of prose. Deliberately not `div` or `section`: those
 * are layout, and counting them would report a page's nesting depth rather than
 * how much it has to say. `summary` is here because the FAQ pattern this repo
 * ships puts the question in one.
 */
const PROSE_BLOCKS = "p,li,blockquote,pre,dt,dd,figcaption,summary";

/**
 * Where copy ends up on a page written without a single `<p>`. Headings are not
 * in here: a heading is a label for prose, not prose.
 */
const LOOSE_BLOCKS = "div,td,th";

function normalize(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

/**
 * A page's text as a reader would see it, ready to be queried.
 *
 * Two extractions have to be done before any text is read, and both are easy to
 * forget at a call site:
 *
 * - Non-content elements are removed. `$("body").text()` counted a `<script>`
 *   body as page copy, which inflated `seo_analyze_page` 24x on a page carrying
 *   inline data and made it contradict `seo_content_analysis` (#291).
 * - Every element that renders on its own line contributes a space. Without it
 *   `<h1>foo<br>bar</h1>` reads as `foobar`, and a heading was reported to
 *   customers as a content defect that did not exist on their page (#290). The
 *   same fusing quietly undercounted body text across block boundaries.
 *
 * Build it once per document and query it as often as needed — the cleanup is a
 * full clone, so it is not something to repeat per heading level.
 */
export interface ReadableDocument {
  /** The visible text of each element matching `selector`, in document order, empty ones dropped. */
  texts(selector: string): string[];
  /** All of the page's copy: the semantic content container if there is one, the body otherwise. */
  mainContent(): string;
  /**
   * Every visible word on the page, chrome included. Use this to look for a
   * signal that legitimately lives outside the content — a footer's "Last
   * updated", a nav link to a privacy policy — and `mainContent()` to measure
   * how much the page actually says.
   */
  allText(): string;
  /**
   * The page's copy split into the prose blocks a reader sees as paragraphs.
   * A page with copy but no prose block counts as one paragraph; a page with no
   * copy at all counts as none.
   */
  paragraphs(): string[];
  /**
   * How many elements matching `selector` live inside the page's own copy.
   *
   * The same distinction `mainContent()` draws for text, drawn for structure. It
   * did not exist, so every check about the page's *shape* reached for the whole
   * document and counted the chrome: a breadcrumb `<ol>` proved the page shows
   * worked examples, a footer of social icons proved its author has an off-site
   * footprint, and six nav logos proved it carries technical diagrams (#341). A
   * text check could not make that mistake, because `mainContent()` was there.
   *
   * Counted inside the readable clone, so a `<script>`'s serialized markup and
   * anything behind the `hidden` attribute are already gone.
   */
  countInContent(selector: string): number;
  /**
   * The visible text of each element matching `selector` **inside the page's own
   * copy**, in document order, empty ones dropped.
   *
   * `texts()` scoped the way `countInContent()` scopes `count`, and the reason is
   * the same one: a site-wide nav is not this page saying something. Page
   * identity read its calls to action out of the serialised markup, so an
   * `aria-label`, a `<title>` and an `og:description` each counted as one and a
   * services page with no visible CTA at all was classified as a landing page
   * (#347). Counting them in `allText()` instead would have replaced that with a
   * worse bug — a SaaS nav carrying "Sign up" and "Get started" plus a footer
   * "Book a demo" makes every page on the site a landing page.
   */
  textsInContent(selector: string): string[];
}

export function readableDocument($: CheerioAPI): ReadableDocument {
  // A clone, because removing elements from the live tree would corrupt every
  // later extraction from the same document.
  const doc = $.root().clone();

  // Before the removal below, not after: these carry the page, and `[hidden]` in
  // NON_CONTENT would take them with it.
  //
  // Unwrapping and exempting produce the same text — `contentRoot()` searches
  // descendants, so it finds a `<main>` either side of the wrapper, and
  // `normalize()` eats the whitespace a surviving `div` would add. The choice is
  // about how the rule reads: one line that says "this wrapper was never part of
  // the document" beats threading a `:not(...)` through the NON_CONTENT selector,
  // where the exception would be invisible from the constant that lists it.
  //
  // `body >` because React writes these as direct children of the element it
  // streams into, and an app's own hidden markup lives wherever its component
  // does. The empty `<div hidden><!--$--><!--/$--></div>` React emits alongside
  // has no id and holds no text, so it needs no exception: NON_CONTENT can take
  // it, and does.
  doc.find("body > div[hidden][id]").each((_, el) => {
    const node = $(el);
    const id = node.attr("id");
    if (id && REACT_STREAM_CONTAINER.test(id)) node.replaceWith(node.contents());
  });

  doc.find(NON_CONTENT).remove();
  doc.find(LINE_BREAKING).before(" ").after(" ");

  function contentRoot() {
    const container = doc.find(CONTENT_CONTAINERS).first();
    return container.length ? container : doc.find("body");
  }

  return {
    texts(selector) {
      const texts: string[] = [];
      doc.find(selector).each((_, el) => {
        const text = normalize($(el).text());
        if (text) texts.push(text);
      });
      return texts;
    },

    textsInContent(selector) {
      const texts: string[] = [];
      contentRoot().find(selector).each((_, el) => {
        const text = normalize($(el).text());
        if (text) texts.push(text);
      });
      return texts;
    },

    mainContent() {
      return normalize(contentRoot().text());
    },

    allText() {
      return normalize(doc.find("body").text());
    },

    paragraphs() {
      const root = contentRoot();

      // Each block contributes the text it owns, with any nested block of the
      // same kind excluded — so `<li>outer<ul><li>a</li></ul></li>` is "outer"
      // and "a", not the same words counted twice and not "outer" dropped.
      const blocksOf = (selector: string): string[] => {
        const blocks: string[] = [];
        root.find(selector).each((_, el) => {
          const own = $(el).clone();
          own.find(selector).remove();
          const text = normalize(own.text());
          if (text) blocks.push(text);
        });
        return blocks;
      };

      const prose = blocksOf(PROSE_BLOCKS);
      if (prose.length > 0) return prose;

      const loose = blocksOf(LOOSE_BLOCKS);
      if (loose.length > 0) return loose;

      // Copy with no block structure at all is still one block of prose.
      const all = normalize(root.text());
      return all ? [all] : [];
    },

    countInContent(selector) {
      return contentRoot().find(selector).length;
    },
  };
}

/** Shorthand for a single query against a document you do not otherwise need. */
export function visibleTexts($: CheerioAPI, selector: string): string[] {
  return readableDocument($).texts(selector);
}

/** Shorthand for the page copy of a document you do not otherwise need. */
export function mainContentText($: CheerioAPI): string {
  return readableDocument($).mainContent();
}
