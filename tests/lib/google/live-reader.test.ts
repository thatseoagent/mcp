import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { UpstreamApiError } from "@/lib/upstream-api-error";

vi.mock("@/lib/google/oauth", () => ({
  accessToken: vi.fn(async () => "test-access-token"),
}));

import { createGoogleReader } from "@/lib/google/live-reader";

const originalFetch = globalThis.fetch;
let calls: Array<{ url: string; init: RequestInit }> = [];

/** Answer every Google request with one payload, recording what was asked. */
function answerWith(payload: unknown, status = 200): void {
  calls = [];
  globalThis.fetch = vi.fn(async (input: string | URL | Request, init: RequestInit = {}) => {
    calls.push({ url: String(input), init });
    return new Response(JSON.stringify(payload), {
      status,
      headers: { "content-type": "application/json" },
    });
  }) as unknown as typeof fetch;
}

beforeEach(async () => {
  answerWith({});
  // The token mock is module-level, so its call count carries between cases.
  const { accessToken } = await import("@/lib/google/oauth");
  vi.mocked(accessToken).mockClear();
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
});

describe("authenticating every request", () => {
  it("sends the access token as a bearer token", async () => {
    await createGoogleReader().searchConsole.listProperties();

    expect((calls[0].init.headers as Record<string, string>).authorization).toBe(
      "Bearer test-access-token",
    );
  });

  it("asks for a token per request rather than holding one", async () => {
    // Nothing is cached in the reader, so a long-running server can never hand
    // out a stale token. The refresh decision lives in the token store.
    const { accessToken } = await import("@/lib/google/oauth");

    const reader = createGoogleReader();
    await reader.searchConsole.listProperties();
    await reader.searchConsole.listProperties();

    expect(accessToken).toHaveBeenCalledTimes(2);
  });
});

describe("Search Console requests", () => {
  it("escapes a Domain Property identifier in the path", async () => {
    // `sc-domain:example.com` contains a colon, which changes what a URL path
    // means. Forgetting this produces a 404 that reads as "you do not have this
    // property".
    await createGoogleReader().searchConsole.listSitemaps("sc-domain:example.com");

    expect(calls[0].url).toContain("/sites/sc-domain%3Aexample.com/sitemaps");
  });

  it("escapes a URL-Prefix Property identifier in the path", async () => {
    await createGoogleReader().searchConsole.listSitemaps("https://example.com/");

    expect(calls[0].url).toContain("/sites/https%3A%2F%2Fexample.com%2F/sitemaps");
  });

  it("posts the query without repeating the property in the body", async () => {
    await createGoogleReader().searchConsole.searchAnalytics({
      siteUrl: "sc-domain:example.com",
      startDate: "2026-08-01",
      endDate: "2026-08-28",
      dimensions: ["query"],
    });

    expect(calls[0].init.method).toBe("POST");
    const body = JSON.parse(String(calls[0].init.body));
    expect(body).toEqual({
      startDate: "2026-08-01",
      endDate: "2026-08-28",
      dimensions: ["query"],
    });
    expect(body.siteUrl).toBeUndefined();
  });

  it("reads no properties as an empty list rather than as undefined", async () => {
    // An Operator with no properties gets `{}` from Google, not `{ siteEntry: [] }`.
    answerWith({});

    await expect(createGoogleReader().searchConsole.listProperties()).resolves.toEqual([]);
  });

  it("reads no rows as an empty list", async () => {
    answerWith({});

    await expect(
      createGoogleReader().searchConsole.searchAnalytics({
        siteUrl: "sc-domain:example.com",
        startDate: "2026-08-01",
        endDate: "2026-08-28",
      }),
    ).resolves.toEqual([]);
  });

  it("names both the property and the URL when inspecting", async () => {
    // Google requires the property: the same URL can sit under more than one
    // property an Operator holds.
    await createGoogleReader().searchConsole.inspectUrl(
      "sc-domain:example.com",
      "https://example.com/page",
    );

    const body = JSON.parse(String(calls[0].init.body));
    expect(body.siteUrl).toBe("sc-domain:example.com");
    expect(body.inspectionUrl).toBe("https://example.com/page");
  });
});

