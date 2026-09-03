import { type CheerioAPI } from "cheerio";
import { fetchHtml } from "../http-client";
import { readPage } from "./parsed-page";
import { declaredLanguage } from "./page-language";
import { countWords } from "../text-analyzer";
import { annotate, GOOGLE_SAYS, agentOperability } from "./check-source";
import { auditAgentOperability, type AgentOperabilityResult } from "./agent-operability";
import {
  evaluatePage,
  asIssueLine,
  type PageFacts,
} from "./seo-rules";

export interface OnPageSeoResult {
  url: string;
  meta: {
    title: string | null;
    titleLength: number;
    description: string | null;
    descriptionLength: number;
    canonical: string | null;
    robots: string | null;
    viewport: string | null;
    charset: string | null;
    lang: string | null;
  };
  headings: Record<string, string[]>;
  content: {
    wordCount: number;
    internalLinks: number;
    externalLinks: number;
    totalLinks: number;
  };
  images: {
    total: number;
    withoutAlt: string[];
  };
  openGraph: Record<string, string>;
  jsonLd: unknown[];
  hreflang: { lang: string; href: string }[];
  issues: string[];
}

// Was a third, private user agent pointing at +https://github.com/seo-mcp — a URL
// we do not own, and unsigned. It now presents the same identity as every other
// single-URL fetch. See lib/utils/bot-identity.ts.

export async function analyzeOnPageSeo(
  url: string
): Promise<OnPageSeoResult> {
  // `fetchHtml`, not a private `safeFetch`. This was the only analyzer outside the
  // **Single-Flight Cache**, and it is not an abstract cost: `seo_analyze_page`
  // runs in the same baseline batch as `seo_content_analysis`,
  // `seo_schema_detection`, `seo_eeat_score` and `seo_geo_score`, all of which
  // fetch this same URL and share one request. So every shared report and every
  // refresh made one extra HTTP request to the customer's page for no new
  // information (#348).
  //
  // Nothing is lost in the move: same 30s budget, same robots gate, same
  // per-hop signed headers, and `fetchWithTimeout` already throws the same
  // `PageFetchError.fromResponse` this hand-rolled.
  const html = await fetchHtml(url);

  const page = readPage(url, html);
  const $ = page.$;
  const parsedUrl = new URL(url);

  // ── Meta ──
  const title = $("title").first().text().trim() || null;
  const description =
    $('meta[name="description"]').attr("content")?.trim() || null;
  const canonical =
    $('link[rel="canonical"]').attr("href")?.trim() || null;
  const robots =
    $('meta[name="robots"]').attr("content")?.trim() || null;
  const viewport =
    $('meta[name="viewport"]').attr("content")?.trim() || null;
  const charset = extractCharset($);
  // Verbatim, so the report keeps saying `en-GB` rather than `en` — but read
  // where `page-language` reads it, which also knows about `xml:lang`. This was
  // the only reader that did not, and `seo-rules` fires `lang-missing` on it, so
  // an XHTML page that had declared its language was told it had not (#348).
  const lang = declaredLanguage(html);

  // ── Headings ──
  // One cleaned view of the document, queried seven times below. Building it per
  // query would clone the page (script payload included) seven times over.
  const readable = page.readable;

  const headings: Record<string, string[]> = {};
  for (const level of ["h1", "h2", "h3", "h4", "h5", "h6"]) {
    const found = readable.texts(level);
    if (found.length > 0) {
      headings[level] = found;
    }
  }

  // ── Word count ──
  // Read through the shared extractor: `$("body").text()` counted inline script
  // data as content and reported 46,434 words for a 2,100-word page (#291).
  const wordCount = countWords(readable.mainContent());

  // ── Links ──
  let internalLinks = 0;
  let externalLinks = 0;
  $("a[href]").each((_, el) => {
    const href = $(el).attr("href");
    if (!href) return;
    try {
      const linkUrl = new URL(href, url);
      if (linkUrl.hostname === parsedUrl.hostname) {
        internalLinks++;
      } else {
        externalLinks++;
      }
    } catch {
      internalLinks++; // Relative URLs count as internal
    }
  });

  // ── Links Google cannot follow ──
  const uncrawlableLinks = findUncrawlableLinks($);

  // ── Operability by agents ──
  //
  // Lives here rather than in the GEO analyzer on purpose. GEO is our model of
  // how answer engines pick passages; this is a fact about the DOM that Google
  // names a mechanism for, and the same fact serves someone on a screen reader.
  // Putting it beside the heuristics would have made it read as one.
  const agentOperability = auditAgentOperability($);

  // ── Images ──
  // A missing `alt` is an absent attribute, not an empty one. `alt=""` is the
  // documented way to mark an image as decorative (WCAG 2.2 §1.1.1, HTML spec): it
  // tells a screen reader to skip an image that carries no information the
  // surrounding text does not already give. Treating it as a defect reported our own
  // navbar — where the wordmark beside the mark already names the brand — as an
  // accessibility problem, and the fix it implied, giving the image alt text, would
  // have made a screen reader announce the brand twice. Only an absent attribute is
  // a finding now; `alt=" "` still counts as absent, because whitespace is neither
  // a description nor a decorative marker.
  const withoutAlt: string[] = [];
  let totalImages = 0;
  $("img").each((_, el) => {
    totalImages++;
    const alt = $(el).attr("alt");
    const decorative = alt === "";
    if (!decorative && (alt === undefined || alt.trim() === "")) {
      const src = $(el).attr("src") || "(no src)";
      withoutAlt.push(src);
    }
  });

  // ── Open Graph ──
  const openGraph: Record<string, string> = {};
  $('meta[property^="og:"]').each((_, el) => {
    const property = $(el).attr("property");
    const content = $(el).attr("content");
    if (property && content) {
      openGraph[property] = content;
    }
  });

  // ── JSON-LD ──
  // The last private parser, and the last one that could not see a top-level
  // array: `[{...},{...}]` is what any site without `@graph` emits, and it
  // arrived here as one opaque nested value while every other reader of the same
  // markup saw N flat payloads. Same blind spot #340 deleted from `eeat-analyzer`
  // and C3 deleted from `entity-mentions-tools` (#348).
  const jsonLd = [...page.schemas];

  // ── Hreflang ──
  const hreflang: { lang: string; href: string }[] = [];
  $('link[rel="alternate"][hreflang]').each((_, el) => {
    const lang = $(el).attr("hreflang");
    const href = $(el).attr("href");
    if (lang && href) {
      hreflang.push({ lang, href });
    }
  });

  // ── Issues ──
  const issues = detectIssues({
    title,
    description,
    canonical,
    robots,
    viewport,
    headings,
    totalImages,
    withoutAlt,
    lang,
    uncrawlableLinks,
    agentOperability,
  });

  return {
    url,
    meta: {
      title,
      titleLength: title?.length ?? 0,
      description,
      descriptionLength: description?.length ?? 0,
      canonical,
      robots,
      viewport,
      charset,
      lang,
    },
    headings,
    content: {
      wordCount,
      internalLinks,
      externalLinks,
      totalLinks: internalLinks + externalLinks,
    },
    images: {
      total: totalImages,
      withoutAlt,
    },
    openGraph,
    jsonLd,
    hreflang,
    issues,
  };
}

