/**
 * The gate on whether Google can index a page at all.
 *
 * `docs/google-search-central-conformance.md` §2.5 records this:
 * the HTTP status was only ever a scoring input, worth 3 points inside the GEO
 * technical category, sitting among thirty-odd checks about blockquotes and
 * sameAs. A page that answers 500 and a page missing a summary section came back
 * looking like two findings of comparable weight, when one of them means the page
 * cannot appear in Search at all and the other is a matter of taste.
 *
 * > "As long as your page meets the minimum technical requirements, it's eligible
 * > to be indexed by Google Search:"
 * > https://developers.google.com/search/docs/essentials/technical
 *
 * Two of the three checks are those requirements. The third, `noindex`, is not one
 * of them — Google's third requirement is "the page has indexable content", which
 * it defines as a supported file type plus no spam-policy violation. An earlier
 * draft of this file quoted a sentence stitched from a heading and a nearby
 * paragraph, which is why the quote above is now one unedited sentence.
 */
import { describe, it, expect } from "vitest";
import { readPage } from "@/lib/analyzers/parsed-page";

import { checkTechnicalRequirements } from "@/lib/analyzers/technical-requirements";

const OK_HTML = "<html><head><title>t</title></head><body><h1>Hi</h1><p>Real copy here.</p></body></html>";

describe("a page that meets all three", () => {
  it("passes, and names each requirement it checked", () => {
    const verdict = checkTechnicalRequirements({
      httpStatus: 200,
      robotsTxt: "User-agent: *\nAllow: /",
      page: readPage("https://example.com/", OK_HTML),
      url: "https://example.com/page",
    });

    expect(verdict.met).toBe(true);
    expect(verdict.blocker).toBeUndefined();
    expect(verdict.requirements.map((r) => r.id).sort()).toEqual([
      "googlebot-allowed",
      "http-200",
      "not-excluded",
    ]);
    expect(verdict.requirements.every((r) => r.met)).toBe(true);
  });
});

describe("Googlebot is blocked", () => {
  it("fails, whatever else the page gets right", () => {
    const verdict = checkTechnicalRequirements({
      httpStatus: 200,
      robotsTxt: "User-agent: Googlebot\nDisallow: /",
      page: readPage("https://example.com/", OK_HTML),
      url: "https://example.com/page",
    });

    expect(verdict.met).toBe(false);
    expect(verdict.requirements.find((r) => r.id === "googlebot-allowed")?.met).toBe(false);
  });

  it("reads a wildcard block as blocking Googlebot too", () => {
    const verdict = checkTechnicalRequirements({
      httpStatus: 200,
      robotsTxt: "User-agent: *\nDisallow: /",
      page: readPage("https://example.com/", OK_HTML),
      url: "https://example.com/page",
    });

    expect(verdict.requirements.find((r) => r.id === "googlebot-allowed")?.met).toBe(false);
  });

  it("does not treat a block on some other crawler as blocking Googlebot", () => {
    // A site that shuts out GPTBot has made a decision about AI training. It has
    // not made itself invisible to Search, and saying so would be alarming and
    // wrong.
    const verdict = checkTechnicalRequirements({
      httpStatus: 200,
      robotsTxt: "User-agent: GPTBot\nDisallow: /",
      page: readPage("https://example.com/", OK_HTML),
      url: "https://example.com/page",
    });

    expect(verdict.met).toBe(true);
  });

  it("does not treat a partial disallow as blocking the whole site", () => {
    const verdict = checkTechnicalRequirements({
      httpStatus: 200,
      robotsTxt: "User-agent: *\nDisallow: /admin/",
      page: readPage("https://example.com/", OK_HTML),
      url: "https://example.com/page",
    });

    expect(verdict.met).toBe(true);
  });

  it("fails when the disallow covers this URL specifically", () => {
    const verdict = checkTechnicalRequirements({
      httpStatus: 200,
      robotsTxt: "User-agent: *\nDisallow: /admin/",
      page: readPage("https://example.com/", OK_HTML),
      url: "https://example.com/admin/dashboard",
    });

    expect(verdict.requirements.find((r) => r.id === "googlebot-allowed")?.met).toBe(false);
  });
});

describe("the page does not answer 200", () => {
  it.each([404, 403, 500, 301, 0])("fails on HTTP %i", (status) => {
    const verdict = checkTechnicalRequirements({
      httpStatus: status,
      robotsTxt: "",
      page: readPage("https://example.com/", OK_HTML),
      url: "https://example.com/page",
    });

    expect(verdict.met).toBe(false);
    const http = verdict.requirements.find((r) => r.id === "http-200");
    expect(http?.met).toBe(false);
    // The status travels with the finding: "it does not work" is not actionable,
    // and the explanation is the one `describeHttpStatus` already writes. The `0`
    // case has no status to name, so it asserts the sentence instead of a number —
    // `toContain("")` passed on anything at all.
    if (status === 0) expect(http?.detail).toMatch(/never completed/i);
    else expect(http?.detail).toContain(String(status));
  });
});

