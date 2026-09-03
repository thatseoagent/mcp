import { describe, expect, it } from "vitest";
import { eeatOf } from "../../helpers/eeat";

/**
 * #337, slice 3: `eeat-analyzer` knew nothing about page type.
 *
 * `analyzeEeat` received `$`, the text and `isHttps`, so its two largest indicators —
 * author bio at 10 points and author published elsewhere at 8 — had no outcome
 * available on a page with no author but a zero. The predicates were already in the
 * repo (`page-identity.ts`) and `geo-analyzer` already gated the same signals on them;
 * this module simply never imported it.
 *
 * Google states the expectation conditionally, which is the argument: pages should
 * carry "a byline, where one might be expected". No Google page says a product,
 * category, home or legal page should carry one.
 */

// `fetchHtml` caches by URL for 60s, so every case needs its own URL.
const url = (name: string) => `https://example.com/eeat-identity-${name}`;

/** A product page: real content, no author, no publication date, and none owed. */
const PRODUCT = `<!DOCTYPE html>
<html lang="en">
  <head>
    <title>Acme Widget Pro</title>
    <script type="application/ld+json">
      {"@type":"Product","name":"Acme Widget Pro","offers":{"@type":"Offer","price":"49.00","priceCurrency":"USD"}}
    </script>
  </head>
  <body><main>
    <h1>Acme Widget Pro</h1>
    <p>The Widget Pro is machined from a single billet and ships in three finishes.</p>
  </main></body>
</html>`;

/** An article: the kind of page that does owe a byline and a date. */
const ARTICLE = `<!DOCTYPE html>
<html lang="en">
  <head>
    <title>How we migrated 40 sites</title>
    <script type="application/ld+json">
      {"@type":"Article","headline":"How we migrated 40 sites","datePublished":"2026-01-04"}
    </script>
  </head>
  <body><main>
    <h1>How we migrated 40 sites</h1>
    <p>I migrated 40 client sites last year and the results surprised me.</p>
  </main></body>
</html>`;


function indicators(name: string, html: string) {
  return eeatOf(url(name), html);
}

/**
 * What the module is worth when every indicator applies. Not 100: "Before/after
 * evidence" was retired to 0 points, because no word list shows that a page
 * documents a transformation (#341).
 */
const EEAT_MAX = 91;

describe("a page with no author is not marked down for having none", () => {
  it("excuses the author indicators on a product page", async () => {
    const { get } = indicators("product-author", PRODUCT);

    for (const signal of ["Author bio / credentials", "Professional certifications", "Author published elsewhere"]) {
      expect(get(signal).status, signal).toBe("not-applicable");
      expect(get(signal).details, signal).toMatch(/N\/A for product pages/);
    }
  });

  it("excuses the last-updated indicator on a product page", async () => {
    const { get } = indicators("product-date", PRODUCT);

    expect(get("Last updated date").status).toBe("not-applicable");
    expect(get("Last updated date").details).toMatch(/not published on a date/);
  });

  it("takes the excused points out of the maximum, not just out of the score", async () => {
    const { data } = indicators("product-max", PRODUCT);

    // 28 points of author and date signals leave both sides: author bio 10,
    // certifications 5, published-elsewhere 8, last-updated 5. Awarding them instead
    // would flatter the page; leaving them in the maximum is what docked it 28 of 100
    // for a byline and a date it was never meant to carry.
    expect(data.maxScore).toBe(EEAT_MAX - 28);
    expect(data.score).toBeLessThanOrEqual(data.maxScore);
    // And the percentage is now over what the page could actually earn.
    expect(data.percentage).toBe((data.score / data.maxScore) * 100);
  });

  it("still expects all of them on an article", async () => {
    const { get, data } = indicators("article", ARTICLE);

    for (const signal of ["Author bio / credentials", "Professional certifications", "Author published elsewhere", "Last updated date"]) {
      expect(get(signal).status, signal).toBeUndefined();
    }
    expect(data.maxScore).toBe(EEAT_MAX);
  });
});
