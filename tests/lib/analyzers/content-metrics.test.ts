/**
 * Two metrics that reported numbers nobody could act on:
 *
 * - `seo_content_analysis` always said "Paragraph count: 1". `analyzeText`
 *   detects paragraphs by looking for blank lines, and the text handed to it has
 *   already had its whitespace collapsed, so there were never any to find.
 * - `seo_eeat_score`'s "Detailed technical content" check counted tokens of raw
 *   HTML, tags included, against a 1,500-word threshold. A page carrying inline
 *   data scored 49,410, so the check passed unconditionally and its 3 points
 *   were free.
 */
import { describe, it, expect, afterEach } from "vitest";

import { analyzeContent } from "@/lib/analyzers/content-analyzer";
import { eeatOf } from "../../helpers/eeat";
import { serveHtml, restoreFetch } from "../../helpers/serve-html";

// `fetchHtml` keeps a 60s module-level cache keyed by URL, so each test serves
// its fixture from its own URL rather than reading the previous one's body.
const url = (name: string) => `https://example.com/${name}`;

/** A thin page carrying `copy` as its content, plus a script far larger than it. */
function page(copy: string): string {
  return `<!DOCTYPE html>
<html lang="en">
  <head>
    <title>An article with three paragraphs</title>
    <meta name="description" content="Long enough a description to keep the audit focused on the metrics." />
  </head>
  <body>
    <main><h1>Heading</h1>${copy}</main>
    <script>window.__STATE__ = "${"payload ".repeat(3000)}";</script>
  </body>
</html>`;
}

const ARTICLE = page(
  "<p>First paragraph.</p><p>Second paragraph.</p><p>Third paragraph.</p>"
);

afterEach(restoreFetch);

describe("analyzeContent paragraph count", () => {
  it("counts the paragraphs on the page, not always one", async () => {
    const target = url("three-paragraphs");
    serveHtml({ [target]: ARTICLE });

    const result = await analyzeContent(target);
    expect(result.success).toBe(true);
    if (!result.success) return;

    expect(result.data.paragraphCount).toBe(3);
  });

  it("reports one paragraph for a page whose copy sits outside any <p>", async () => {
    const target = url("loose-copy");
    serveHtml({ [target]: page("<div>Loose copy.</div>") });

    const result = await analyzeContent(target);
    expect(result.success).toBe(true);
    if (!result.success) return;

    expect(result.data.paragraphCount).toBe(1);
  });
});

describe("scoreEeat detailed-content check", () => {
  it("measures the page's words, not its HTML tokens", async () => {
    // No `serveHtml`: `scoreEeat` is pure, so this case reads its fixture directly.
    // The `analyzeContent` cases above still stub the network, because that
    // analyzer still fetches.
    const target = url("eeat-thin");

    const result = eeatOf(target, ARTICLE);

    const indicator = result.data.signals.expertise.indicators.find(
      (i) => i.signal === "Detailed technical content"
    );
    expect(indicator).toBeDefined();
    if (!indicator) return;

    // Seven real words of copy across the heading and three paragraphs, against a
    // script payload of 3,000 tokens. Counting raw HTML cleared both the 1,500
    // (points) and 1,000 (found) thresholds on a page this thin.
    //
    // `earned`, not `points`: this indicator is worth 6 whatever the page does,
    // and what a thin page gets from it is zero.
    expect(indicator.earned).toBe(0);
    expect(indicator.found).toBe(false);

    // The detail leads with the count now — "12 words. No code samples or
    // captioned figures" — instead of dumping `Word count: 12, Code: false`.
    const reported = Number((indicator.details ?? "").match(/^([\d,]+) words?\b/)?.[1]?.replace(/,/g, ""));
    expect(reported).toBeLessThan(20);
  });
});
