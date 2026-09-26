import { describe, it, expect, afterEach } from "vitest";
import tool, { handler, metadata } from "@/tools/site-orphan-pages";
import { fakeGoogleReader } from "@/lib/google/fake-reader";
import type { SearchAnalyticsRow } from "@/lib/google/reader";
import { UpstreamApiError } from "@/lib/upstream-api-error";
import { resetPersistence } from "@/lib/db/runtime";
import { restoreFetch, serve, type Route } from "../helpers/serve";
import { WINDOW, expectClean, html, row, textOf } from "../helpers/site-tools";

afterEach(() => {
  restoreFetch();
  resetPersistence();
});

const ARGS = { ...WINDOW, maxPages: undefined, sitemapUrl: undefined };

const link = (href: string) => `<a href="${href}">${href}</a>`;

const SITEMAP =
  `<urlset>` +
  ["https://example.com/", "https://example.com/about", "https://example.com/hidden", "https://example.com/stale"]
    .map((loc) => `<url><loc>${loc}</loc></url>`)
    .join("") +
  `</urlset>`;

/** A four-page site: the home links to about and a noindex page; about links to contact. */
const SITE: Record<string, Route> = {
  "/robots.txt": { status: 404 },
  "https://example.com/sitemap.xml": { body: SITEMAP },
  "https://example.com/": html(`${link("/about/")}${link("/private")}`),
  "https://example.com/about/": html(link("/contact#team")),
  "https://example.com/contact": html("contact"),
  "https://example.com/private": html("private", `<meta name="robots" content="noindex">`),
};

const PAGES: SearchAnalyticsRow[] = [
  row(["https://example.com/"], 40, 100),
  row(["https://www.example.com/about"], 10, 50),
  row(["https://example.com/hidden"], 3, 30),
  row(["https://example.com/lost"], 1, 5),
  row(["https://blog.example.com/x"], 1, 10),
];

const reader = (rows: SearchAnalyticsRow[] = PAGES) =>
  fakeGoogleReader({ searchConsole: { searchAnalytics: async () => rows } });

describe("site_orphan_pages", () => {
  it("is named as a cross-source Tool and says what it needs", () => {
    expect(metadata.name).toBe("site_orphan_pages");
    expect(metadata.description).toContain("Needs the Google login");
    expect(metadata.description).toContain("at most 50 pages");
  });

  it("finds pages Google shows that no link reaches, and pages nobody was shown", async () => {
    serve(SITE);
    const text = textOf(await handler(ARGS, reader()));

    expect(text).toContain("It ran out of links to follow before the limit");
    expect(text).toContain("=== ORPHAN CANDIDATES (2) ===");
    expect(text).toContain("https://example.com/hidden — 30 impressions, 3 clicks, in the sitemap");
    expect(text).toContain("https://example.com/lost — 5 impressions, 1 clicks, not in the sitemap either");
    // Matched across www, trailing slash and scheme: about is not an orphan.
    expect(text).not.toMatch(/about — 50 impressions/);

    expect(text).toContain("=== ZOMBIE CANDIDATES (2) ===");
    expect(text).toContain("https://example.com/stale — sitemap");
    expect(text).toContain("https://example.com/contact — crawl");
    // A noindex page has no impressions because it asked not to.
    expect(text).not.toContain("https://example.com/private — crawl");

    expect(text).toContain("1 page(s) with impressions are on other hosts");
    expect(text).toContain("=== SITEMAP AGAINST CRAWL ===");
    expect(text).toContain("In both: 2");
    expect(text).toContain("Only in the sitemap: 2");
    expect(text).toContain("Only in the crawl: 2");
    expect(text).toContain("=== WHAT THIS IS BASED ON ===");
    expectClean(text);
  });

  it("says 'not reached within N pages' rather than 'orphan' when the crawl stopped short", async () => {
    serve(SITE);
    const text = textOf(await handler({ ...ARGS, maxPages: 1 }, reader()));

    expect(text).toContain("It stopped at the limit with pages still queued");
    expect(text).toContain("=== NOT REACHED WITHIN 1 PAGES (2) ===");
    expect(text).toContain("these are not orphans yet");
    expect(text).not.toContain("=== ORPHAN CANDIDATES");
    expectClean(text);
  });

  it("answers an empty window rather than failing, and does not list every URL as a zombie", async () => {
    serve(SITE);
    const text = textOf(await handler(ARGS, reader([])));

    expect(text).toContain("Search Console: 0 page(s) with impressions");
    expect(text).toContain("Search Console reported no pages at all for this window");
    expect(text).not.toContain("https://example.com/stale — sitemap");
    expectClean(text);
  });

  it("reports a site robots.txt closes to us as not checked, never as orphans", async () => {
    serve({ ...SITE, "/robots.txt": { body: "User-agent: *\nDisallow: /" } });
    const text = textOf(await handler(ARGS, reader()));

    expect(text).toMatch(/=== NOT CHECKED \(2\) ===\n {2}Crawl — /);
    expect(text).toContain("robots.txt disallows");
    expect(text).toContain("Not checked: there was no crawl to compare");
    expect(text).toContain("Not checked: neither a sitemap nor a crawl was read");
    expect(text).not.toContain("https://example.com/lost — 5 impressions");
    expectClean(text);
  });

  it("reports an unreachable site as not checked", async () => {
    serve({ ...SITE, "https://example.com/": { status: 503 } });
    const text = textOf(await handler(ARGS, reader()));

    expect(text).toContain("  Crawl — https://example.com/ could not be read");
    expect(text).toContain("Not checked: there was no crawl to compare");
    expectClean(text);
  });

  it("lets Google's refusal reject rather than answering from the site alone", async () => {
    serve(SITE);
    const refusing = fakeGoogleReader({
      searchConsole: {
        searchAnalytics: async () => {
          throw new UpstreamApiError("Search Console", 403);
        },
      },
    });
    await expect(handler(ARGS, refusing)).rejects.toBeInstanceOf(UpstreamApiError);
  });

  it("answers with the login it needs rather than throwing, when there is none", async () => {
    // No login is configured in the suite, so the live reader refuses with a sentence.
    const result = await tool({ ...ARGS });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("the Google login is not set");
  });
});
