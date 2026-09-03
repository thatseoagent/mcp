/**
 * Building an `llms.txt` out of what a site already publishes.
 *
 * Split out of the Tool because it is the half with a rule to enforce — nothing
 * in a generated file may be invented — and because that rule is easier to hold
 * to in a module that only ever reads the site and returns text. The Tool decides
 * *whether* to generate; this decides what a generated file may say.
 */
import { parseSitemap } from "./sitemap-parser";
import { fetchAnyStatus } from "./http-client";
import { readWellKnown, type WellKnownRead } from "./well-known";
import { extractPageMeta, fetchPagesMeta, PAGE_META_LIMIT, type PageMeta } from "./page-meta";

// ── buildGeneratedTemplate ────────────────────────────────────────────────────

/**
 * Last-resort label for a page whose own `<title>` could not be read.
 *
 * **A slug is not a title, and this function used to pretend otherwise.** It
 * title-cased the last path segment — `/about-us` → "About Us" — which is a
 * guess that only works for English sites with readable slugs, and fails in
 * three ways that all ship silently:
 *
 * - **Non-English words get an English convention.** `/ueber-uns` became
 *   "Ueber Uns"; German capitalises nouns, not every word, and the umlaut is
 *   gone. Spanish, French and Portuguese take sentence case, not title case.
 * - **Non-Latin scripts were never touched at all.** The old
 *   `replace(/\b\w/g, …)` has no `u` flag, and `\w` is ASCII-only, so a
 *   Chinese, Greek, Cyrillic or Arabic slug passed through unchanged while the
 *   code claimed to have formatted it. A percent-encoded one — which is what a
 *   sitemap usually carries — came out as `%E5%85%B3%E4%BA%8E`.
 * - **Opaque slugs became nonsense.** `/p/8f3a2c` became "8f3a2c".
 *
 * So the label now comes from the page's own `<title>` (see
 * {@link PageMeta}), and this runs only when there is none. It
 * percent-decodes, opens up hyphens, and **stops there**: it does not change
 * anyone's capitalisation. An honest raw slug is better than a confident wrong
 * title, and it is visibly a fallback, which is the point — the visitor can see
 * which lines came from their site and which did not.
 */
function labelFromUrl(url: string): string {
  try {
    const { pathname } = new URL(url);
    const segments = pathname.split("/").filter(Boolean);
    const last = segments[segments.length - 1] ?? "";
    if (!last) return "Home";
    // Percent-decoded, hyphens opened up, and **deliberately not title-cased** —
    // see the note above this function. Decoding can throw on a malformed escape.
    let decoded = last;
    try {
      decoded = decodeURIComponent(last);
    } catch {
      /* keep the raw segment */
    }
    return decoded.replace(/[-_]+/g, " ").trim() || "Home";
  } catch {
    return "Page";
  }
}

/** URL category buckets. `legal` exists so the `## Optional` section can be
 *  built from pages the site actually has, rather than from two paths we assumed
 *  — see rule 2 on {@link buildGeneratedTemplate}. */
type UrlBucket = "blog" | "docs" | "legal" | "other";