describe("a directive removes the page from the index", () => {
  it("fails on a noindex meta tag", () => {
    const verdict = checkTechnicalRequirements({
      httpStatus: 200,
      robotsTxt: "",
      page: readPage("https://example.com/", '<html><head><meta name="robots" content="noindex"></head><body><h1>Hi</h1></body></html>'),
      url: "https://example.com/page",
    });

    expect(verdict.met).toBe(false);
    expect(verdict.requirements.find((r) => r.id === "not-excluded")?.met).toBe(false);
  });

  it("fails on a noindex X-Robots-Tag header", () => {
    const verdict = checkTechnicalRequirements({
      httpStatus: 200,
      robotsTxt: "",
      page: readPage("https://example.com/", OK_HTML),
      url: "https://example.com/page",
      responseHeaders: { "x-robots-tag": "noindex, nofollow" },
    });

    expect(verdict.requirements.find((r) => r.id === "not-excluded")?.met).toBe(false);
  });

  it("reads a googlebot-targeted noindex as a noindex", () => {
    const verdict = checkTechnicalRequirements({
      httpStatus: 200,
      robotsTxt: "",
      page: readPage("https://example.com/", '<html><head><meta name="googlebot" content="noindex"></head><body>x</body></html>'),
      url: "https://example.com/page",
    });

    expect(verdict.requirements.find((r) => r.id === "not-excluded")?.met).toBe(false);
  });

  it("fails on `none`, which Google defines as noindex plus nofollow", () => {
    // Missing this made the gate worse than no gate: it answered confidently that
    // a page Google will never show was fine.
    const verdict = checkTechnicalRequirements({
      httpStatus: 200,
      robotsTxt: "",
      page: readPage("https://example.com/", '<html><head><meta name="robots" content="none"></head><body>x</body></html>'),
      url: "https://example.com/page",
    });

    expect(verdict.requirements.find((r) => r.id === "not-excluded")?.met).toBe(false);
  });

  it("does not depend on attribute order", () => {
    // The regex this replaced required `name` before `content`, so this markup —
    // valid, and not rare — cleared the gate.
    const verdict = checkTechnicalRequirements({
      httpStatus: 200,
      robotsTxt: "",
      page: readPage("https://example.com/", '<html><head><meta content="noindex" name="robots"></head><body>x</body></html>'),
      url: "https://example.com/page",
    });

    expect(verdict.requirements.find((r) => r.id === "not-excluded")?.met).toBe(false);
  });

  it("reads past the first robots tag, which Google allows sites to split", () => {
    // Google honours rules combined "by using multiple `meta` tags". The old
    // single-match regex stopped at the nofollow and never saw the noindex.
    const verdict = checkTechnicalRequirements({
      httpStatus: 200,
      robotsTxt: "",
      page: readPage(
        "https://example.com/",
        '<html><head><meta name="robots" content="nofollow">' +
        '<meta name="robots" content="noindex"></head><body>x</body></html>',
      ),
      url: "https://example.com/page",
    });

    expect(verdict.requirements.find((r) => r.id === "not-excluded")?.met).toBe(false);
  });

  it("does not mistake nofollow or nosnippet for noindex", () => {
    // Both restrict what Google does with the page. Neither keeps it out of the
    // index, so neither belongs in a gate about whether the page can appear.
    const verdict = checkTechnicalRequirements({
      httpStatus: 200,
      robotsTxt: "",
      page: readPage("https://example.com/", '<html><head><meta name="robots" content="nofollow, nosnippet"></head><body>x</body></html>'),
      url: "https://example.com/page",
    });

    expect(verdict.met).toBe(true);
  });
});

describe("the blocker sentence", () => {
  it("leads with the requirement that failed, and says the rest is moot", () => {
    const verdict = checkTechnicalRequirements({
      httpStatus: 500,
      robotsTxt: "",
      page: readPage("https://example.com/", OK_HTML),
      url: "https://example.com/page",
    });

    expect(verdict.blocker).toBeDefined();
    expect(verdict.blocker).toMatch(/whether Google can index it/i);
    expect(verdict.blocker).toContain("500");
  });

  it("counts every failure, so fixing one does not look like fixing all", () => {
    const verdict = checkTechnicalRequirements({
      httpStatus: 404,
      robotsTxt: "User-agent: *\nDisallow: /",
      page: readPage("https://example.com/", '<html><head><meta name="robots" content="noindex"></head><body>x</body></html>'),
      url: "https://example.com/page",
    });

    expect(verdict.requirements.filter((r) => !r.met)).toHaveLength(3);
    expect(verdict.blocker).toMatch(/fails 3 of the 3 checks/);
  });
});
