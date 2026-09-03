import { describe, it, expect, afterEach, vi } from "vitest";
import seoAgentNavigability from "@/tools/seo-agent-navigability";
import { PROBE_PATH } from "@/lib/analyzers/agent-probe";
import { serve } from "../helpers/serve";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
});

/**
 * A path, not the root: `serve()` falls back to substring matching, and
 * `https://example.com/` is a substring of every probe this tier makes.
 */
const PAGE = "https://example.com/page";

const textOf = (result: Awaited<ReturnType<typeof seoAgentNavigability>>): string =>
  result.content.map((part) => part.text).join("\n");

const html = (body: string) => ({
  headers: { "content-type": "text/html" },
  body: `<html><head><title>Page</title></head><body>${body}</body></html>`,
});

describe("seo_agent_navigability", () => {
  it("passes a site whose missing paths return a real 404", async () => {
    serve({
      "example.com/robots.txt": { status: 404, body: "" },
      [PAGE]: html("<h1>Page</h1><p>Some words on the page.</p>"),
      [`https://example.com${PROBE_PATH}`]: { status: 404, body: "Not Found" },
    });

    const text = textOf(await seoAgentNavigability({ url: PAGE }));

    expect(text).toContain("✓ A path that does not exist returns 404");
  });

  it("catches a soft 404 — an app shell answering 200 for every path", async () => {
    serve({
      "example.com/robots.txt": { status: 404, body: "" },
      [PAGE]: html("<h1>Page</h1>"),
      [`https://example.com${PROBE_PATH}`]: html("<h1>App</h1>"),
    });

    const text = textOf(await seoAgentNavigability({ url: PAGE }));

    expect(text).toContain("✗ A path that does not exist returns 404");
    expect(text).toContain("=== WHAT TO FIX ===");
  });

  it("states every finding as an HTTP assertion, not a ranking claim", async () => {
    serve({
      "example.com/robots.txt": { status: 404, body: "" },
      [PAGE]: html("<h1>Page</h1>"),
      [`https://example.com${PROBE_PATH}`]: { status: 404, body: "Not Found" },
    });

    const text = textOf(await seoAgentNavigability({ url: PAGE }));

    expect(text).toContain("not a claim about ranking or citation");
    expect(text).toContain("Reproduce: curl");
  });

  it("keeps points it could not evaluate out of both sides of the score", async () => {
    serve({
      "example.com/robots.txt": { status: 404, body: "" },
      [PAGE]: html("<h1>Page</h1>"),
      [`https://example.com${PROBE_PATH}`]: { status: 404, body: "Not Found" },
    });

    const text = textOf(await seoAgentNavigability({ url: PAGE }));

    // Either qualifier may be absent on a clean run; when present it has to say
    // that the points left the denominator too, which is the whole distinction.
    for (const line of text.split("\n")) {
      if (line.startsWith("Coverage:") || line.startsWith("Not applicable:")) {
        expect(line).toContain("excluded from both sides");
      }
    }
  });

  it("returns an error naming the input when the URL is not one", async () => {
    const result = await seoAgentNavigability({ url: "not-a-url" });

    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("Invalid URL format");
  });
});
