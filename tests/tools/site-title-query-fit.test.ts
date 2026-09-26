import { describe, it, expect, afterEach } from "vitest";
import { handler, metadata } from "@/tools/site-title-query-fit";
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

const ARGS = { ...WINDOW, pages: undefined };

const SITE: Record<string, Route> = {
  "/robots.txt": { body: "User-agent: *\nDisallow: /blocked" },
  "https://example.com/tools": html("<h1>Audit your site</h1>", "<title>SEO Tools for Site Audits</title>"),
  "https://example.com/web": html("<h1>Bienvenidos</h1>", "<title>Bienvenidos</title>", "es-ES"),
  "https://example.com/es/diseno": html("<h1>Diseño</h1>", "<title>Diseño web en Barcelona</title>", "es"),
  "https://example.com/de": html("<h1>Werkzeuge</h1>", "<title>SEO Werkzeuge</title>", "de"),
  "https://example.com/blocked": html("", "<title>Blocked</title>"),
};

const ROWS: SearchAnalyticsRow[] = [
  row(["https://example.com/tools", "seo audit tool"], 90, 3000, 3.1),
  row(["https://example.com/tools", "free seo checker"], 2, 400, 6.0),
  row(["https://example.com/web", "diseño web barcelona"], 1, 900, 7.2),
  row(["https://example.com/web", "agencia de diseño"], 1, 100, 9.0),
  row(["https://example.com/es/diseno", "diseno web"], 30, 600, 4.0),
  row(["https://example.com/de", "seo werkzeuge"], 20, 300, 5.0),
  row(["https://example.com/blocked", "blocked page"], 10, 200, 3.0),
];

const reader = (rows: SearchAnalyticsRow[] = ROWS) =>
  fakeGoogleReader({ searchConsole: { searchAnalytics: async () => rows } });

describe("site_title_query_fit", () => {
  it("is named as a cross-source Tool and says what it needs", () => {
    expect(metadata.name).toBe("site_title_query_fit");
    expect(metadata.description).toContain("Needs the Google login");
  });

  it("compares each page's title and H1 with its queries, word by word", async () => {
    serve(SITE);
    const text = textOf(await handler(ARGS, reader()));

    expect(text).toContain(`Title: "SEO Tools for Site Audits"`);
    expect(text).toContain(`"seo audit tool" — 3000 impressions, CTR 3.0%, position 3.1`);
    expect(text).toContain("Title: carries every word; H1: missing seo, tool");
    // Accents folded both ways: the query typed without the tilde is carried.
    expect(text).toMatch(/"diseno web" — 600 impressions[^\n]*\n\s+Title: carries every word/);
    expectClean(text);
  });

  it("flags a title that carries none of its top queries, and an under-clicked query it misses", async () => {
    serve(SITE);
    const text = textOf(await handler(ARGS, reader()));

    const top = text.split("=== TITLE CARRIES NONE OF ITS TOP 3 QUERIES")[1].split("===")[1];
    expect(top).toContain("https://example.com/web");
    expect(top).not.toContain("https://example.com/tools");

    const underclicked = text.split("=== SEEN OFTEN, CLICKED RARELY")[1];
    expect(underclicked).toContain(`https://example.com/web — "diseño web barcelona", 900 impressions`);
    expect(underclicked).toContain("title missing diseno, web, barcelona");
    // Carried in full, so not flagged however low its CTR.
    expect(underclicked).not.toContain(`"seo audit tool"`);
    expect(underclicked).toContain("Our thresholds, shared with gsc_detect_quick_wins");
  });

  it("says a language it cannot read is unsupported rather than guessing", async () => {
    serve(SITE);
    const text = textOf(await handler(ARGS, reader()));

    expect(text).toContain("the page declares German (de)");
    expect(text).toContain("English and Spanish");
  });

  it("reports a page robots.txt closes to us as not checked", async () => {
    serve(SITE);
    const text = textOf(await handler(ARGS, reader()));

    expect(text).toMatch(/https:\/\/example.com\/blocked[^\n]*\n\s+Not checked — the reason is under NOT CHECKED below\./);
    expect(text).toContain("robots.txt disallows");
    expect(text).toContain("=== NOT CHECKED (2) ===\nThese are counted in neither list above.");
    expect(text).toContain("  https://example.com/blocked — robots.txt disallows");
  });

  it("reports an unreachable page as not checked", async () => {
    serve({ ...SITE, "https://example.com/tools": { status: 500 } });
    const text = textOf(await handler(ARGS, reader()));

    expect(text).toMatch(/https:\/\/example.com\/tools[^\n]*\n\s+Not checked — the reason is under NOT CHECKED below\./);
    expect(text).toContain("The URL returned HTTP 500");
    expectClean(text);
  });

  it("answers an empty window rather than failing, and reads no page", async () => {
    const mock = serve(SITE);
    const text = textOf(await handler(ARGS, reader([])));

    expect(text).toContain("No page and query rows in this window");
    expect(mock).not.toHaveBeenCalled();
    expectClean(text);
  });

  it("clamps the page count and says how many it left out", async () => {
    serve(SITE);
    const text = textOf(await handler({ ...ARGS, pages: 1 }, reader()));

    expect(text).toContain("Pages compared: 1 of 5 with queries, taken by impressions.");
    expect(text).toContain("... and 4 more pages with queries were not compared.");
  });

  it("compares a page Google shows often and nobody clicks, which ranking by clicks left out", async () => {
    serve({ ...SITE, "https://example.com/quiet": { body: "<html><head><title>Quiet</title></head><body><h1>Quiet</h1></body></html>" } });
    const text = textOf(await handler(ARGS, reader([...ROWS, row(["https://example.com/quiet", "quiet page"], 0, 700, 8)])));

    expect(text).toContain("Pages compared: 6 of 6 with queries, taken by impressions.");
    expect(text).toContain("https://example.com/quiet");
    expect(text).not.toContain("had no clicks in this window and were not compared");
  });

  it("lets Google's refusal reject", async () => {
    const refusing = fakeGoogleReader({
      searchConsole: {
        searchAnalytics: async () => {
          throw new UpstreamApiError("Search Console", 429);
        },
      },
    });
    await expect(handler(ARGS, refusing)).rejects.toBeInstanceOf(UpstreamApiError);
  });
});
