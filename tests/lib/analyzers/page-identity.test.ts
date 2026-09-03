/**
 * The schema stack used to be a fixed list demanded of every URL, so auditing a
 * homepage reported "Missing: Article, BreadcrumbList" — a trail of ancestors
 * for a page with no ancestors, and an article byline for a page that is not an
 * article. These pin the page-type rules that replaced it.
 */
import { describe, it, expect } from "vitest";

import { identifyPage as identifyParsed, pageKindLabel, isUndatedPage, isUnauthoredPage, type PageKind } from "@/lib/analyzers/page-identity";
import { load } from "cheerio";
import { readableDocument } from "@/lib/visible-text";

/**
 * `identifyPage` takes a parsed document since ADR-0022. This file's subject is
 * the classification of markup, so it keeps working in HTML strings and parses
 * on the way in — one line here instead of 45 call sites, and the fixtures stay
 * readable as what they are.
 */
const identifyPage = (url: string, html: string, declaredTypes?: Iterable<string>) => {
  const $ = load(html);
  return identifyParsed(url, $, readableDocument($), declaredTypes);
};
import { expectedSchemas } from "@/lib/analyzers/schema-analyzer";

const bare = "<html><head></head><body><h1>Hi</h1></body></html>";

const labels = (list: Array<{ label: string }>) => list.map((r) => r.label);

describe("identifyPage — the root", () => {
  it("treats the bare origin as the homepage", () => {
    const id = identifyPage("https://example.com/", bare);
    expect(id).toMatchObject({ kind: "homepage", isRoot: true, depth: 0 });
  });

  it("treats a locale root as a homepage, not a first-level page", () => {
    // /es is the Spanish homepage. Counting it as one level down would demand a
    // breadcrumb trail from a page that is itself the top of its tree.
    const id = identifyPage("https://example.com/es", bare);
    expect(id).toMatchObject({ kind: "homepage", isRoot: true, depth: 0 });
    expect(identifyPage("https://example.com/en-GB/", bare).isRoot).toBe(true);
  });

  it("treats an explicit index file as the root", () => {
    expect(identifyPage("https://example.com/index.html", bare).isRoot).toBe(true);
  });

  it("does not mistake a real first-level page for a locale root", () => {
    const id = identifyPage("https://example.com/pricing", bare);
    expect(id.isRoot).toBe(false);
    expect(id.depth).toBe(1);
  });
});

describe("expectedSchemas — a homepage owes neither Article nor BreadcrumbList", () => {
  const home = expectedSchemas(identifyPage("https://example.com/", bare));

  it("requires the site's identity, not an article", () => {
    expect(labels(home.required).sort()).toEqual(["Organization", "WebSite"]);
  });

  it("says why each inapplicable type was dropped", () => {
    expect(labels(home.exempt).sort()).toEqual(["Article", "BreadcrumbList"]);
    const crumb = home.exempt.find((e) => e.label === "BreadcrumbList")!;
    expect(crumb.because).toMatch(/no pages above it/i);
  });
});

describe("expectedSchemas — BreadcrumbList follows the trail, not the URL alone", () => {
  it("is not required one level down with no visible trail", () => {
    const id = identifyPage("https://example.com/pricing", bare);
    expect(labels(expectedSchemas(id).required)).not.toContain("BreadcrumbList");
    expect(labels(expectedSchemas(id).exempt)).toContain("BreadcrumbList");
  });

  it("is required as soon as the page renders a trail, however shallow", () => {
    const html = (`<html><body><nav aria-label="Breadcrumb"><a href="/">Home</a></nav></body></html>`);
    const id = identifyPage("https://example.com/pricing", html);
    expect(id.hasVisibleBreadcrumb).toBe(true);
    const req = expectedSchemas(id).required.find((r) => r.label === "BreadcrumbList")!;
    expect(req.because).toMatch(/renders a breadcrumb trail/i);
  });

  it("finds a trail marked only by a class name", () => {
    const html = (`<html><body><ol class="c-breadcrumbs"><li>Home</li></ol></body></html>`);
    expect(identifyPage("https://example.com/a/b", html).hasVisibleBreadcrumb).toBe(true);
  });

  it("is required deep in the tree even with no visible trail", () => {
    const id = identifyPage("https://example.com/blog/2026/my-post", bare);
    expect(id.depth).toBe(3);
    expect(labels(expectedSchemas(id).required)).toContain("BreadcrumbList");
  });
});

