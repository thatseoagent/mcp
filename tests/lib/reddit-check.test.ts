import { describe, it, expect, vi, afterEach } from "vitest";
import { lookupReddit } from "@/lib/reddit-check";
import { serve } from "../helpers/serve";

/**
 * The Reddit lookup's three states: a search that came back empty is evidence,
 * and a 429 — the likeliest answer to an unauthenticated search — is evidence
 * of nothing.
 *
 * What a request to Reddit carries and what a timeout says belong to `callApi`
 * and are asserted in `third-party-api.test.ts`.
 */

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
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
