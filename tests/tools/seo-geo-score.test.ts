import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import seoGeoScore from "@/tools/seo-geo-score";
import { serve, type Route } from "../helpers/serve";
import { resetAllSingleFlightCaches } from "@/lib/single-flight";

const originalFetch = globalThis.fetch;

beforeEach(() => {
  // Both fetchers share one request per URL per window, which real callers want
  // and a test never does: a case would be served the previous case's page.
  resetAllSingleFlightCaches();
  // Unset so no case reaches the real Knowledge Graph API.
  delete process.env.GOOGLE_KG_API_KEY;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  resetAllSingleFlightCaches();
  vi.restoreAllMocks();
});

const PAGE = "https://example.com/article/seo-tips";

/** The page under test, plus the well-known files every run reads beside it. */
function servePage(html: string, extra: Record<string, Route> = {}): void {
  serve({
    ...extra,
    [PAGE]: { body: html },
    "robots.txt": { body: "" },
    "sitemap.xml": { body: "" },
    "llms.txt": { status: 404, body: "" },
    "kgsearch.googleapis.com": { status: 404, body: "" },
  });
}

const scoreOf = async (url = PAGE): Promise<string> => {
  const result = await seoGeoScore({ url });
  return result.content.map((part) => part.text).join("\n");
};

/** The rendered line for a check, plus its detail line when it has one. */
function checkLine(text: string, needle: string): { mark: string; verdict: string; detail: string } {
  const lines = text.split("\n");
  const at = lines.findIndex((line) => /^ {2}[✓✗~–?] /.test(line) && line.includes(needle));
  if (at === -1) throw new Error(`no check matching ${needle}`);
  const line = lines[at].trim();
  const next = lines[at + 1] ?? "";
  return {
    mark: line[0],
    verdict: line.slice(line.lastIndexOf("(") + 1, line.lastIndexOf(")")),
    detail: next.startsWith("     ") ? next.trim() : "",
  };
}