describe("identifyPage — recognising an article", () => {
  it("reads og:type", () => {
    const html = (`<html><head><meta property="og:type" content="article"></head><body></body></html>`);
    expect(identifyPage("https://example.com/blog/post", html).kind).toBe("article");
  });

  it("reads an <article> carrying a date", () => {
    const html = (`<html><body><article><time datetime="2026-07-30">July</time><p>x</p></article></body></html>`);
    expect(identifyPage("https://example.com/blog/post", html).kind).toBe("article");
  });

  it("does not call a bare <article> wrapper an article without a date or byline", () => {
    // Plenty of layouts wrap non-article content in <article>. On its own it is
    // not evidence of dated, authored writing.
    const html = (`<html><body><article><h1>Our services</h1></article></body></html>`);
    expect(identifyPage("https://example.com/services", html).kind).toBe("generic");
  });

  it("requires Article once the page is one", () => {
    const html = (`<html><head><meta property="og:type" content="article"></head><body></body></html>`);
    const exp = expectedSchemas(identifyPage("https://example.com/blog/post", html));
    expect(labels(exp.required)).toContain("Article");
    expect(labels(exp.exempt)).not.toContain("Article");
  });

  it("never requires Article on a homepage, even when og:type claims it", () => {
    // A misconfigured homepage sometimes ships og:type=article. The URL is the
    // stronger signal and the root is a homepage regardless.
    const html = (`<html><head><meta property="og:type" content="article"></head><body></body></html>`);
    const exp = expectedSchemas(identifyPage("https://example.com/", html));
    expect(labels(exp.required)).not.toContain("Article");
  });
});

describe("identifyPage — declared types name the page", () => {
  it("recognises a product page from its own schema", () => {
    const id = identifyPage("https://example.com/shop/thing", bare, ["Product", "Offer"]);
    expect(id.kind).toBe("product");
    expect(labels(expectedSchemas(id).required)).toContain("Product");
  });

  it("recognises a listing page", () => {
    const id = identifyPage("https://example.com/shop", bare, ["CollectionPage"]);
    expect(id.kind).toBe("collection");
    expect(labels(expectedSchemas(id).required)).not.toContain("Article");
  });

  it("does not let a declared type override the root", () => {
    expect(identifyPage("https://example.com/", bare, ["Product"]).kind).toBe("homepage");
  });
});

describe("expectedSchemas — Organization is owed everywhere", () => {
  it.each([
    ["https://example.com/", []],
    ["https://example.com/pricing", []],
    ["https://example.com/blog/2026/post", []],
    ["https://example.com/shop/item", ["Product"]],
  ])("requires it on %s", (url, declared) => {
    const exp = expectedSchemas(identifyPage(url, bare, declared as string[]));
    expect(labels(exp.required)).toContain("Organization");
  });
});

describe("identifyPage — explains itself", () => {
  it("records the evidence behind the call", () => {
    const id = identifyPage("https://example.com/blog/2026/post", bare);
    expect(id.signals.length).toBeGreaterThan(0);
    expect(id.signals.join(" ")).toMatch(/3 levels below the root/);
  });

  it("survives an unparseable URL without claiming to be the root", () => {
    const id = identifyPage("not a url", bare);
    expect(id.isRoot).toBe(false);
    expect(id.signals.join(" ")).toMatch(/could not be parsed/i);
  });
});

describe("pageKindLabel", () => {
  it("gives every kind a human phrase", () => {
    expect(pageKindLabel("homepage")).toBe("Homepage");
    expect(pageKindLabel("generic")).toBe("General page");
  });
});

