import { describe, it, expect, afterEach } from "vitest";
import { handler, metadata } from "@/tools/site-hreflang-country-gap";
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

const ARGS = { ...WINDOW, url: undefined };

const alternate = (lang: string, href: string) => `<link rel="alternate" hreflang="${lang}" href="${href}">`;

const HOME = html(
  "<h1>Inicio</h1>",
  alternate("es-ES", "https://example.com/") +
    alternate("en", "https://example.com/en/") +
    alternate("fr-FR", "https://example.com/fr/") +
    alternate("x-default", "https://example.com/"),
  "es-ES",
);

const SITE: Record<string, Route> = {
  "/robots.txt": { status: 404 },
  "https://example.com/": HOME,
  "https://example.com/blog/": html("<h1>Blog</h1>", alternate("de", "https://example.com/de/blog/"), "es"),
};

const ROWS: SearchAnalyticsRow[] = [
  row(["esp"], 400, 5000),
  row(["usa"], 90, 3000),
  row(["mex"], 50, 2000),
  row(["deu"], 3, 150),
  row(["bgd"], 5, 500),
  row(["fra"], 0, 5),
];

const reader = (rows: SearchAnalyticsRow[] = ROWS) =>
  fakeGoogleReader({ searchConsole: { searchAnalytics: async () => rows } });

describe("site_hreflang_country_gap", () => {
  it("is named as a cross-source Tool and says its mapping is approximate", () => {
    expect(metadata.name).toBe("site_hreflang_country_gap");
    expect(metadata.description).toContain("approximate");
    expect(metadata.description).toContain("Needs the Google login");
  });

  it("pairs each meaningful country with the alternate that serves it, or says there is none", async () => {
    serve(SITE);
    const text = textOf(await handler(ARGS, reader()));

    expect(text).toContain("https://example.com/ — 4 hreflang annotation(s)");
    expect(text).toContain("Spain (ESP) — 5000 impressions, 46.9%: served by es-ES");
    expect(text).toContain("United States (USA) — 3000 impressions, 28.2%: served by en");
    expect(text).toContain("Mexico (MEX) — 2000 impressions, 18.8%: only alternates aimed at other countries, es-ES");
    expect(text).toContain("Germany (DEU) — 150 impressions, 1.4%: no alternate in German");
    expect(text).toContain("BGD — 500 impressions, 4.7%: not in our country-to-language table, not checked");
    // Five impressions is not a market.
    expect(text).not.toContain("France (FRA) — 5 impressions");

    expect(text).toContain("=== COUNTRIES WITHOUT AN ALTERNATE IN THEIR LANGUAGE (1) ===");
    expect(text).toContain("=== IN THEIR LANGUAGE, BUT AIMED AT ANOTHER COUNTRY (1) ===");
    expect(text).toContain("=== ALTERNATES WITH ABOUT NO IMPRESSIONS (1) ===");
    expect(text).toContain("fr-FR — aimed at France, 5 impressions there");
    expectClean(text);
  });

  it("reads a second page's alternates too", async () => {
    serve(SITE);
    const text = textOf(await handler({ ...ARGS, url: "https://example.com/blog/" }, reader()));

    expect(text).toContain("https://example.com/blog/ — 1 hreflang annotation(s)");
    expect(text).toContain("Germany (DEU) — 150 impressions, 1.4%: served by de");
    expect(text).toContain("=== COUNTRIES WITHOUT AN ALTERNATE IN THEIR LANGUAGE (0) ===");
  });

  it("reads each page once, and takes alternates from its Link header too", async () => {
    // The page used to be read through the Reachability Gate and then fetched a
    // second time by the analyzer. The one read now carries the headers, which
    // is where a `Link: rel="alternate"` annotation lives.
    const mock = serve({
      ...SITE,
      "https://example.com/": {
        ...HOME,
        headers: { ...HOME.headers, link: '<https://example.com/de/>; rel="alternate"; hreflang="de"' },
      },
    });
    const text = textOf(await handler(ARGS, reader()));

    const homeFetches = mock.mock.calls.filter(([input]) => String(input instanceof Request ? input.url : input) === "https://example.com/");
    expect(homeFetches).toHaveLength(1);
    expect(text).toContain("https://example.com/ — 5 hreflang annotation(s)");
    expect(text).toContain("Germany (DEU) — 150 impressions, 1.4%: served by de");
  });

  it("counts the page's own language, so a site without hreflang is not a gap in its own country", async () => {
    serve({ ...SITE, "https://example.com/": html("<h1>Inicio</h1>", "", "es") });
    const text = textOf(await handler(ARGS, reader()));

    expect(text).toContain("Spain (ESP) — 5000 impressions, 46.9%: served by es");
    expect(text).toContain("Mexico (MEX) — 2000 impressions, 18.8%: served by es");
    expect(text).toContain("United States (USA) — 3000 impressions, 28.2%: no alternate in English");
  });

  it("says the country-to-language table is an approximation", async () => {
    serve(SITE);
    const text = textOf(await handler(ARGS, reader()));

    expect(text).toContain("It is an approximation");
    expect(text).toContain("Countries not in the table: BGD.");
  });

  it("reports a homepage robots.txt closes to us as not checked", async () => {
    serve({ ...SITE, "/robots.txt": { body: "User-agent: *\nDisallow: /" } });
    const text = textOf(await handler(ARGS, reader()));

    expect(text).toContain("=== NOT CHECKED (1) ===\n  https://example.com/ — robots.txt disallows");
    expect(text).toContain("Not checked: no page could be read");
    expect(text).not.toContain("=== COUNTRIES WITHOUT AN ALTERNATE");
    expectClean(text);
  });

  it("reports an unreachable homepage as not checked", async () => {
    serve({ ...SITE, "https://example.com/": { status: 502 } });
    const text = textOf(await handler(ARGS, reader()));

    expect(text).toContain("=== NOT CHECKED (1) ===\n  https://example.com/ — The URL returned HTTP 502");
    expectClean(text);
  });

  it("answers an empty window without reading the site", async () => {
    const mock = serve(SITE);
    const text = textOf(await handler(ARGS, reader([])));

    expect(text).toContain("No impressions by country in this window");
    expect(mock).not.toHaveBeenCalled();
    expectClean(text);
  });

  it("lets Google's refusal reject", async () => {
    const refusing = fakeGoogleReader({
      searchConsole: {
        searchAnalytics: async () => {
          throw new UpstreamApiError("Search Console", 403);
        },
      },
    });
    await expect(handler(ARGS, refusing)).rejects.toBeInstanceOf(UpstreamApiError);
  });
});
