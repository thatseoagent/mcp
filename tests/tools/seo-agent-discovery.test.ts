import { describe, it, expect, afterEach, vi } from "vitest";
import seoAgentDiscovery from "@/tools/seo-agent-discovery";
import { serve } from "../helpers/serve";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
});

/**
 * The audited URL is a path, not the root, and that is a fixture constraint
 * rather than a preference: `serve()` falls back to substring matching, and
 * `https://example.com/` is a substring of every well-known path this tier
 * probes — so a root route would answer all of them with the homepage.
 */
const PAGE = "https://example.com/page";

const textOf = (result: Awaited<ReturnType<typeof seoAgentDiscovery>>): string =>
  result.content.map((part) => part.text).join("\n");

describe("seo_agent_discovery", () => {
  it("does not charge a site for artifacts it has chosen not to publish", async () => {
    // The whole frame of this tier: a plain site publishes none of these, and
    // reporting that as a failing score would be a verdict on a site that never
    // entered the contest.
    serve({
      "example.com/robots.txt": { status: 404, body: "" },
      [PAGE]: { headers: { "content-type": "text/html" }, body: "<html></html>" },
    });

    const text = textOf(await seoAgentDiscovery({ url: PAGE }));

    expect(text).toContain("This tier only ever ADDS");
    expect(text).toContain("You publish none of these artifacts");
    expect(text).toContain("Nothing to fix.");
  });

  it("says out loud that it judges the payload, not the status code", async () => {
    serve({
      "example.com/robots.txt": { status: 404, body: "" },
      [PAGE]: { headers: { "content-type": "text/html" }, body: "<html></html>" },
    });

    const text = textOf(await seoAgentDiscovery({ url: PAGE }));

    expect(text).toContain("validates the payload, not the status");
  });

  it("reproduces every finding with the request that produced it", async () => {
    serve({
      "example.com/robots.txt": { status: 404, body: "" },
      [PAGE]: { headers: { "content-type": "text/html" }, body: "<html></html>" },
    });

    const text = textOf(await seoAgentDiscovery({ url: PAGE }));

    expect(text).toContain("Reproduce: curl");
  });

  it("credits a site that publishes a structurally complete server card", async () => {
    serve({
      "example.com/robots.txt": { status: 404, body: "" },
      [PAGE]: { headers: { "content-type": "text/html" }, body: "<html></html>" },
      "https://example.com/.well-known/mcp/server-card.json": {
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          name: "example",
          description: "An MCP server for example.com",
          version: "1.0.0",
          endpoint: "https://example.com/mcp",
          transport: "streamable-http",
        }),
      },
    });

    const text = textOf(await seoAgentDiscovery({ url: PAGE }));

    expect(text).toContain("MCP server card is complete");
    expect(text).not.toContain("You publish none of these artifacts");
  });

  it("returns an error naming the input when the URL is not one", async () => {
    const result = await seoAgentDiscovery({ url: "not-a-url" });

    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("Invalid URL format");
  });
});