describe("Analytics requests", () => {
  it("accepts a bare property id and a full resource name alike", async () => {
    const reader = createGoogleReader();

    await reader.analytics.getMetadata("123456789");
    await reader.analytics.getMetadata("properties/123456789");

    expect(calls[0].url).toContain("/properties/123456789/metadata");
    expect(calls[1].url).toContain("/properties/123456789/metadata");
  });

  it("converts dimensions and metrics into the shape the Data API wants", async () => {
    // The API takes `[{ name: "sessions" }]` where every caller here thinks in
    // `["sessions"]`. Converting at the boundary keeps the awkward shape out of
    // every Tool.
    await createGoogleReader().analytics.runReport({
      property: "123456789",
      dateRanges: [{ startDate: "2026-08-01", endDate: "2026-08-28" }],
      dimensions: ["sessionDefaultChannelGroup"],
      metrics: ["sessions"],
    });

    const body = JSON.parse(String(calls[0].init.body));
    expect(body.dimensions).toEqual([{ name: "sessionDefaultChannelGroup" }]);
    expect(body.metrics).toEqual([{ name: "sessions" }]);
    expect(body.dateRanges).toEqual([{ startDate: "2026-08-01", endDate: "2026-08-28" }]);
  });

  it("flattens account summaries into one list of properties", async () => {
    // Account summaries rather than the properties endpoint, which needs an
    // account filter an Operator does not necessarily know.
    answerWith({
      accountSummaries: [
        {
          account: "accounts/1",
          displayName: "Example Ltd",
          propertySummaries: [
            { property: "properties/111", displayName: "One" },
            { property: "properties/222", displayName: "Two" },
          ],
        },
        { account: "accounts/2", displayName: "Other", propertySummaries: [] },
      ],
    });

    await expect(createGoogleReader().analytics.listProperties()).resolves.toEqual([
      { name: "properties/111", displayName: "One", account: "Example Ltd" },
      { name: "properties/222", displayName: "Two", account: "Example Ltd" },
    ]);
  });
});

describe("when Google refuses", () => {
  it("names the service and the status, and never forwards Google's body", async () => {
    answerWith({ error: { message: "Request had insufficient authentication scopes." } }, 403);

    const failure = await createGoogleReader()
      .searchConsole.listProperties()
      .catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(UpstreamApiError);
    const message = (failure as Error).message;
    expect(message).toContain("Google Search Console returned HTTP 403");
    expect(message).toContain("The key was refused");
    expect(message).not.toContain("insufficient authentication scopes");
  });

  it("distinguishes Analytics from Search Console in the refusal", async () => {
    answerWith({}, 429);

    await expect(createGoogleReader().analytics.listProperties()).rejects.toThrow(
      /Google Analytics returned HTTP 429/,
    );
  });
});

describe("no ambient auth state anywhere", () => {
  /**
   * Asserted against the source, because this is a rule about shape rather than
   * behaviour and no test of behaviour would catch it being broken.
   *
   * The retired implementation carried its OAuth client in an
   * `AsyncLocalStorage`, because on a shared serverless runtime module scope
   * meant one user's tokens answering another user's request. A **Single-tenant**
   * server has no callers to isolate, so porting the machinery would have added
   * the complexity without the reason — and left a thread-local a future reader
   * could mistake for a per-caller boundary this server does not have.
   */
  it("contains no AsyncLocalStorage in the Google layer", () => {
    const dir = path.resolve(process.cwd(), "src/lib/google");

    for (const file of readdirSync(dir).filter((name) => name.endsWith(".ts"))) {
      const source = readFileSync(path.join(dir, file), "utf8");
      // Comments are allowed to explain the decision; a use is not.
      expect(source.replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, ""), file).not.toContain(
        "AsyncLocalStorage",
      );
    }
  });

  it("holds no module-level mutable credential", () => {
    const dir = path.resolve(process.cwd(), "src/lib/google");

    for (const file of readdirSync(dir).filter((name) => name.endsWith(".ts"))) {
      const source = readFileSync(path.join(dir, file), "utf8").replace(
        /\/\*[\s\S]*?\*\/|\/\/[^\n]*/g,
        "",
      );
      // A top-level `let` in this layer is how a cached client or token would
      // arrive. There is no legitimate one today.
      expect(source, file).not.toMatch(/^let\s/m);
    }
  });
});