describe("identifyPage — the rules inherited from the GEO classifier", () => {
  it("reads English and Spanish article path slugs", () => {
    for (const p of ["/blog/seo-tips", "/noticias/mi-articulo", "/articulos/seo", "/entradas/x"]) {
      expect(identifyPage("https://example.com" + p, bare).kind).toBe("article");
    }
  });

  it("reads English and Spanish product path slugs", () => {
    for (const p of ["/shop/thing", "/tienda/camiseta", "/productos/123"]) {
      expect(identifyPage("https://example.com" + p, bare).kind).toBe("product");
    }
  });

  it("reads FAQ paths in both languages, and FAQPage schema", () => {
    expect(identifyPage("https://example.com/faq", bare).kind).toBe("faq");
    expect(identifyPage("https://example.com/preguntas-frecuentes", bare).kind).toBe("faq");
    expect(identifyPage("https://example.com/anything", bare, ["FAQPage"]).kind).toBe("faq");
  });

  it("recognises a landing page by repeated calls to action, in both languages", () => {
    // Three clickable CTAs. The first used to be a `<p>`, which counted while
    // this read the serialised markup; a phrase in a paragraph is copy, not an
    // affordance, and the case below pins that it no longer counts (#347).
    const en = `<html><body><a>Get started today</a><a>Sign up free</a><button>Try free</button></body></html>`;
    const es = `<html><body><a>Empieza hoy</a><a>Regístrate gratis</a><button>Prueba gratis</button></body></html>`;
    expect(identifyPage("https://example.com/pricing", en).kind).toBe("landing");
    expect(identifyPage("https://example.com/precios", es).kind).toBe("landing");
  });

  it("does not count a call to action a reader cannot see (#347)", () => {
    // An accessible icon button, a `<title>` and a meta description each matched
    // once when this read the serialised document, so a services page with zero
    // visible CTAs was a landing page — and labelling your buttons for screen
    // readers was what triggered it.
    const invisible = `<html><head><title>Get started | Acme</title>
      <meta name="description" content="Sign up and get started with our team." /></head>
      <body><main><h1>Our services</h1><p>We do consulting for teams in Madrid.</p>
      <a href="/signup" aria-label="Sign up"><svg /></a></main></body></html>`;
    expect(identifyPage("https://example.com/services", invisible).kind).toBe("generic");
  });

  it("does not count the site-wide nav, which every page carries (#347)", () => {
    // The reason the count is scoped to the content. A SaaS nav plus a footer
    // CTA is three on every page of the site, so counting document-wide would
    // make the privacy policy a landing page.
    const chrome = `<html><body>
      <nav><a href="/1">Sign up</a><a href="/2">Get started</a></nav>
      <main><h1>Privacy policy</h1><p>We process personal data lawfully.</p></main>
      <footer><a href="/3">Book a demo</a></footer></body></html>`;
    expect(identifyPage("https://example.com/privacy", chrome).kind).toBe("generic");
  });

  it("counts each clickable CTA once, however the phrase repeats in its markup", () => {
    // One button carrying the phrase in its text and its `aria-label` is one
    // call to action, not two.
    const one = `<html><body><main><h1>Our services</h1><p>Consulting for teams.</p>
      <a href="/x" aria-label="Get started" title="Get started">Get started</a></main></body></html>`;
    expect(identifyPage("https://example.com/services", one).kind).toBe("generic");
  });

  it("does not call a page a landing page on one call to action", () => {
    const one = `<html><body><a>Sign up free</a></body></html>`;
    expect(identifyPage("https://example.com/pricing", one).kind).toBe("generic");
  });
});

describe("identifyPage — the disagreements that motivated the merge", () => {
  // The GEO classifier returned `generic` for all three of these, so every
  // localized homepage was scored against a generic page's 41 checks and marked
  // down for having no author, no publication date and no TL;DR.
  it.each(["/es", "/en-GB/", "/index.html", "/es/"])(
    "treats %s as a homepage",
    (path) => {
      const id = identifyPage("https://example.com" + path, bare);
      expect(id.kind).toBe("homepage");
      expect(id.isRoot).toBe(true);
    }
  );

  it("still treats a real first-level page as one level down", () => {
    const id = identifyPage("https://example.com/es/precios", bare);
    expect(id.isRoot).toBe(false);
    expect(id.depth).toBe(2);
  });
});

