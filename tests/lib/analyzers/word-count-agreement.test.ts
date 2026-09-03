/**
 * `seo_analyze_page` and `seo_content_analysis` reported wildly different word
 * counts for the same URL — 46,434 against 1,932 on /es/mcp — because
 * `onpage-seo` read `$("body").text()`, and the text content of a `<script>` is
 * a text node (issue #291). Both now read through one extraction helper, so the
 * two tools cannot disagree.
 */
import { describe, it, expect, afterEach } from "vitest";

import { analyzeOnPageSeo } from "@/lib/analyzers/onpage-seo";
import { analyzeContent } from "@/lib/analyzers/content-analyzer";
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

describe("word count across the two page analyzers", () => {
  it("agrees on a page whose scripts outweigh its copy", async () => {
    const target = url("agreement");
    serveHtml({ [target]: HYDRATED_PAGE });

    const onPage = await analyzeOnPageSeo(target);
    const content = await analyzeContent(target);
    expect(content.success).toBe(true);
    if (!content.success) return;

    expect(onPage.content.wordCount).toBe(content.data.wordCount);
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
