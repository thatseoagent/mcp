import { describe, it, expect, afterEach, vi } from "vitest";
import seoAgentApiSurface from "@/tools/seo-agent-api-surface";
import { serve } from "../helpers/serve";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
});

/**
 * A path, not the root: `serve()` falls back to substring matching, and
 * `https://example.com/` is a substring of every spec location this tier tries.
 */
const PAGE = "https://example.com/page";

const textOf = (result: Awaited<ReturnType<typeof seoAgentApiSurface>>): string =>
  result.content.map((part) => part.text).join("\n");

const page = {
  headers: { "content-type": "text/html" },
  body: "<html><head><title>Page</title></head><body></body></html>",
};

/** The smallest document that is recognisably an OpenAPI spec. */
const SPEC = {
  openapi: "3.1.0",
  info: { title: "Example", version: "1.0.0" },
  servers: [{ url: "https://example.com/api" }],
  paths: {
    "/things": {
      get: {
        operationId: "listThings",
        description: "List the things.",
        responses: {
          "200": {
            description: "OK",
            content: { "application/json": { schema: { type: "array" } } },
          },
        },
      },
    },
  },
};

describe("seo_agent_api_surface", () => {
  it("does not treat a site with no API as a site with a failing API", async () => {
    serve({
      "example.com/robots.txt": { status: 404, body: "" },
      [PAGE]: page,
    });

    const text = textOf(await seoAgentApiSurface({ url: PAGE }));

    expect(text).toContain("API description: none found.");
    expect(text).toContain("Nothing in this tier is scored.");
    expect(text).toContain("this tier only applies to a site that publishes an API description");
    expect(text).not.toMatch(/^Score: 0\//m);
  });

  it("names where it looked, so 'none found' can be checked", async () => {
    serve({
      "example.com/robots.txt": { status: 404, body: "" },
      [PAGE]: page,
    });

    const text = textOf(await seoAgentApiSurface({ url: PAGE }));

    expect(text).toContain("/openapi.json");
  });

  it("measures the spec once it finds one", async () => {
    serve({
      "example.com/robots.txt": { status: 404, body: "" },
      [PAGE]: page,
      "https://example.com/openapi.json": {
        headers: { "content-type": "application/json" },
        body: JSON.stringify(SPEC),
      },
    });

    const text = textOf(await seoAgentApiSurface({ url: PAGE }));

    expect(text).toContain("API description: https://example.com/openapi.json");
    expect(text).toContain("OpenAPI 3.1.0, 1 operation");
    expect(text).toContain("✓ Every operation has a unique operationId");
    expect(text).toMatch(/^Score: \d+\/\d+$/m);
  });

  it("says out loud that every probe is a read-only GET", async () => {
    serve({
      "example.com/robots.txt": { status: 404, body: "" },
      [PAGE]: page,
    });

    const text = textOf(await seoAgentApiSurface({ url: PAGE }));

    expect(text).toContain("Nothing here authenticates, and nothing here writes.");
  });

  it("returns an error naming the input when the URL is not one", async () => {
    const result = await seoAgentApiSurface({ url: "not-a-url" });

    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("Invalid URL format");
  });
});
