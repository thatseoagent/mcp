import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import entityMentions from "@/tools/entity-mentions";
import { serve, type Route } from "../helpers/serve";
import { resetAllSingleFlightCaches } from "@/lib/single-flight";

const originalFetch = globalThis.fetch;

// The homepage is read through `fetchHtml`, which shares one request per URL per
// window — every case here serves different markup at the same URL.
beforeEach(resetAllSingleFlightCaches);

afterEach(() => {
  globalThis.fetch = originalFetch;
  resetAllSingleFlightCaches();
  vi.restoreAllMocks();
});

const textOf = (result: Awaited<ReturnType<typeof entityMentions>>): string =>
  result.content.map((part) => part.text).join("\n");

/** `serve`, plus a record of every URL asked for — what we searched matters here. */
function serveWatching(routes: Record<string, Route>): string[] {
  serve(routes);
  const inner = globalThis.fetch;
  const seen: string[] = [];
  globalThis.fetch = vi.fn(async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    seen.push(
      typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url,
    );
    return inner(input, init);
  }) as unknown as typeof fetch;
  return seen;
}

const HOMEPAGE = `<!DOCTYPE html><html lang="en"><head>
  <title>Acme Corp | Leading Widget Maker</title>
  <meta property="og:site_name" content="Acme Corp" />
  <script type="application/ld+json">
    {"@type":"Organization","name":"Acme Corp","url":"https://acme.com"}
  </script></head><body>
  <a href="https://www.linkedin.com/company/acme-corp">LinkedIn</a>
  <a href="https://www.youtube.com/@acmecorp">YouTube</a>
  <a href="https://github.com/acme-corp">GitHub</a>
</body></html>`;

const WIKIPEDIA_HIT = JSON.stringify({
  title: "Acme Corp",
  content_urls: { desktop: { page: "https://en.wikipedia.org/wiki/Acme_Corp" } },
});
const WIKIDATA_HIT = JSON.stringify({
  search: [{ label: "Acme Corp", id: "Q12345", description: "Widget maker" }],
});

/** The homepage plus a working answer from every platform. */
const everythingFound = (overrides: Record<string, Route> = {}): Record<string, Route> => ({
  "acme.com": { body: HOMEPAGE },
  "wikipedia.org/api/rest_v1/page/summary": { body: WIKIPEDIA_HIT },
  "wikidata.org/w/api.php": { body: WIKIDATA_HIT },
  "reddit.com/search.json": { body: JSON.stringify({ data: { children: [{}, {}, {}] } }) },
  "linkedin.com/company/acme-corp": { body: "" },
  "youtube.com/@acmecorp": { body: "" },
  "github.com/acme-corp": { body: "" },
  ...overrides,
});

const audit = async (url = "https://acme.com"): Promise<string> =>
  textOf(await entityMentions({ url }));

describe("entity_mentions", () => {
  it("confirms every platform the brand is on", async () => {
    serve(everythingFound());

    const text = await audit();

    expect(text).toContain("Brand detected: Acme Corp (declared in schema)");
    expect(text).toContain("Wikipedia [API check]: FOUND");
    expect(text).toContain("Wikidata [API check]: FOUND");
    expect(text).toContain("Reddit [API check]: FOUND");
    expect(text).toContain("LinkedIn [URL check only]: FOUND");
    expect(text).toContain("Summary: 6/6 platforms confirmed");
  });

  it("omits the linked platforms a homepage does not link to", async () => {
    serve({
      "acme.com": { body: `<html lang="en"><head><title>Acme Corp</title></head><body></body></html>` },
      "wikipedia.org": { status: 404, body: "" },
      "wikidata.org": { body: JSON.stringify({ search: [] }) },
      "reddit.com": { body: JSON.stringify({ data: { children: [] } }) },
    });

    const text = await audit();

    expect(text).not.toContain("LinkedIn");
    expect(text).not.toContain("YouTube");
    expect(text).not.toContain("GitHub");
  });

  it("says the homepage could not be read, rather than that it names no brand", async () => {
    // Two different facts that used to print as one. A page we never read tells us
    // nothing about how the brand is marked up.
    serve({ "acme.com": { status: 500, body: "" } });

    const result = await entityMentions({ url: "https://acme.com" });

    // No platform was checked, so there is no audit here — and a Tool that cannot
    // do its whole job says so (CONTEXT.md, ADR-0003).
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("The homepage could not be read (HTTP 500)");
    expect(textOf(result)).toContain("This is not a finding about the brand.");
  });

  it("says so when the page was read and names no brand", async () => {
    serve({ "acme.com": { body: "<html><head></head><body></body></html>" } });

    const result = await entityMentions({ url: "https://acme.com" });

    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("it names no brand");
  });

  it("refuses a private address instead of fetching it", async () => {
    // `defineTool` publishes an SSRF refusal verbatim: it is our own sentence and
    // the whole answer. Swallowing it here would turn a correct refusal into a
    // report that the brand names nothing.
    const result = await entityMentions({ url: "http://169.254.169.254/" });

    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("private/reserved address");
  });
});

