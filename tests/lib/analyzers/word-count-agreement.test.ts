/**
 * `seo_analyze_page` and `seo_content_analysis` reported wildly different word
 * counts for the same URL — 46,434 against 1,932 on /es/mcp — because
 * `onpage-seo` read `$("body").text()`, and the text content of a `<script>` is
 * a text node (issue #291). Both now read through one extraction helper, so the
 * two tools cannot disagree.
 *
 * There was a **third** count, and this test could not reach it: `geo-analyzer`
 * derived its own with a body regex, so its scorers took `html: string` and never
 * saw a document. Seven such derivations existed across the codebase, two of them
 * disagreeing about the very same check. They are all `readableDocument` now, and
 * the third count is asserted below with the other two.
 */
import { describe, it, expect, afterEach } from "vitest";

import { analyzeOnPageSeo } from "@/lib/analyzers/onpage-seo";
import { analyzeContent } from "@/lib/analyzers/content-analyzer";
import { scoreContentStructure, scoreTechnical } from "@/lib/analyzers/geo-analyzer";
import { readPage } from "@/lib/analyzers/parsed-page";
import { scoreL4 } from "@/lib/analyzers/ai-visibility-analyzer";
import { serveHtml, restoreFetch } from "../../helpers/serve-html";

// `fetchHtml` keeps a 60s module-level cache keyed by URL, so each test serves
// its fixture from its own URL and cannot read the previous one's body.
const url = (name: string) => `https://example.com/${name}`;

/** 40 words of real copy, next to inline data far larger than the page itself. */
const COPY = Array.from({ length: 40 }, (_, i) => `word${i}`).join(" ");
const INLINE_STATE = `window.__STATE__ = "${"payload ".repeat(2000)}";`;

const HYDRATED_PAGE = `<!DOCTYPE html>
<html lang="en">
  <head>
    <title>A page that hydrates itself</title>
    <meta name="description" content="Enough of a description to keep the audit focused on the word count." />
    <script type="application/ld+json">{"@type":"WebPage","name":"${"noise ".repeat(200)}"}</script>
  </head>
  <body>
    <nav>Home Pricing Docs</nav>
    <main>
      <h1>Heading words here</h1>
      <p>${COPY}</p>
      <script>window.analytics = "${"tracking ".repeat(300)}";</script>
    </main>
    <footer>Footer boilerplate</footer>
    <script>${INLINE_STATE}</script>
  </body>
</html>`;

afterEach(restoreFetch);

/** GEO reports its word count in a check detail rather than as a field. */
function geoWordCount(html: string): number {
  const category = scoreContentStructure(readPage(url("geo"), html), "article");
  const check = category.checks.find((c) => /word count/i.test(c.label));
  const match = check?.detail?.match(/(\d[\d,]*)/);
  if (!match) throw new Error(`no word count in ${check?.detail ?? "(no check)"}`);
  return Number(match[1].replace(/,/g, ""));
}

describe("word count across the three page analyzers", () => {
  it("agrees on a page whose scripts outweigh its copy", async () => {
    const target = url("agreement");
    serveHtml({ [target]: HYDRATED_PAGE });

    const onPage = await analyzeOnPageSeo(target);
    const content = await analyzeContent(target);
    expect(content.success).toBe(true);
    if (!content.success) return;

    expect(onPage.content.wordCount).toBe(content.data.wordCount);
  });

  it("agrees with GEO, which used to be unreachable from here", async () => {
    // The third count. `geo-analyzer` read the whole body with its own regex, so
    // it saw the script payload the other two were fixed to exclude — and its
    // scorers took `html: string`, so this test had nothing to call.
    const target = url("agreement-geo");
    serveHtml({ [target]: HYDRATED_PAGE });

    const content = await analyzeContent(target);
    expect(content.success).toBe(true);
    if (!content.success) return;

    expect(geoWordCount(HYDRATED_PAGE)).toBe(content.data.wordCount);
  });

  it("counts the copy in GEO too, not the script payload", () => {
    expect(geoWordCount(HYDRATED_PAGE)).toBe(43);
  });

  it("counts the copy, not the script payload", async () => {
    const target = url("copy-not-payload");
    serveHtml({ [target]: HYDRATED_PAGE });

    const onPage = await analyzeOnPageSeo(target);

    // "Heading words here" (3) + 40 words of copy. The scripts add roughly
    // 2,500 tokens, so anything above this range means they leaked back in.
    expect(onPage.content.wordCount).toBe(43);
  });

  /**
   * This used to assert that a 43-word page raised "Low word count". It does not
   * any more, and the check that produced it is gone: Google states that "the
   * length of the content alone doesn't matter for ranking purposes", so a floor
   * of 300 words was our invention reported as Google's rule.
   *
   * The measurement it was really guarding — that the count reflects the copy
   * rather than an inlined script payload — is pinned above, and pinned harder,
   * on the exact figure.
   */
  it("raises no finding about how long the page is", async () => {
    const target = url("short-page-no-verdict");
    serveHtml({ [target]: HYDRATED_PAGE });

    const onPage = await analyzeOnPageSeo(target);

    expect(onPage.content.wordCount).toBe(43);
    expect(onPage.issues.some((issue) => /word count/i.test(issue))).toBe(false);
  });
});

/**
 * The two copies of one check, which measured the same page differently.
 *
 * `geo-analyzer`'s `scoreTechnical` and `ai-visibility-analyzer`'s L4 ask the
 * same question — is there core content in the static HTML? — against the same
 * 300-character threshold. Each derived the text itself, and they did not agree
 * on how: one joined tags with `""` and the other with `" "`, so a page of short
 * elements lost every word boundary in one of them and kept them in the other.
 * Both read `readable.allText()` now.
 */
describe("the static-content check", () => {
  /** The character count each of the two checks reports for the same page. */
  function reported(html: string): { geo: number; aiVisibility: number } {
    const doc = readPage(url("static-content"), html);

    const geoCheck = scoreTechnical(doc, 200).checks.find((c) =>
      /static HTML/i.test(c.label),
    );
    const l4Check = scoreL4(doc, { status: "ok", blocked: [] }, "unknown", "article").checks.find((c) =>
      /static HTML/i.test(c.name),
    );

    const read = (detail?: string) => {
      const match = detail?.match(/(\d[\d,]*)\s*chars/);
      if (!match) throw new Error(`no character count in ${detail ?? "(no check)"}`);
      return Number(match[1].replace(/,/g, ""));
    };
    return { geo: read(geoCheck?.detail), aiVisibility: read(l4Check?.detail) };
  }

  it("measures the same page the same way on both surfaces", () => {
    const counts = reported(HYDRATED_PAGE);

    expect(counts.geo).toBe(counts.aiVisibility);
  });

  it("agrees on a page of short elements, which is where they diverged", () => {
    // `""` between tags welds `<li>a</li><li>b</li>` into `ab`; `" "` keeps them
    // apart. The character counts differ by exactly the boundaries.
    const SHORT = `<!DOCTYPE html><html lang="en"><body><ul>${
      Array.from({ length: 60 }, (_, i) => `<li>item${i}</li>`).join("")
    }</ul></body></html>`;

    const counts = reported(SHORT);

    expect(counts.geo).toBe(counts.aiVisibility);
  });
});
