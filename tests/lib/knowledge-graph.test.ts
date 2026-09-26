import { describe, it, expect, afterEach, vi } from "vitest";
import { lookupKnowledgeGraph } from "@/lib/knowledge-graph";
import { requestsOf, restoreFetch, serve, type FetchMock } from "../helpers/serve";

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

function answer(body: unknown, status = 200): FetchMock {
  return serve({
    "kgsearch.googleapis.com": {
      status,
      body: JSON.stringify(body),
      headers: { "content-type": "application/json" },
    },
  });
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
    serve({
      "kgsearch.googleapis.com": () => {
        throw new Error("socket hang up");
      },
    });

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

    const [asked] = requestsOf(mock);
    expect(asked?.url.split("?")[0]).toBe("https://kgsearch.googleapis.com/v1/entities:search");
    expect(asked?.searchParams.get("query")).toBe("Example Ltd");
    expect(asked?.searchParams.get("limit")).toBe("1");
    expect(asked?.searchParams.get("key")).toBe("test-key");
  });
});
