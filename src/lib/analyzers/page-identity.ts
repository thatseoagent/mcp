import type { CheerioAPI } from "cheerio";
import type { ReadableDocument } from "../visible-text";

/**
 * What kind of page is this — the single answer for the whole codebase.
 *
 * This module replaces two that answered the same question differently:
 * `geo-analyzer.detectPageType` (path slugs, CTA counting, `homepage`/`generic`)
 * and `page-type.identifyPage` (locale roots, og:type, DOM shape, `home`/`other`).
 * Neither had the full domain, and they disagreed: `/es`, `/en-GB/` and
 * `/index.html` were homepages to one and generic pages to the other, so every
 * localized homepage was scored against the 41 checks of a generic page and
 * marked down for having no author, no publication date and no TL;DR.
 *
 * The vocabulary is the one already persisted in `GeoSection.pageType`, extended
 * with the two kinds only the other module knew about.
 */
export type PageKind =
  | "homepage"
  | "article"
  | "product"
  | "faq"
  | "landing"
  | "collection"
  | "profile"
  | "generic";

export interface PageIdentity {
  kind: PageKind;
  /** The site root. Also true for a locale root like `/es` and for `/index.html`. */
  isRoot: boolean;
  /** Path segments below the root, so we know whether a trail is even possible. */
  depth: number;
  /** A breadcrumb trail a reader can see, independent of any markup describing it. */
  hasVisibleBreadcrumb: boolean;
  /** The evidence, in the order it was weighed, so a wrong call can be argued with. */
  signals: string[];
}

/** `/es`, `/en-GB` and friends are homepages, not first-level pages. */
const LOCALE_SEGMENT = /^[a-z]{2}(?:[-_][a-z]{2,4})?$/i;
const INDEX_FILE = /^index\.(html?|php|aspx?)$/i;

export const ARTICLE_TYPES = ["Article", "BlogPosting", "NewsArticle", "TechArticle", "Report"];
export const PRODUCT_TYPES = ["Product", "ProductGroup", "Offer"];
const COLLECTION_TYPES = ["CollectionPage", "ItemList", "SearchResultsPage"];
const PROFILE_TYPES = ["ProfilePage", "AboutPage"];

// Path slugs cover English and Spanish so a localized page gets the same kind as
// its English equivalent. This feeds the N/A classification that drives the
// reweighted GEO Score, so a miss here costs the page real points.
const FAQ_PATH = /(?:^|\/)(?:faqs?|preguntas-frecuentes|preguntas)(?:\/|$)/i;
const ARTICLE_PATH = /\/(blog|news|post|posts|article|articles|noticias|noticia|articulo|articulos|artículo|artículos|entrada|entradas)\//i;
const PRODUCT_PATH = /\/(product|products|shop|store|item|items|producto|productos|tienda)\//i;
/**
 * Deliberately not `g`. This is tested against one element's text at a time now,
 * and a global regex carries `lastIndex` between `.test()` calls, so alternate
 * elements would silently fail to match.
 */
const CTA_PHRASE = /\b(get started|sign up|try free|buy now|start free|start trial|book a demo|request demo|empieza|empezar|regístrate|registrate|prueba gratis|prueba gratuita|comprar ahora|reserva una demo|solicita una demo|solicitar demo)\b/i;

/**
 * A visible breadcrumb trail.
 *
 * Read from the rendered page, never from the markup being audited: the question
 * is whether a trail the reader sees has been described in schema, so using that
 * schema as evidence would answer itself.
 */
function detectVisibleBreadcrumb($: CheerioAPI): boolean {
  const labelled = $("nav[aria-label],ol[aria-label],ul[aria-label]").filter((_, el) => {
    const label = $(el).attr("aria-label") ?? "";
    return /bread\s*crumb|migas|ruta/i.test(label);
  });
  if (labelled.length > 0) return true;
  return $('[class*="breadcrumb" i], [id*="breadcrumb" i], [class*="miga" i]').length > 0;
}