/**
 * Navigation Google will not follow.
 *
 * Google states the rule and then lists the ways sites break it: a link is
 * followable only when it is an `<a>` with an `href` holding a resolvable URL.
 * The three shapes below are the ones its documentation names.
 *
 * These were invisible to us until now, and invisible in the most misleading
 * way: every link counter in this codebase selects `a[href]`, so a page whose
 * whole navigation is `<span onclick>` reported zero problems and a healthy
 * internal link count of zero, which read as "no internal links" rather than
 * "the internal links are unreachable".
 */
function findUncrawlableLinks($: CheerioAPI): { markup: string; reason: string }[] {
  const found: { markup: string; reason: string }[] = [];

  // Attribute names are lowercased by the parser, so every selector and lookup
  // here must be lowercase too. `attr("routerLink")` returned undefined for the
  // Angular markup it was written to catch.
  // Takes the wrapped node rather than the raw one: cheerio's element type is
  // not re-exported from the package root, and everything needed is on the
  // wrapper anyway.
  const note = ($el: ReturnType<CheerioAPI>, reason: string) => {
    const text = $el.text().trim().slice(0, 60);
    const tag = ($el.prop("tagName") ?? "element").toString().toLowerCase();
    found.push({ markup: text ? `<${tag}> "${text}"` : `<${tag}>`, reason });
  };

  // An anchor with no href is not a link; Google treats it as text.
  $("a:not([href])").each((_, el) => {
    const $el = $(el);
    // A bare <a id="section"> is an anchor target, not broken navigation. Only
    // an anchor that behaves like a link while lacking one is a finding.
    if (!$el.attr("onclick") && !$el.attr("routerlink") && !$el.attr("ui-sref")) return;
    note($el, "an <a> without href — Google reads this as text, not a link");
  });

  // Framework routing attributes. The URL exists only after the router runs.
  $("[routerlink], [ui-sref]").each((_, el) => {
    const $el = $(el);
    if ($el.attr("href")) return; // A router link that also carries href is fine.
    note($el, "a router attribute instead of href — the destination only exists once JavaScript runs");
  });

  // href on something that is not an anchor does nothing at all.
  $("span[href], div[href], li[href], button[href]").each((_, el) => {
    note($(el), "href on a non-anchor element, which has no meaning in HTML");
  });

  return found;
}