describe("entity_mentions — a platform that did not answer", () => {
  it("does not report a Wikipedia failure as an absent article", async () => {
    // The instance that stated the problem in its own output: `Wikipedia — NOT
    // FOUND` about a brand that may well have an article.
    serve(everythingFound({ "wikipedia.org/api/rest_v1/page/summary": { status: 500, body: "" } }));

    const text = await audit();

    expect(text).toContain("Wikipedia [API check]: NOT RUN");
    expect(text).not.toContain("Wikipedia [API check]: NOT FOUND");
  });

  it("still reports a real 404 as an absent article", async () => {
    serve(everythingFound({ "wikipedia.org/api/rest_v1/page/summary": { status: 404, body: "" } }));

    expect(await audit()).toContain("Wikipedia [API check]: NOT FOUND");
  });

  it("does not report a rate-limited Reddit as an absence", async () => {
    serve(everythingFound({ "reddit.com/search.json": { status: 429, body: "" } }));

    expect(await audit()).toContain("Reddit [API check]: NOT RUN");
  });

  it("does not call a company page unreachable when the platform refuses to answer", async () => {
    // LinkedIn answers HTTP 999 to clients that are not browsers, so `response.ok`
    // told Operators their company page was unreachable when what happened is that
    // LinkedIn does not talk to us.
    serve(everythingFound({ "linkedin.com/company/acme-corp": { status: 999, body: "" } }));

    const text = await audit();

    expect(text).toContain("LinkedIn [URL check only]: NOT RUN");
    expect(text).toMatch(/LinkedIn.*did not answer/);
  });

  it("still reports a 404 at a linked URL as a real absence", async () => {
    serve(everythingFound({ "github.com/acme-corp": { status: 404, body: "" } }));

    expect(await audit()).toContain("GitHub [URL check only]: NOT FOUND");
  });

  it("keeps an unevaluated platform out of the summary's denominator", async () => {
    // Two runs against the same brand used to give different figures with nothing
    // about the brand having changed.
    serve(everythingFound({ "reddit.com/search.json": { status: 429, body: "" } }));

    expect(await audit()).toContain("Summary: 5/5 platforms confirmed, 1 not checked");
  });
});

/**
 * The brand we search for, and where we search.
 *
 * This Tool used to derive the brand with a private regex JSON-LD parser that
 * flattened `@graph` and not a top-level array — so `[{"@type":"Organization"}]`,
 * what any site without `@graph` emits, was invisible to it and the name silently
 * degraded to a fragment of `<title>`. That fragment is what got searched, so a
 * brand with an article was reported as having none. It also hard-coded
 * `en.wikipedia.org` and asked Wikidata in English only.
 */
describe("entity_mentions — the Publishing Entity", () => {
  const spanishPage = (ld: string) => `<!DOCTYPE html><html lang="es">
    <head><title>Ofertas del día | Comercial Peralta</title>${ld}</head>
    <body><p>Bienvenido.</p></body></html>`;

  const ORG_IN_ARRAY = `<script type="application/ld+json">
    [{"@type":"Organization","name":"Comercial Peralta","url":"https://peralta.es"}]
    </script>`;

  it("finds an Organization inside a top-level JSON-LD array", async () => {
    const seen = serveWatching({ "peralta.es": { body: spanishPage(ORG_IN_ARRAY) } });

    const text = await audit("https://peralta.es");

    expect(text).toContain("Brand detected: Comercial Peralta (declared in schema)");
    // And that is what went out to the lookups, not "Ofertas del día".
    expect(seen.some((url) => url.includes("Comercial%20Peralta"))).toBe(true);
    expect(seen.some((url) => url.includes("Ofertas"))).toBe(false);
  });

  it("asks the page's own Wikipedia edition first", async () => {
    const seen = serveWatching({
      "peralta.es": { body: spanishPage(ORG_IN_ARRAY) },
      "es.wikipedia.org": {
        body: JSON.stringify({
          title: "Comercial Peralta",
          content_urls: { desktop: { page: "https://es.wikipedia.org/wiki/Comercial_Peralta" } },
        }),
      },
    });

    const text = await audit("https://peralta.es");

    expect(text).toMatch(/Wikipedia \[API check\]: FOUND.*es\.wikipedia\.org/);
    // A hit in the page's own language is conclusive, so English is never asked.
    expect(seen.some((url) => url.includes("en.wikipedia.org"))).toBe(false);
  });

  it("falls back to English only when the page's language has no article", async () => {
    // A Spanish company may perfectly well have an English article and nothing
    // else. Only a negative spends the second request.
    const seen = serveWatching({
      "peralta.es": { body: spanishPage(ORG_IN_ARRAY) },
      "en.wikipedia.org": {
        body: JSON.stringify({
          title: "Comercial Peralta",
          content_urls: { desktop: { page: "https://en.wikipedia.org/wiki/Comercial_Peralta" } },
        }),
      },
    });

    const text = await audit("https://peralta.es");

    expect(seen.some((url) => url.includes("es.wikipedia.org"))).toBe(true);
    expect(text).toMatch(/Wikipedia \[API check\]: FOUND.*en\.wikipedia\.org/);
  });

  it("asks Wikidata in the page's language", async () => {
    const seen = serveWatching({ "peralta.es": { body: spanishPage(ORG_IN_ARRAY) } });

    await audit("https://peralta.es");

    expect(
      seen.some((url) => url.includes("wikidata.org") && url.includes("language=es")),
    ).toBe(true);
  });

  it("says a title-derived name is a guess, so a NOT FOUND can be read correctly", async () => {
    serve({ "peralta.es": { body: spanishPage("") } });

    const text = await audit("https://peralta.es");

    expect(text).toContain("guessed from the page title");
    expect(text).toContain("treat any NOT FOUND below as a finding about the title");
  });

  it("finds a Person, so a personal site is not searched by its page title", async () => {
    serve({
      "ada.dev": {
        body: `<!DOCTYPE html><html lang="en"><head><title>Notes on computing | ada.dev</title>
          <script type="application/ld+json">{"@type":"Person","name":"Ada Lovelace"}</script>
          </head><body></body></html>`,
      },
    });

    expect(await audit("https://ada.dev")).toContain("Brand detected: Ada Lovelace");
  });
});
