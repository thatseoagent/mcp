import { describe, it, expect, afterEach, vi } from "vitest";
import seoLlmsTxt from "@/tools/seo-llms-txt";
import { serve } from "../helpers/serve";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
});

const textOf = (result: Awaited<ReturnType<typeof seoLlmsTxt>>): string =>
  result.content.map((part) => part.text).join("\n");

/** The handler's arguments as xmcp hands them over: optional keys present. */
const run = (args: { url: string; generate?: boolean }) =>
  seoLlmsTxt({ generate: undefined, ...args });

const A_GOOD_FILE = [
  "# Example",
  "> What this site is about.",
  "",
  "## Key Content",
  "",
  "- [One](https://example.com/one): The first page",
  "- [Two](https://example.com/two): The second page",
  "- [Three](https://example.com/three): The third page",
  "",
  "## Optional",
  "",
  "- [Privacy](https://example.com/privacy): Privacy policy",
].join("\n");

const page = (title: string) => ({
  headers: { "content-type": "text/html" },
  body: `<html><head><title>${title}</title></head><body><h1>${title}</h1><p>Real content.</p></body></html>`,
});

describe("seo_llms_txt", () => {
  it("scores a complete file and says which links resolve", async () => {
    serve({
      "https://example.com/robots.txt": { status: 404, body: "" },
      "https://example.com/llms.txt": { body: A_GOOD_FILE },
      "https://example.com/llms-full.txt": { status: 404, body: "" },
      "https://example.com/": page("Example"),
      "https://example.com/one": page("One"),
      "https://example.com/two": page("Two"),
      "https://example.com/three": page("Three"),
      "https://example.com/privacy": page("Privacy"),
    });

    const text = textOf(await run({ url: "https://example.com" }));

    expect(text).toContain("Status: FOUND (HTTP 200)");
    expect(text).toContain("Optional section: present");
    expect(text).toMatch(/Score: \d+\/100/);
    expect(text).toContain("Grade: Excellent");
  });

  it("never reports an unreadable file as an absent one", async () => {
    // The whole reason this Tool reads through `well-known`: a 503 is not a
    // site without an llms.txt, and telling it to create one is a confident lie.
    serve({
      "https://example.com/robots.txt": { status: 404, body: "" },
      "https://example.com/llms.txt": { status: 503, body: "" },
      "https://example.com/llms-full.txt": { status: 404, body: "" },
    });

    const text = textOf(await run({ url: "https://example.com" }));

    expect(text).toContain("Status: NOT ESTABLISHED");
    expect(text).toContain("nothing to score until the file is read");
    expect(text).not.toContain("Status: NOT FOUND");
    expect(text).not.toContain("Score: 0/100");
  });

  it("generates a file from the site's own pages when there is none", async () => {
    serve({
      "https://example.com/robots.txt": { status: 404, body: "" },
      "https://example.com/llms.txt": { status: 404, body: "" },
      "https://example.com/llms-full.txt": { status: 404, body: "" },
      "https://example.com/sitemap.xml": {
        headers: { "content-type": "application/xml" },
        body: `<?xml version="1.0"?><urlset><url><loc>https://example.com/about</loc></url></urlset>`,
      },
      "https://example.com/about": page("About Us"),
      "https://example.com/": page("Example Home"),
    });

    const text = textOf(await run({ url: "https://example.com" }));

    expect(text).toContain("Status: NOT FOUND");
    expect(text).toContain("=== GENERATED llms.txt (ready to use) ===");
    // Read from the page's own <title>, never guessed from the slug.
    expect(text).toContain("[About Us](https://example.com/about)");
  });

  it("never declares a URL nobody has seen", async () => {
    // The generator used to hardcode /privacy and /terms on every site, so it
    // handed the Operator a file this same Tool would then fail them for.
    serve({
      "https://example.com/robots.txt": { status: 404, body: "" },
      "https://example.com/llms.txt": { status: 404, body: "" },
      "https://example.com/llms-full.txt": { status: 404, body: "" },
      "https://example.com/": page("Example Home"),
    });

    const text = textOf(await run({ url: "https://example.com" }));

    expect(text).not.toContain("https://example.com/privacy");
    expect(text).not.toContain("https://example.com/terms");
    expect(text).toContain("Could not read the sitemap");
  });

  it("reports a declared link that goes nowhere", async () => {
    serve({
      "https://example.com/robots.txt": { status: 404, body: "" },
      "https://example.com/llms.txt": { body: A_GOOD_FILE },
      "https://example.com/llms-full.txt": { status: 404, body: "" },
      "https://example.com/": page("Example"),
      "https://example.com/one": page("One"),
      "https://example.com/two": page("Two"),
      "https://example.com/three": { status: 404, body: "Not Found" },
      "https://example.com/privacy": page("Privacy"),
    });

    const text = textOf(await run({ url: "https://example.com" }));

    expect(text).toContain("do not reach real content");
    expect(text).toContain("https://example.com/three");
  });

  it("accepts a bare hostname", async () => {
    serve({
      "https://example.com/robots.txt": { status: 404, body: "" },
      "https://example.com/llms.txt": { status: 404, body: "" },
      "https://example.com/llms-full.txt": { status: 404, body: "" },
      "https://example.com/": page("Example Home"),
    });

    const text = textOf(await run({ url: "example.com" }));

    expect(text).toContain("URL checked: https://example.com/llms.txt");
  });

  it("returns an error naming the input when the URL is not one", async () => {
    const result = await run({ url: "not a url at all" });

    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("Invalid URL format");
  });
});