/** Article-shaped: a body of writing with a date or a byline attached. */
function looksLikeArticle($: CheerioAPI): boolean {
  if ($("article").length === 0) return false;
  const hasDate = $("time[datetime], [itemprop='datePublished'], [property='article:published_time']").length > 0;
  const hasByline = $("[rel='author'], [itemprop='author'], [class*='author' i], [class*='byline' i]").length > 0;
  return hasDate || hasByline;
}

function declares(declared: Set<string>, candidates: readonly string[]): boolean {
  return candidates.some((t) => declared.has(t));
}

/**
 * Identify the page from its URL, its own declarations, and its DOM.
 *
 * Takes the parsed document. It used to take raw HTML and parse internally, so
 * that no caller had to know cheerio was involved — `geo-tools` works entirely
 * in strings and would otherwise acquire a dependency it has no other use for.
 * That goal was right and is now met better: callers hold a **Parsed Page**,
 * whose fields are lazy, so one that never touches `$` never parses and still
 * links no parser. What this call used to cost was a second parse of a document
 * the caller had usually already parsed. See ADR-0022 and `parsed-page.ts`.
 *
 * `declaredTypes` are the schema types already found on the page. They identify
 * what the page says it is (a Product, a CollectionPage) and are never used to
 * decide whether a type we are about to require is present, which would be
 * circular.
 *
 * Precedence is deliberate and the order is load-bearing:
 *   root → faq → product → article → collection → profile → landing → generic
 * The root wins outright; a misconfigured homepage claiming `og:type=article` is
 * still a homepage. An FAQ under `/blog/` is scored as an FAQ. A product page
 * that also carries Article markup is scored as a product page.
 */
export function identifyPage(
  url: string,
  $: CheerioAPI,
  /**
   * The same document with chrome and non-content stripped.
   *
   * Passed in rather than built here: `readableDocument()` is a full clone, and
   * the caller holding a **Parsed Page** already has one memoised. Building a
   * second would undo what ADR-0022 just bought.
   */
  readable: ReadableDocument,
  declaredTypes: Iterable<string> = []
): PageIdentity {
  const signals: string[] = [];

  let pathname = "";
  let segments: string[] = [];
  try {
    pathname = new URL(url).pathname;
    segments = pathname.split("/").filter(Boolean);
  } catch {
    // A malformed URL tells us nothing about depth. Treat it as a leaf rather
    // than claiming root privileges we cannot prove.
    segments = ["unknown"];
    signals.push("URL could not be parsed; assuming this is not the site root");
  }

  if (segments.length === 1 && INDEX_FILE.test(segments[0])) segments = [];

  const isRoot = segments.length === 0 || (segments.length === 1 && LOCALE_SEGMENT.test(segments[0]));
  const depth = isRoot ? 0 : segments.length;

  if (isRoot) {
    signals.push(segments.length === 0 ? "URL is the site root" : `URL is the ${segments[0]} locale root`);
  } else if (pathname) {
    signals.push(`URL is ${depth} level${depth === 1 ? "" : "s"} below the root`);
  }

  const declared = new Set(declaredTypes);
  const ogType = ($("meta[property='og:type']").attr("content") ?? "").trim().toLowerCase();
  const hasVisibleBreadcrumb = detectVisibleBreadcrumb($);
  if (hasVisibleBreadcrumb) signals.push("the page renders a breadcrumb trail");

  const kind = classify({ isRoot, pathname, declared, ogType, $, readable, signals });

  return { kind, isRoot, depth, hasVisibleBreadcrumb, signals };
}