function categorizeUrl(url: string): UrlBucket {
  try {
    const { pathname } = new URL(url);
    if (/\/(blog|articles?|posts?|news)\//i.test(pathname)) return "blog";
    if (/\/(docs?|guide|help|support|documentation)\//i.test(pathname)) return "docs";
    // Matched at any depth and without requiring a trailing slash, because these
    // are usually leaf pages: /privacy, /terms-of-service, /es/aviso-legal.
    if (/(^|\/)(privacy|terms|legal|imprint|impressum|cookies?|aviso-legal|privacidad|terminos|dsgvo)([-/]|$)/i.test(pathname))
      return "legal";
    return "other";
  } catch {
    return "other";
  }
}

/**
 * Builds a generated llms.txt from what the site already published.
 *
 * Two rules govern every line, and both are corrections to what this used to do:
 *
 * **1. Nothing here is invented.** Each entry's label is the page's own
 * `<title>` and its description is the page's own `<meta description>`. Where a
 * page had neither, the label falls back to the raw slug (see
 * {@link labelFromUrl}) and the description is **omitted** rather than filled.
 * It previously wrote `` `- [Label](url): Label page` `` for every link, so the
 * description column said the label again with the word "page" after it — filler
 * standing exactly where the spec asks for a description, and visible as filler
 * to anyone who read the file they were about to publish.
 *
 * **2. It never declares a URL nobody has seen.** The `## Optional` section was
 * hardcoded to `` `${origin}/privacy` `` and `` `${origin}/terms` `` on every
 * site, whether or not those pages exist. That is worse than filler: our own
 * audit probes declared links and reports a 404 or a redirect-to-homepage as
 * **broken**, so `seo_llms_txt --generate` handed the user a file that
 * `seo_llms_txt` would then fail them for. The section is now built from URLs
 * actually found in the sitemap, and is dropped entirely when there are none.
 *
 * @param origin      Site origin, e.g. "https://example.com"
 * @param title       Site title (falls back to hostname)
 * @param description Site description (falls back to a generic string)
 * @param pages       Pages discovered on the site, each with whatever of its own
 *                    metadata could be read. The homepage is handled separately.
 */
export function buildGeneratedTemplate(
  origin: string,
  title: string,
  description: string,
  pages: ReadonlyArray<PageMeta>
): string {
  let hostname: string;
  // Normalised once, because the two lines below disagreed about it: the
  // homepage URL stripped a trailing slash off `origin` while the filter
  // compared `parsed.origin` — which never has one — against the argument as
  // given. `buildGeneratedTemplate("https://example.com/", …)` therefore dropped
  // every page on the site and generated a file containing only the homepage.
  // The one caller passes `new URL(url).origin`, so this was latent; a
  // parameter documented as "Site origin, e.g. https://example.com" should not
  // depend on which of two spellings it arrives in.
  let base = origin;
  try {
    const parsed = new URL(origin);
    hostname = parsed.hostname;
    base = parsed.origin;
  } catch {
    hostname = origin;
  }

  const resolvedTitle = title.trim() || hostname;
  const resolvedDesc = description.trim() || `Content and resources from ${hostname}`;
  const homepageUrl = `${base}/`;

  // Categorize & deduplicate — exclude homepage itself
  const seen = new Set<string>();
  const nonHome = pages.filter((page) => {
    const u = page.url.trim();
    try {
      const parsed = new URL(u);
      if (parsed.origin !== base || parsed.pathname === "/" || u === homepageUrl) return false;
    } catch {
      return false;
    }
    if (seen.has(u)) return false;
    seen.add(u);
    return true;
  });

  const blogPages: PageMeta[] = [];
  const docsPages: PageMeta[] = [];
  const legalPages: PageMeta[] = [];
  const otherPages: PageMeta[] = [];

  for (const page of nonHome) {
    const bucket = categorizeUrl(page.url);
    if (bucket === "blog") blogPages.push(page);
    else if (bucket === "docs") docsPages.push(page);
    else if (bucket === "legal") legalPages.push(page);
    else otherPages.push(page);
  }

  // Apply per-section limits
  const blogSlice = blogPages.slice(0, 4);
  const docsSlice = docsPages.slice(0, 4);
  const legalSlice = legalPages.slice(0, 4);
  const otherSlice = otherPages.slice(0, 4); // leaves room for homepage (1 of 5)

  const lines: string[] = [];

  // Heading + description
  lines.push(`# ${resolvedTitle}`);
  lines.push(`> ${resolvedDesc}`);
  lines.push("");

  // Key Content section — always present, always starts with homepage
  const homepage: PageMeta = { url: homepageUrl, title: resolvedTitle, description: resolvedDesc };
  lines.push("## Key Content");
  lines.push("");
  for (const page of [homepage, ...otherSlice].slice(0, 5)) {
    lines.push(entryLine(page));
  }

  // Blog section — only if any blog URLs
  if (blogSlice.length > 0) {
    lines.push("");
    lines.push("## Blog");
    lines.push("");
    for (const page of blogSlice) lines.push(entryLine(page));
  }

  // Documentation section — only if any doc URLs
  if (docsSlice.length > 0) {
    lines.push("");
    lines.push("## Documentation");
    lines.push("");
    for (const page of docsSlice) lines.push(entryLine(page));
  }

  // Optional section — only for legal/secondary pages the site actually has.
  // Never fabricated; see rule 2 above.
  if (legalSlice.length > 0) {
    lines.push("");
    lines.push("## Optional");
    lines.push("");
    for (const page of legalSlice) lines.push(entryLine(page));
  }

  return lines.join("\n");
}

/**
 * One `- [label](url): description` line.
 *
 * The description is dropped when the page did not publish one. The spec allows
 * a bare `- [label](url)`, and a real omission reads better than a sentence we
 * made up — it also shows the visitor exactly which pages are missing a meta
 * description, which is a finding they can act on.
 */
function entryLine(page: PageMeta): string {
  const label = page.title?.trim() || labelFromUrl(page.url);
  const description = page.description?.trim();
  return description ? `- [${label}](${page.url}): ${description}` : `- [${label}](${page.url})`;
}

// ── /llms-full.txt presence check ────────────────────────────────────────────

/**
 * Three outcomes, not two.
 *
 * Was `catch { return false }` over `res.ok`, so a 5xx or a timeout printed
 * "/llms-full.txt not found" — the same collapse as the main read, in the
 * footnote (#344). This is informational rather than scored, which is why it is
 * a footnote and not a verdict, but "not found" is still a claim.
 */
export async function checkLlmsFullTxt(origin: string): Promise<WellKnownRead> {
  return readWellKnown(origin, "/llms-full.txt", { method: "HEAD", timeout: 5_000 });
}

// ── Static fallback template ───────────────────────────────────────────────────

export const LLMS_TXT_TEMPLATE = `# Your Site Name
> A brief description of what your site is about and who it's for.

## Key Content

- [Getting Started](https://example.com/getting-started): Overview and quick start guide
- [Documentation](https://example.com/docs): Full documentation and references
- [Blog](https://example.com/blog): Articles and updates

## Optional

- [Privacy Policy](https://example.com/privacy): Privacy policy
- [Terms of Service](https://example.com/terms): Terms of service`;

async function fetchHomepageMeta(origin: string): Promise<{ title: string; description: string }> {
  try {
    const { response: res } = await fetchAnyStatus(origin, { timeout: 8_000 });
    if (!res.ok) return { title: "", description: "" };

    // Through `extractPageMeta`, not a second inline copy of the same two
    // regexes. The copy that used to live here did not decode HTML entities, so
    // a homepage titled `Claude, ChatGPT &amp; Cursor` was written into the file
    // verbatim while every *other* line — read through the shared reader — came
    // out decoded. Two implementations, one file, disagreeing two lines apart.
    const { title = "", description = "" } = extractPageMeta(await res.text());
    return { title, description };
  } catch {
    return { title: "", description: "" };
  }
}

async function fetchSitemapUrls(origin: string, max = PAGE_META_LIMIT): Promise<string[]> {
  try {
    const urls = await parseSitemap(`${origin}/sitemap.xml`, max);
    return [
      ...new Set(
        urls
          .filter((u) => /^https?:\/\//.test(u))
          .filter((u) => !/\.(xml|json|rss|atom|png|jpg|webp|gif|svg|ico|css|js)(\?|$)/i.test(u))
          .slice(0, max)
      ),
    ];
  } catch {
    return [];
  }
}

/**
 * Everything a generated `llms.txt` needs, read from the site once.
 *
 * One reader for both places the Tool generates from — the file being absent and
 * the file scoring badly — so the two cannot drift into disagreeing about what a
 * generated file should contain.
 *
 * `urlsFound` is carried separately from `pages.length` because they answer
 * different questions: the first says whether we could enumerate the site at all,
 * the second how many of those we got to read. A caller that only had
 * `pages.length` could not tell an empty sitemap from a cap being hit.
 */
export async function readSiteForGeneration(origin: string): Promise<{
  title: string;
  description: string;
  urlsFound: number;
  pages: PageMeta[];
}> {
  const [homepageMeta, sitemapUrls] = await Promise.all([
    fetchHomepageMeta(origin),
    fetchSitemapUrls(origin),
  ]);

  // Each declared line is the page's own title and description, read from the
  // page. See `shared/page-meta` for why, and for the bounds this runs under.
  const pages = await fetchPagesMeta(sitemapUrls);

  return {
    title: homepageMeta.title,
    description: homepageMeta.description,
    urlsFound: sitemapUrls.length,
    pages,
  };
}

