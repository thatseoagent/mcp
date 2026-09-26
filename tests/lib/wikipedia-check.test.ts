import { describe, it, expect, vi, afterEach } from "vitest";
import { lookupWikipedia } from "@/lib/wikipedia-check";
import { serve, type FetchMock } from "../helpers/serve";

/**
 * The Wikipedia lookup's three states, which is the same discipline
 * `wikidata-check.ts` argues for at length: a 404 is evidence the brand has no
 * article, and a 429 is evidence of nothing.
 *
 * What a request to Wikipedia carries and what a timeout says belong to
 * `callApi` and are asserted in `third-party-api.test.ts`.
 */

const urls = (mock: FetchMock) => mock.mock.calls.map((call) => String(call[0]));

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("the Wikipedia lookup", () => {
  it("finds an article and says where", async () => {
    serve({
      "wikipedia.org": { body: JSON.stringify({
            title: "Acme Corporation",
            content_urls: { desktop: { page: "https://en.wikipedia.org/wiki/Acme_Corporation" } },
          }) },
    });

    expect(await lookupWikipedia("Acme", "en")).toMatchObject({
      found: true,
      title: "Acme Corporation",
      url: "https://en.wikipedia.org/wiki/Acme_Corporation",
    });
  });

  it("reads a 404 as the answer it is", async () => {
    serve({ "wikipedia.org": { status: 404 } });

    expect(await lookupWikipedia("Acme", "en")).toMatchObject({ found: false });
  });

  it("reads a 429 as no answer at all", async () => {
    serve({ "wikipedia.org": { status: 429 } });

    const match = await lookupWikipedia("Acme", "en");

    // Not `found: false`. Printing `✗ Wikipedia — NOT FOUND` about a brand that
    // may well have an article is the confident lie the three states exist to
    // prevent, and this Tool printed it.
    expect(match.found).toBeNull();
    expect(match.reason).toContain("429");
  });

  it("tries the page's own language first, and English only on a negative", async () => {
    const mock = serve({
      "es.wikipedia.org": { body: JSON.stringify({ title: "Acme S.A." }) },
    });

    const match = await lookupWikipedia("Acme", "es");

    // Conclusive in Spanish, so English is never asked. A hard-coded
    // `en.wikipedia.org` reported a Spanish company with a Spanish article as
    // having no Wikipedia presence.
    expect(match).toMatchObject({ found: true, title: "Acme S.A." });
    expect(urls(mock)).toHaveLength(1);
    expect(match.searched).toEqual(["es", "en"]);
  });

  it("falls back to English when the page's language has no article", async () => {
    const mock = serve({
      "es.wikipedia.org": { status: 404 },
      "en.wikipedia.org": { body: JSON.stringify({ title: "Acme Corporation" }) },
    });

    expect(await lookupWikipedia("Acme", "es")).toMatchObject({ found: true });
    expect(urls(mock)).toHaveLength(2);
  });

  it("leaves the question open when one edition would not answer", async () => {
    serve({
      "es.wikipedia.org": { status: 503 },
      "en.wikipedia.org": { status: 404 },
    });

    // The article could be in the edition we could not read, so "no article"
    // is not available as an answer.
    expect((await lookupWikipedia("Acme", "es")).found).toBeNull();
  });
});

describe("the summary request", () => {
  it("sends the title with underscores for spaces, percent-encoded, as the endpoint documents", async () => {
    const mock = serve({ "wikipedia.org": { body: JSON.stringify({ title: "Acme Corporation" }) } });

    await lookupWikipedia(" Acme Corporation/UK ", "en");

    // Wikipedia's REST reference: "Use underscores instead of spaces. Use
    // percent-encoding." A title not in that form is documented to answer with
    // a permanent redirect; this lookup used to send `%20`.
    expect(urls(mock)).toEqual([
      "https://en.wikipedia.org/api/rest_v1/page/summary/Acme_Corporation%2FUK",
    ]);
  });
});