function classify(ctx: {
  isRoot: boolean;
  pathname: string;
  declared: Set<string>;
  ogType: string;
  readable: ReadableDocument;
  $: CheerioAPI;
  signals: string[];
}): PageKind {
  const { isRoot, pathname, declared, ogType, $, readable, signals } = ctx;

  if (isRoot) return "homepage";

  if (FAQ_PATH.test(pathname) || declared.has("FAQPage")) {
    signals.push(declared.has("FAQPage") ? "the page declares FAQPage schema" : "the URL names an FAQ");
    return "faq";
  }

  if (declares(declared, PRODUCT_TYPES) || ogType === "product" || PRODUCT_PATH.test(pathname)) {
    signals.push(
      declares(declared, PRODUCT_TYPES) ? "the page declares Product schema"
      : ogType === "product" ? "og:type is product"
      : "the URL names a product"
    );
    return "product";
  }

  if (declares(declared, ARTICLE_TYPES) || ogType === "article" || ARTICLE_PATH.test(pathname) || looksLikeArticle($)) {
    signals.push(
      declares(declared, ARTICLE_TYPES) ? "the page declares Article schema"
      : ogType === "article" ? "og:type is article"
      : ARTICLE_PATH.test(pathname) ? "the URL names an article"
      : "the page has an <article> with a date or a byline"
    );
    return "article";
  }

  if (declares(declared, COLLECTION_TYPES)) {
    signals.push("the page declares CollectionPage or ItemList schema");
    return "collection";
  }

  if (declares(declared, PROFILE_TYPES) || ogType === "profile") {
    signals.push(ogType === "profile" ? "og:type is profile" : "the page declares ProfilePage schema");
    return "profile";
  }

  // A landing page is recognised by how hard it is selling, which is the only
  // signal available when nothing else identifies it.
  //
  // Clickable elements whose own visible text is a call to action, counted inside
  // the page's copy. Three decisions, and each of them is load-bearing (#347):
  //
  // - **Visible text, not markup.** This matched the serialised document, so an
  //   `aria-label`, a `<title>` and an `og:description` each counted as one, and
  //   a services page with a single accessible icon button and no visible CTA at
  //   all was classified as a landing page. Accessible markup was what triggered
  //   it, which is the wrong way round. Same smell #341 removed from E-E-A-T.
  //
  // - **Per element, not hits in a blob.** The obvious fix — regex over
  //   `allText()` — breaks the detection it is meant to sharpen: inline elements
  //   concatenate without separators, so `<a>Get started</a><p>Teams love
  //   it.</p>` reads as "Get startedTeams" and the `\b` anchor fails. A genuine
  //   three-CTA landing page scores 1 that way.
  //
  // - **Inside the content.** A SaaS nav with "Sign up" and "Get started" plus a
  //   footer "Book a demo" is three CTAs on *every page of the site*, so counting
  //   document-wide would classify the privacy policy as a landing page.
  const ctaMatches = readable
    .textsInContent("a,button,[role='button']")
    .filter((text) => CTA_PHRASE.test(text)).length;
  if (ctaMatches >= 3) {
    signals.push(`the page repeats a call to action ${ctaMatches} times`);
    return "landing";
  }

  return "generic";
}

/** A short, human phrase for the report: "Homepage", "Article", … */
export function pageKindLabel(kind: PageKind): string {
  if (kind === "homepage") return "Homepage";
  if (kind === "article") return "Article";
  if (kind === "product") return "Product page";
  if (kind === "faq") return "FAQ page";
  if (kind === "landing") return "Landing page";
  if (kind === "collection") return "Listing page";
  if (kind === "profile") return "Profile page";
  return "General page";
}

/**
 * Page kinds that carry no dated, authored content.
 *
 * Anything measuring "when was this written" does not apply to them. A listing
 * page and a profile page join the original four: neither is published on a date.
 */
export function isUndatedPage(kind: PageKind): boolean {
  return kind === "product" || kind === "homepage" || kind === "landing"
    || kind === "faq" || kind === "collection" || kind === "profile";
}

/**
 * Page kinds with no personal author to credit.
 *
 * A profile page is deliberately absent: it is *about* a person, so it is the one
 * undated kind that still owes Person schema.
 */
export function isUnauthoredPage(kind: PageKind): boolean {
  return kind === "landing" || kind === "product" || kind === "homepage" || kind === "collection";
}
