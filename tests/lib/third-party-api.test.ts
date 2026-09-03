import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { fetchThirdPartyApi } from "@/lib/http-client";
import { lookupWikipedia } from "@/lib/wikipedia-check";
import { lookupReddit } from "@/lib/reddit-check";
import { resetCrawlPacing } from "@/lib/crawl-pacing";
import { resetAllSingleFlightCaches } from "@/lib/single-flight";
import { serve, type FetchMock, type Route } from "../helpers/serve";

/**
 * The invariant this file exists to keep: **a fixed third-party API is exempt
 * from the robots gate on purpose, and from nothing else.**
 *
 * `robots-gate.ts` names two deliberate exemptions, and one of them is "fixed
 * third-party APIs (Wikipedia, Wikidata). Those are APIs with their own terms,
 * reached at a known endpoint, and they are not what a site owner is addressing
 * when they write a rule about our crawler." That is right.
 *
 * It was implemented by five call sites reaching for the global `fetch`, so
 * nothing distinguished "exempt on purpose" from "forgot" — and the exemption
 * came with two others nobody argued for. The reads were not paced, though
 * `robots-gate.ts` makes the case for pacing its own robots.txt fetch in as many
 * words ("it says nothing about the request being free, and it is not"). And they
 * sat outside the fetch scope, so `with-cache.ts`'s promise that `force_refresh`
 * reaches "all the way down" was vacuously true for them rather than kept.
 *
 * The three-state half is the same discipline `wikidata-check.ts` argues for at
 * length, applied to the two lookups that had no module: a 404 is evidence the
 * brand has no article, and a 429 is evidence of nothing.
 */

/** Anything this file asks for that a case has not spoken about. */
const EMPTY_JSON: Route = { body: "{}" };

const urls = (mock: FetchMock) => mock.mock.calls.map((call) => String(call[0]));

beforeEach(() => {
  resetAllSingleFlightCaches();
  resetCrawlPacing();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  resetAllSingleFlightCaches();
  resetCrawlPacing();
});

describe("reading a fixed third-party API", () => {
  it("does not ask the API's robots.txt for permission", async () => {
    // Asking `wikipedia.org/robots.txt` whether we may call Wikipedia's REST API
    // is asking the wrong party the wrong question.
    const mock = serve({
      "/robots.txt": { body: "User-agent: *\nDisallow: /" },
    });

    await fetchThirdPartyApi("https://en.wikipedia.org/api/rest_v1/page/summary/Acme");

    expect(urls(mock)).toEqual([
      "https://en.wikipedia.org/api/rest_v1/page/summary/Acme",
    ]);
  });

  it("hands back the status instead of throwing, so a 404 stays an answer", async () => {
    serve({ "wikipedia.org": { status: 404 } });

    const res = await fetchThirdPartyApi("https://en.wikipedia.org/api/rest_v1/page/summary/Acme");

    expect(res.status).toBe(404);
  });

  it("identifies itself, because these APIs ask for a contactable agent", async () => {
    const mock = serve({ "https://": EMPTY_JSON });

    await fetchThirdPartyApi("https://www.reddit.com/search.json?q=acme");

    const init = mock.mock.calls[0][1] as RequestInit;
    const headers = init.headers as Record<string, string>;
    expect(headers["User-Agent"]).toContain("ThatSEOAgentBot");
  });
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

describe("the Reddit lookup", () => {
  it("counts the threads it found", async () => {
    serve({
      "reddit.com": { body: JSON.stringify({ data: { children: [{}, {}, {}] } }) },
    });

    expect(await lookupReddit("Acme")).toMatchObject({ found: true, threads: 3 });
  });

  it("reads an empty result as an answer", async () => {
    serve({
      "reddit.com": { body: JSON.stringify({ data: { children: [] } }) },
    });

    expect(await lookupReddit("Acme")).toMatchObject({ found: false });
  });

  it("reads a rate limit as no answer, which is the likeliest branch", async () => {
    serve({ "reddit.com": { status: 429 } });

    const match = await lookupReddit("Acme");

    // Reddit rate-limits unauthenticated search hard, so this is the outcome a
    // real run meets most often — which is why reporting it as "no threads
    // found" would be the lie most often told.
    expect(match.found).toBeNull();
    expect(match.reason).toContain("429");
  });

  it("always says where a reader can check our work", async () => {
    serve({ "reddit.com": { status: 500 } });

    expect((await lookupReddit("Acme")).url).toBe(
      "https://www.reddit.com/search/?q=Acme",
    );
  });
});
