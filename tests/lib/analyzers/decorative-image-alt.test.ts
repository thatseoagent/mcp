/**
 * `alt=""` is not a missing alt attribute.
 *
 * The analyzer treated an empty alt as absent, which reported our own navbar as an
 * accessibility defect: the brand mark there is decorative because the wordmark
 * beside it already names the brand, and the fix the finding implied — giving the
 * image alt text — would make a screen reader announce the brand twice. WCAG 2.2
 * §1.1.1 and the HTML spec both name `alt=""` as the way to mark an image
 * decorative, so it is a correct implementation, not an omission.
 */
import { describe, it, expect, afterEach } from "vitest";

import { analyzeOnPageSeo } from "@/lib/analyzers/onpage-seo";
import { serveHtml, restoreFetch } from "../../helpers/serve-html";

// analyzeOnPageSeo caches by URL, so every case serves its fixture from its own.
const url = (name: string) => `https://thatseoagent.com/en/alt-${name}`;

const page = (imgs: string) => `<!DOCTYPE html>
<html lang="en">
  <head><title>A page with images on it</title></head>
  <body>
    <h1>A page with images on it</h1>
    ${imgs}
    <p>${Array.from({ length: 120 }, () => "content").join(" ")}</p>
  </body>
</html>`;

afterEach(restoreFetch);

describe("decorative images with alt=\"\"", () => {
  it("does not report an empty alt as missing", async () => {
    const u = url("empty");
    serveHtml({ [u]: page('<img src="/mark.svg" alt="" width="26" height="26">') });

    const result = await analyzeOnPageSeo(u);

    expect(result.images.total).toBe(1);
    expect(result.images.withoutAlt).toEqual([]);
  });

  it("still reports an image with no alt attribute at all", async () => {
    const u = url("absent");
    serveHtml({ [u]: page('<img src="/chart.png">') });

    const result = await analyzeOnPageSeo(u);

    expect(result.images.withoutAlt).toEqual(["/chart.png"]);
  });

  it("reports whitespace-only alt, which is neither a description nor a marker", async () => {
    const u = url("whitespace");
    serveHtml({ [u]: page('<img src="/spacer.gif" alt="   ">') });

    const result = await analyzeOnPageSeo(u);

    expect(result.images.withoutAlt).toEqual(["/spacer.gif"]);
  });

  it("counts only the genuinely missing one on a page that mixes all three", async () => {
    const u = url("mixed");
    serveHtml({
      [u]: page(
        [
          '<img src="/decorative.svg" alt="">',
          '<img src="/described.png" alt="A bar chart of monthly clicks">',
          '<img src="/missing.jpg">',
        ].join("\n")
      ),
    });

    const result = await analyzeOnPageSeo(u);

    expect(result.images.total).toBe(3);
    expect(result.images.withoutAlt).toEqual(["/missing.jpg"]);
  });
});