function extractCharset($: CheerioAPI): string | null {
  const metaCharset = $("meta[charset]").attr("charset");
  if (metaCharset) return metaCharset;

  let charset: string | null = null;
  $('meta[http-equiv="Content-Type"]').each((_, el) => {
    const content = $(el).attr("content") || "";
    const match = content.match(/charset=([^\s;]+)/i);
    if (match) charset = match[1];
  });
  return charset;
}

interface ParsedPage {
  title: string | null;
  description: string | null;
  canonical: string | null;
  robots: string | null;
  viewport: string | null;
  headings: Record<string, string[]>;
  totalImages: number;
  withoutAlt: string[];
  lang: string | null;
  uncrawlableLinks: { markup: string; reason: string }[];
  agentOperability: AgentOperabilityResult;
}

/**
 * The parsed page, reduced to what the rules are allowed to judge on.
 *
 * The report builds the same shape from a stored section, so both sides feed
 * one set of rules from their own starting point without either owning them.
 */
function pageFacts(data: ParsedPage): PageFacts {
  return {
    titleLength: data.title?.length ?? 0,
    descriptionLength: data.description?.length ?? 0,
    h1Count: (data.headings["h1"] ?? []).length,
    canonical: data.canonical,
    viewport: data.viewport,
    lang: data.lang,
    imagesTotal: data.totalImages,
    imagesMissingAlt: data.withoutAlt.length,
  };
}

function detectIssues(data: ParsedPage): string[] {
  const issues: string[] = [];

  // Title, description, H1, canonical, viewport, lang and alt text are all SEO
  // Rules, and this file no longer states any of them. Each one used to be an
  // `if` with a threshold here and a second `if` with a different threshold in
  // `report-findings`, which is how the report came to be still enforcing a
  // 60-character title after this file had moved to 70.
  //
  // The rules decide; this file renders their verdicts for a practitioner.
  for (const verdict of evaluatePage(pageFacts(data))) {
    issues.push(asIssueLine(verdict));
  }

  // Links Google cannot follow. Reported with an example rather than a bare
  // count, because "3 uncrawlable links" is not something an author can act on.
  if (data.uncrawlableLinks.length > 0) {
    const [first] = data.uncrawlableLinks;
    const rest =
      data.uncrawlableLinks.length > 1
        ? ` (and ${data.uncrawlableLinks.length - 1} more)`
        : "";
    issues.push(
      annotate(
        `${data.uncrawlableLinks.length} link(s) Google cannot follow${rest}: ${first.markup} — ${first.reason}`,
        GOOGLE_SAYS.linksNeedHref
      )
    );
  }

  // Controls and fields an agent cannot operate. Same shape as the uncrawlable
  // links above — a count plus one worked example — because the fix is per
  // element and a bare total tells an author nothing about where to start.
  if (data.agentOperability.total > 0) {
    const [first] = data.agentOperability.findings;
    const rest =
      data.agentOperability.total > 1 ? ` (and ${data.agentOperability.total - 1} more)` : "";
    issues.push(
      annotate(
        `${data.agentOperability.total} element(s) an AI agent cannot operate${rest}: ${first.markup} — ${first.reason}`,
        // The criterion of the example shown, not a blanket one: the line names a
        // specific element, so it should cite the rule that element breaks.
        agentOperability(first.standard)
      )
    );
  }

  // Word count is reported by the content analyzer as a measurement. There is no
  // floor here: Google states "the length of the content alone doesn't matter
  // for ranking purposes", and the 300-word rule this file used to enforce
  // flagged every contact page and every well-made short answer.

  return issues;
}

// ── Section types (co-located with the module that produces them) ──────────────

export type OnPageSection = {
  meta: {
    title: string | null;
    titleLength: number;
    description: string | null;
    descriptionLength: number;
    canonical: string | null;
    robots: string | null;
    viewport: string | null;
    charset: string | null;
    lang: string | null;
  };
  headings: {
    h1: string[];
    h2: string[];
    h3: string[];
    h4: string[];
    hierarchyValid: boolean;
  };
  content: {
    wordCount: number;
    internalLinks: number;
    externalLinks: number;
    totalLinks: number;
  };
  images: { total: number; missingAlt: string[] };
  openGraph: Record<string, string>;
  jsonLd: unknown[];
  hreflang: Record<string, string>;
  issues: string[];
};
