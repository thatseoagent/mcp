import { load, type CheerioAPI } from "cheerio";
import { readableDocument, type ReadableDocument } from "../visible-text";
import { extractJsonLd, getSchemaTypes } from "./json-ld-graph";
import { identifyPage, type PageIdentity } from "./page-identity";
import { pageLanguage } from "./page-language";

/**
 * One document, read once, by everyone who needs it.
 *
 * ── Why this exists ──
 *
 * `html: string` was the currency of the whole analyzer tree — 23 of its entry
 * points took one — and every module derived from it whatever it needed. Since
 * the same five things get derived every time, the same document was parsed
 * repeatedly within a single tool run. Measured on this branch, before this
 * module:
 *
 *   ai_visibility_score  5 parses (4 of the analyzed page, 1 of the site home)
 *   seo_eeat_score       4 parses (3 of the analyzed page, 1 of the home)
 *   seo_geo_score        2 parses
 *
 * Plus a full `$.root().clone()` per `readableDocument()`, three of them in the
 * AI-visibility run alone.
 *
 * Performance is the least of it. The real cost is at the interfaces:
 * `showsTrustPage($, visibleText, schemas, kind)` takes three arguments that
 * always come from one document and one that actually varies, and
 * `analyzeExpertise($, text, pageKind, readable, pageAuthor)` takes five where
 * two are decisions. Those signatures are a data clump wearing a parameter list.
 *
 * ── Why lazy, and why that is the whole design ──
 *
 * `page-identity.ts` deliberately took raw HTML, and its reason was good:
 *
 *   "Takes raw HTML rather than a parsed document so no caller has to know
 *    cheerio is involved: `geo-tools` works entirely in strings and would
 *    otherwise acquire a dependency it has no other use for."
 *
 * That is still literally true — `geo-tools` imports no cheerio to this day. The
 * argument is right about what it protects and wrong that a string is the only
 * way to protect it. Every field here is a lazy getter, memoised, so a caller
 * that never touches `$` never parses and never links cheerio: it depends on
 * this module, not on the parser. The decision is not so much reversed as met
 * properly. See ADR-0022.
 *
 * ── What is deliberately not here ──
 *
 * The fetch. `readPage` is pure. C4 had just finished taking network I/O out of
 * `eeat-analyzer`; putting it into the module that replaces its inputs would
 * undo that the following day. Handlers fetch, this parses.
 *
 * `isHttps`. It is a fact about the URL, not a reading of the document, and
 * admitting it starts the slide from "what this document says" to "everything
 * downstream happens to need". The bar for a field here is: derived from the
 * document, and wanted by more than one module.
 */
export interface ParsedPage {
  readonly url: string;
  readonly html: string;
  /** The parsed tree. Touching this is what triggers the parse. */
  readonly $: CheerioAPI;
  /** Copy and chrome told apart. See `visible-text.ts`. */
  readonly readable: ReadableDocument;
  /** Every JSON-LD payload, `@graph` and top-level arrays flattened. */
  readonly schemas: readonly unknown[];
  /** The base language the page declares, or `null`. See `page-language.ts`. */
  readonly language: string | null;
  /** What kind of page this is, and why. See `page-identity.ts`. */
  readonly identity: PageIdentity;
}

/** Memoise a getter: computed at most once, and only if asked. */
function lazy<T>(compute: () => T): () => T {
  let done = false;
  let value: T;
  return () => {
    if (!done) {
      value = compute();
      done = true;
    }
    return value;
  };
}

export function readPage(url: string, html: string): ParsedPage {
  const $ = lazy(() => load(html));
  const readable = lazy(() => readableDocument($()));
  const schemas = lazy<readonly unknown[]>(() => extractJsonLd(html));
  const language = lazy(() => pageLanguage(html));
  // `identity` reads `$`, so asking for it does parse — but once, shared with
  // every other reader of the same page rather than in a `load` of its own.
  const identity = lazy(() => identifyPage(url, $(), readable(), getSchemaTypes(schemas())));

  return {
    url,
    html,
    get $() { return $(); },
    get readable() { return readable(); },
    get schemas() { return schemas(); },
    get language() { return language(); },
    get identity() { return identity(); },
  };
}