describe("identifyPage — precedence is load-bearing", () => {
  it("lets the root beat every other signal", () => {
    const loud = `<html><head><meta property="og:type" content="article"></head>
      <body><p>Get started</p><a>Sign up free</a><button>Try free</button></body></html>`;
    expect(identifyPage("https://example.com/", loud, ["Product", "FAQPage"]).kind).toBe("homepage");
  });

  it("scores an FAQ under /blog/ as an FAQ", () => {
    expect(identifyPage("https://example.com/blog/faq", bare).kind).toBe("faq");
  });

  it("scores a product page carrying Article markup as a product page", () => {
    expect(identifyPage("https://example.com/shop/x", bare, ["Product", "Article"]).kind).toBe("product");
  });
});

describe("the two N/A predicates", () => {
  const KINDS: PageKind[] = ["homepage", "article", "product", "faq", "landing", "collection", "profile", "generic"];

  it("treats a listing page as having neither a date nor an author", () => {
    expect(isUndatedPage("collection")).toBe(true);
    expect(isUnauthoredPage("collection")).toBe(true);
  });

  it("treats a profile page as undated but authored — it is about a person", () => {
    expect(isUndatedPage("profile")).toBe(true);
    expect(isUnauthoredPage("profile")).toBe(false);
  });

  it("only ever excuses an article from nothing", () => {
    expect(isUndatedPage("article")).toBe(false);
    expect(isUnauthoredPage("article")).toBe(false);
  });

  it("answers for every kind", () => {
    for (const k of KINDS) {
      expect(typeof isUndatedPage(k)).toBe("boolean");
      expect(typeof isUnauthoredPage(k)).toBe("boolean");
    }
  });
});

describe("the limit of identifying a page from what it declares", () => {
  // A page can only be identified by what it publishes. These pin where that
  // runs out, so the gap is a known shape rather than a surprise.
  const bare = "<html><head></head><body><h1>Some writing</h1><p>Words.</p></body></html>";
  const labels = (l: Array<{ label: string }>) => l.map((r) => r.label);

  it("recognises an article from any one of three independent signals", () => {
    // None of these needs Article schema to be present already, so "Missing:
    // Article" is reachable for the common cases.
    const og = `<html><head><meta property="og:type" content="article"></head><body></body></html>`;
    const dated = `<html><body><article><time datetime="2026-07-30">x</time></article></body></html>`;

    expect(identifyPage("https://example.com/thoughts/x", og).kind).toBe("article");
    expect(identifyPage("https://example.com/thoughts/x", dated).kind).toBe("article");
    expect(identifyPage("https://example.com/blog/x", bare).kind).toBe("article");

    for (const html of [og, dated]) {
      const exp = expectedSchemas(identifyPage("https://example.com/thoughts/x", html));
      expect(labels(exp.required)).toContain("Article");
    }
  });

  it("cannot tell an article that declares nothing at all, and exempts it", () => {
    // A post at /thoughts/ with no og:type, no <article> date or byline and no
    // Article schema is indistinguishable from a services page. It is exempted
    // rather than nagged, which is the deliberate trade: guessing would put the
    // old false "Missing: Article" back on every generic page.
    const id = identifyPage("https://example.com/thoughts/my-post", bare);
    expect(id.kind).toBe("generic");

    const exp = expectedSchemas(id);
    expect(labels(exp.required)).not.toContain("Article");
    expect(exp.exempt.find((e) => e.label === "Article")?.because).toMatch(/not an article/i);
  });

  it("says which signal it used, so a wrong call is arguable", () => {
    const og = `<html><head><meta property="og:type" content="article"></head><body></body></html>`;
    expect(identifyPage("https://example.com/thoughts/x", og).signals.join(" ")).toMatch(/og:type is article/);
  });
});
