import { describe, it, expect, vi, afterEach } from "vitest";
import { lookupWikidata } from "@/lib/wikidata-check";
import { requestsOf, serve, type FetchMock } from "../helpers/serve";

/** Wikidata's search endpoint answering `body` with `status`. */
function answer(status: number, body: object | string): FetchMock {
  return serve({
    "www.wikidata.org/w/api.php": { status, body: typeof body === "string" ? body : JSON.stringify(body) },
  });
}

describe("lookupWikidata", () => {
  afterEach(() => { vi.unstubAllGlobals(); });

  it("returns found:true with id, label, description when a matching entity exists", async () => {
    answer(200, {
      search: [{ label: "Acme Corp", id: "Q12345", description: "A widget maker" }],
    });

    const result = await lookupWikidata("Acme Corp");

    expect(result.found).toBe(true);
    expect(result.id).toBe("Q12345");
    expect(result.label).toBe("Acme Corp");
    expect(result.description).toBe("A widget maker");
  });

  it("returns found:false when search returns no results", async () => {
    answer(200, { search: [] });

    const result = await lookupWikidata("UnknownBrandXYZ");

    expect(result.found).toBe(false);
    expect(result.id).toBeUndefined();
  });

  it("returns found:false when search returns entries that do not match the brand", async () => {
    answer(200, {
      search: [{ label: "Completely Different Thing", id: "Q99999" }],
    });

    const result = await lookupWikidata("Acme Corp");

    expect(result.found).toBe(false);
  });

  /**
   * These two used to assert `found: false`, which is what the code did and what was
   * wrong with it. A search that came back and matched nothing is evidence the brand
   * has no Wikidata item; an API that returned 503 or never answered is evidence of
   * nothing, and `false` reported the second as the first — so `ai_visibility_score`
   * told brands that already have an item to go and create one, and docked 6 points
   * for our own network trouble (#337).
   */
  it("returns found:null when the API returns a non-200 status, not found:false", async () => {
    answer(503, "Service Unavailable");

    const result = await lookupWikidata("Acme Corp");

    expect(result.found).toBeNull();
    expect(result.reason).toContain("503");
  });

  it("returns found:null when the fetch rejects (network error)", async () => {
    serve({
      "www.wikidata.org/w/api.php": () => {
        throw new Error("Network error");
      },
    });

    const result = await lookupWikidata("Acme Corp");

    expect(result.found).toBeNull();
    expect(result.reason).toBeTruthy();
  });

  it("still returns found:false when the search answers and matches nothing", async () => {
    // The distinction only earns its keep if a real negative stays a negative.
    answer(200, JSON.stringify({ search: [] }));

    const result = await lookupWikidata("Acme Corp");

    expect(result.found).toBe(false);
    expect(result.reason).toBeUndefined();
  });

  it("asks in the page's language, and in English when it does not say", async () => {
    // `wbsearchentities` searches one language's labels at a time. Asking in English
    // unconditionally made an item labelled only in Spanish invisible, so the report
    // told a company that has a Wikidata item to go and create one (#342).
    const mock = answer(200, { search: [] });

    await lookupWikidata("El País", "es");
    expect(requestsOf(mock)[0]?.searchParams.get("language")).toBe("es");

    await lookupWikidata("Acme Corp");
    expect(requestsOf(mock)[1]?.searchParams.get("language")).toBe("en");
  });
});