import { describe, expect, it } from "vitest";
import { eeatOf } from "../../helpers/eeat";

/**
 * #341: checks that answered **yes** on evidence that proves nothing.
 *
 * #337's mirror image. That one charged for a question it could not answer; these
 * awarded points for an answer they had not earned — and all of them did it the same
 * way, by reading the whole document when they meant the page's own copy. Every page
 * on a site shares its chrome, so a correct breadcrumb, a footer of social icons and
 * a row of partner logos scored the same points on every page of the site.
 */

const url = (name: string) => `https://loose.example/blog/${name}`;

/**
 * A page whose copy says nothing, wearing the chrome of a well-built site: a
 * breadcrumb, social profiles, outbound partner links, a logo wall.
 */
const CHROME_RICH = `<!DOCTYPE html>
<html lang="en">
  <head><title>A thin page on a well-built site</title>
    <script type="application/ld+json">
      {"@type":"Article","headline":"A thin page","datePublished":"2026-01-04",
       "publisher":{"@type":"Organization","name":"Loose Ltd","sameAs":["https://linkedin.com/company/loose"]}}
    </script>
  </head>
  <body>
    <nav><ol><li><a href="/">Home</a></li><li><a href="/blog">Blog</a></li><li>This page</li></ol></nav>
    <main><p>Hola.</p></main>
    <footer>
      <a href="https://linkedin.com/company/loose">LinkedIn</a>
      <a href="https://twitter.com/loose">Twitter</a>
      <a href="https://github.com/loose">GitHub</a>
      <a href="https://partner-one.example">Partner one</a>
      <a href="https://partner-two.example">Partner two</a>
      <a href="https://partner-three.example">Partner three</a>
      <img src="/l1.png"><img src="/l2.png"><img src="/l3.png">
      <img src="/l4.png"><img src="/l5.png"><img src="/l6.png">
    </footer>
  </body>
</html>`;

function indicatorsOf(name: string) {
  // No `serveHtml`, and no bare home either: this file's subject is what the
  // page's own copy earns, and the home was only ever there to stop the three
  // site-level indicators going `not-evaluated` and moving the maximum.
  return eeatOf(url(name), CHROME_RICH).get;
}


describe("the chrome no longer buys points the copy has not earned", () => {
  it("does not read a breadcrumb as a worked example", async () => {
    const get = indicatorsOf("breadcrumb");
    // 3 of 7 for "the page shows worked examples", awarded to every page of any site
    // whose breadcrumb is marked up as the `<ol>` it should be.
    expect(get("Case studies / examples").earned).toBe(0);
  });

  it("does not read a site-wide social footer as the author's own footprint", async () => {
    const get = indicatorsOf("social-footer");
    expect(get("Author published elsewhere").earned).toBe(0);
  });

  it("does not read a publisher's sameAs as the author's", async () => {
    // The old check accepted a top-level `sameAs` too, which on almost every site
    // belongs to the Organization. Here the Article's publisher has one and no author
    // exists at all.
    const get = indicatorsOf("publisher-sameas");
    expect(get("Author published elsewhere").found).toBe(false);
  });

  it("does not read a footer of partner links as sourced claims", async () => {
    const get = indicatorsOf("partner-links");
    expect(get("Citations / references").earned).toBe(0);
  });

  it("does not read six logos as technical diagrams", async () => {
    const get = indicatorsOf("logo-wall");
    expect(get("Detailed technical content").earned).toBe(0);
  });

  it("does not read an Article with no author as carrying an author bio", async () => {
    const get = indicatorsOf("no-author");
    expect(get("Author bio / credentials").found).toBe(false);
  });
});
