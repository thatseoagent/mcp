import { describe, it, expect, afterEach, vi } from "vitest";
import { lookupKnowledgeGraph } from "@/lib/knowledge-graph";
import { restoreFetch } from "../helpers/serve";

/**
 * The Knowledge Graph lookup's three states.
 *
 * The module's own header records that it once argued for `null` on a missing
 * API key in the comment and returned `false` on the line below it, and that
 * this was unreachable "only because two callers remember". Nothing asserted
 * either half. These are the cases that make the argument binding: `false` here
 * charges every site for a check we never gave them.
 */

const KEY = "GOOGLE_KG_API_KEY";

afterEach(() => {
  delete process.env[KEY];
  restoreFetch();
  vi.restoreAllMocks();
});

function answer(body: unknown, status = 200): ReturnType<typeof vi.fn> {
  const mock = vi.fn(
    async () =>
      new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } }),
  );
  vi.stubGlobal("fetch", mock);
  return mock;
}

describe("what it answers", () => {
  it("says it does not know when no key is configured", async () => {
    const mock = answer({});

    const result = await lookupKnowledgeGraph("Example Ltd");

    // Not `false`. Our deployment is not their site.
    expect(result.found).toBeNull();
    expect(result.reason).toContain("not configured");
    expect(mock).not.toHaveBeenCalled();
  });

  it("is true when the API returns an entity", async () => {
    process.env[KEY] = "test-key";
    answer({ itemListElement: [{ result: { name: "Example Ltd" } }] });

    expect(await lookupKnowledgeGraph("Example Ltd")).toEqual({ found: true });
  });

  it("is false when the API answers with no entity", async () => {
    process.env[KEY] = "test-key";
    answer({ itemListElement: [] });

    // The one case where `false` is the truth: we asked and Google has nothing.
    expect(await lookupKnowledgeGraph("Example Ltd")).toEqual({ found: false });
  });

  it("says it does not know when the API refuses", async () => {
    process.env[KEY] = "test-key";
    answer({ error: {} }, 503);

    const result = await lookupKnowledgeGraph("Example Ltd");

    // Telling a brand with a Knowledge Panel to "strengthen entity signals"
    // because the API 503'd is the failure mode this three-state exists for.
    expect(result.found).toBeNull();
    expect(result.reason).toContain("503");
  });

  it("says it does not know when the request throws", async () => {
    process.env[KEY] = "test-key";
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("socket hang up"); }));

    const result = await lookupKnowledgeGraph("Example Ltd");

    expect(result.found).toBeNull();
    expect(result.reason).toContain("did not respond");
    // Not the remote error's text: the sentence is ours.
    expect(result.reason).not.toContain("socket hang up");
  });
});

describe("what it sends", () => {
  it("asks for one result, by name, with the key as a parameter", async () => {
    process.env[KEY] = "test-key";
    const mock = answer({ itemListElement: [] });

    await lookupKnowledgeGraph("Example Ltd");

    const url = new URL(String(mock.mock.calls[0][0]));
    expect(url.origin + url.pathname).toBe("https://kgsearch.googleapis.com/v1/entities:search");
    expect(url.searchParams.get("query")).toBe("Example Ltd");
    expect(url.searchParams.get("limit")).toBe("1");
    expect(url.searchParams.get("key")).toBe("test-key");
  });
});