describe("seo_geo_score", () => {
  it("credits a page that attributes its figures", async () => {
    servePage(`<body><p>According to recent data, SEO improved by 45% year over year.</p></body>`);

    const text = await scoreOf();

    expect(text).toMatch(/CITATION SIGNALS: [1-9]/);
  });

  it("scores no citation signals on a page that carries none", async () => {
    servePage(`<body><p>This is just a plain paragraph with no stats or attributions.</p></body>`);

    const text = await scoreOf();

    expect(text).toMatch(/CITATION SIGNALS: 0 \//);
  });

  it("recognises an ordered list of three as listicle formatting", async () => {
    servePage(`<body><h1>Tools</h1><ol><li>One</li><li>Two</li><li>Three</li></ol></body>`);

    expect(checkLine(await scoreOf(), "isticle").mark).toBe("✓");
  });

  it("reads a last-modified header as a freshness signal", async () => {
    serve({
      [PAGE]: {
        body: `<body><h1>Post</h1><p>Copy.</p></body>`,
        headers: { "last-modified": "Mon, 03 Aug 2026 10:00:00 GMT" },
      },
      "robots.txt": { body: "" },
      "sitemap.xml": { body: "" },
      "llms.txt": { status: 404, body: "" },
    });

    expect(checkLine(await scoreOf(), "Last-Modified").mark).toBe("✓");
  });

  it("says the score is directional before printing it", async () => {
    servePage(`<body><h1>Post</h1><p>Copy.</p></body>`);

    const text = await scoreOf();

    expect(text).toMatch(/^Note: GEO/);
    expect(text).toContain("=== GEO SCORE ===");
    expect(text).toMatch(/Score: \d+ \/ 100/);
  });

  it("runs no checks at all on a URL that cannot be read", async () => {
    // Scoring a 404 produced a full report about an error page: 24 findings, 23
    // of them consequences of there being no page.
    serve({ "example.com": { status: 404, body: "Not Found" } });

    const result = await seoGeoScore({ url: PAGE });
    const text = result.content.map((part) => part.text).join("\n");

    expect(result.isError).toBe(true);
    expect(text).toContain("Not scored: the page could not be read.");
    expect(text).toContain("There is no page here to audit");
    expect(text).not.toContain("CATEGORY BREAKDOWN");
  });
});

/**
 * The gate reaches the reader before the score.
 *
 * The HTTP status only ever weighed 3 points inside the technical category, so a
 * page Google cannot index came back graded like any other, with the reason
 * somewhere below thirty checks about blockquotes. The score still runs — the
 * analysis is premature, not wrong — but the order it is delivered in is the
 * whole finding.
 */
describe("seo_geo_score — the indexability gate", () => {
  const CLEAN = "<html><head><title>t</title></head><body><h1>Hi</h1><p>Copy.</p></body></html>";

  const serveGate = (url: string, html: string, robotsTxt = ""): void => {
    serve({
      [url]: { body: html },
      "robots.txt": { body: robotsTxt },
      "sitemap.xml": { body: "" },
      "llms.txt": { status: 404, body: "" },
    });
  };

  it("says nothing extra when the page clears all three", async () => {
    serveGate("https://example.com/ok", CLEAN);

    expect(await scoreOf("https://example.com/ok")).not.toContain("BEFORE ANYTHING ELSE");
  });

  it("leads with the blocker when a directive keeps the page out of the index", async () => {
    serveGate(
      "https://example.com/hidden",
      '<html><head><title>t</title><meta name="robots" content="noindex"></head><body><h1>Hi</h1></body></html>',
    );

    const text = await scoreOf("https://example.com/hidden");

    // Before the score, not merely present: a reader stops reading.
    expect(text).toContain("BEFORE ANYTHING ELSE");
    expect(text.indexOf("BEFORE ANYTHING ELSE")).toBeLessThan(text.indexOf("=== GEO SCORE ==="));
    expect(text).toMatch(/fails 1 of the 3 checks that decide whether Google can index it/);
  });

  it("raises the gate when robots.txt shuts Googlebot out", async () => {
    // Googlebot by name, not `User-agent: *`. A blanket disallow shuts *us* out
    // too, and then the Reachability Gate refuses before there is a page to
    // score — see the test below. What this one is about is a site that lets us
    // read it and keeps Google out, which is the case the gate exists for.
    serveGate("https://example.com/blocked", CLEAN, "User-agent: Googlebot\nDisallow: /");

    expect(await scoreOf("https://example.com/blocked")).toContain("BEFORE ANYTHING ELSE");
  });

  it("declines to read a page at all when robots.txt shuts us out", async () => {
    // The Reachability Gate honours robots.txt now, so a blanket disallow is a
    // refusal rather than a report. It has to arrive AS a refusal: flattening it
    // into "could not be reached" is what `RobotsDisallowedError` exists to
    // prevent, because it sends an Operator debugging their server over a rule
    // they wrote themselves.
    serveGate("https://example.com/none", CLEAN, "User-agent: *\nDisallow: /");

    const result = await seoGeoScore({ url: "https://example.com/none" });
    const text = result.content.map((part) => part.text).join("\n");

    expect(result.isError).toBe(true);
    expect(text).toContain("robots.txt disallows");
    expect(text).not.toContain("could not be reached");
    expect(text).not.toContain("CATEGORY BREAKDOWN");
  });

  it("does not raise the gate because an AI crawler is blocked", async () => {
    // Shutting out GPTBot is a decision about AI training, not a Search problem.
    // The GEO category still reports it; the gate must not.
    serveGate("https://example.com/gptbot", CLEAN, "User-agent: GPTBot\nDisallow: /");

    expect(await scoreOf("https://example.com/gptbot")).not.toContain("BEFORE ANYTHING ELSE");
  });
});

/**
 * A sitemap index whose children did not load.
 *
 * `fetchSitemapContaining` follows a `<sitemapindex>` into its children, and it
 * used to put every child through `textOrEmpty` without checking `answered()`
 * first — the one thing `well-known.ts` says never to do, because `unavailable`
 * yields `""` too. The failed reads were dropped by a `.filter(Boolean)` and the
 * whole thing stamped `found`, so the site was told "Page is not listed in the
 * sitemap" and docked 5 points over sitemaps nobody opened.
 */
describe("seo_geo_score — a sitemap index whose children did not load", () => {
  const HTML = `<body><article><h1>SEO tips</h1><p>Some words about search.</p></article></body>`;

  const index = (locs: string[]) =>
    `<?xml version="1.0"?><sitemapindex>${locs
      .map((loc) => `<sitemap><loc>${loc}</loc></sitemap>`)
      .join("")}</sitemapindex>`;

  const urlset = (locs: string[]) =>
    `<?xml version="1.0"?><urlset>${locs
      .map((loc) => `<url><loc>${loc}</loc><lastmod>2026-08-01</lastmod></url>`)
      .join("")}</urlset>`;

  /** The page, plus an index, plus whatever each child sitemap should do. */
  function serveChildren(children: Record<string, Route>): void {
    serve({
      [PAGE]: { body: HTML },
      // Order no longer matters: `serve` matches the longest key rather than the
      // first, so `sitemap-1.xml` wins over `sitemap.xml` on its own URL. This
      // used to read "Children first", which was a test arranging its literals
      // around a helper's implementation detail.
      ...children,
      "sitemap.xml": {
        body: index(Object.keys(children).map((name) => `https://example.com/${name}`)),
      },
      "robots.txt": { body: "" },
      "llms.txt": { status: 404, body: "" },
    });
  }

  const sitemapCheck = (text: string) => checkLine(text, "Sitemap lastmod agrees");

  it("does not report 'not listed' when no child sitemap loaded", async () => {
    serveChildren({
      "sitemap-1.xml": { status: 503, body: "" },
      "sitemap-2.xml": { status: 503, body: "" },
    });

    const check = sitemapCheck(await scoreOf());

    expect(check.mark).toBe("?");
    expect(check.detail).not.toContain("not listed");
  });

  it("does not report 'not listed' when only some children loaded and none had the page", async () => {
    // The page could be in the one we could not open. Asserting its absence from
    // sitemaps we never read is the whole bug, at half strength.
    serveChildren({
      "sitemap-1.xml": { body: urlset(["https://example.com/other"]) },
      "sitemap-2.xml": { status: 500, body: "" },
    });

    expect(sitemapCheck(await scoreOf()).mark).toBe("?");
  });

  it("settles on a positive even when another child failed", async () => {
    // Asymmetric evidence, the same as `site-trust-pages`: finding the page is
    // conclusive, and nothing in a sitemap we did not read can unfind it.
    serveChildren({
      "sitemap-1.xml": { body: urlset([PAGE]) },
      "sitemap-2.xml": { status: 503, body: "" },
    });

    const check = sitemapCheck(await scoreOf());

    expect(check.mark).not.toBe("?");
    expect(check.detail).toBe(
      "Sitemap has lastmod for this page but the schema has no dateModified",
    );
  });

  it("still says 'not listed' when every child was read and none had the page", async () => {
    // The finding survives. A page genuinely missing from a site's sitemaps has a
    // discovery problem and should hear about it.
    serveChildren({
      "sitemap-1.xml": { body: urlset(["https://example.com/other"]) },
      "sitemap-2.xml": { body: urlset(["https://example.com/another"]) },
    });

    const check = sitemapCheck(await scoreOf());

    expect(check.mark).not.toBe("?");
    expect(check.detail).toBe("Page is not listed in the sitemap");
  });

  it("says so when the index lists more sitemaps than it searches", async () => {
    // A page living in the sixth child used to come back "not listed" with no
    // hint that the search stopped early.
    const children: Record<string, Route> = {};
    for (let i = 1; i <= 6; i++) {
      children[`sitemap-${i}.xml`] = { body: urlset([`https://example.com/p${i}`]) };
    }
    serveChildren(children);

    const check = sitemapCheck(await scoreOf());

    expect(check.mark).toBe("?");
    expect(check.detail).toContain("not all of them were searched");
  });
});
