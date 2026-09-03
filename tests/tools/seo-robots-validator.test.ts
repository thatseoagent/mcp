import { describe, it, expect, afterEach, vi } from "vitest";
import seoRobotsValidator from "@/tools/seo-robots-validator";
import { serve } from "../helpers/serve";

/**
 * What the agent is told, which is the only thing it can act on.
 *
 * The retired suite asserted against a `_structured` field the MCP client never
 * received — the caching layer stripped it before responding — so those
 * assertions could all pass while the text an agent reads said something else.
 * These assert the rendered output instead.
 */

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
});

const textOf = (result: Awaited<ReturnType<typeof seoRobotsValidator>>): string =>
  result.content.map((part) => part.text).join("\n");

describe("seo_robots_validator", () => {
  it("reports a blocked AI crawler by name", async () => {
    serve({ "example.com/robots.txt": { body: "User-agent: GPTBot\nDisallow: /\n" } });

    const text = textOf(await seoRobotsValidator({ url: "https://example.com/" }));

    expect(text).toContain("Blocks AI crawlers: Yes");
    expect(text).toMatch(/Blocked AI crawlers:[\s\S]*GPTBot/);
  });

  it("warns when the whole site is closed to crawlers", async () => {
    serve({ "example.com/robots.txt": { body: "User-agent: *\nDisallow: /\n" } });

    const text = textOf(await seoRobotsValidator({ url: "https://example.com/" }));

    expect(text).toContain("Blocks site-wide: Yes");
    expect(text).toContain("Allows Googlebot: No");
    expect(text).toContain("Googlebot is blocked");
  });

  it("lists a declared sitemap", async () => {
    serve({
      "example.com/robots.txt": {
        body: "User-agent: *\nDisallow: /admin/\n\nSitemap: https://example.com/sitemap.xml\n",
      },
    });

    const text = textOf(await seoRobotsValidator({ url: "https://example.com/" }));

    expect(text).toContain("https://example.com/sitemap.xml");
  });

  it("tells the Operator what a missing robots.txt means rather than erroring", async () => {
    serve({ "example.com/robots.txt": { status: 404, body: "Not Found" } });

    const result = await seoRobotsValidator({ url: "https://example.com/" });

    expect(result.isError).toBeUndefined();
    expect(textOf(result)).toContain("Exists: No");
    expect(textOf(result)).toContain("All crawlers can access all pages");
  });

  it("treats a 410 on robots.txt the same as a 404", async () => {
    // 410 Gone is a site saying the file was deliberately removed, which is the
    // same fact as "there is no robots.txt" and the same advice follows from it.
    serve({ "example.com/robots.txt": { status: 410, body: "Gone" } });

    const result = await seoRobotsValidator({ url: "https://example.com/" });

    expect(result.isError).toBeUndefined();
    expect(textOf(result)).toContain("Exists: No");
  });

  it("reads an empty robots.txt as restricting nothing", async () => {
    serve({ "example.com/robots.txt": { body: "" } });

    const text = textOf(await seoRobotsValidator({ url: "https://example.com/" }));

    expect(text).toContain("Blocks site-wide: No");
    expect(text).toContain("Blocks AI crawlers: No");
  });

  it("recommends declaring a sitemap when none is present", async () => {
    serve({ "example.com/robots.txt": { body: "User-agent: *\nDisallow: /admin/\n" } });

    const text = textOf(await seoRobotsValidator({ url: "https://example.com/" }));

    expect(text).toContain("No sitemap declared in robots.txt");
  });

  // ── The failure posture ─────────────────────────────────────────────────────
  //
  // These two are the reason the seam in define-tool exists. An exception
  // escaping the handler reaches the agent as a transport failure it cannot
  // relay; these assert it arrives as readable text instead.

  it("refuses a private address and says so, rather than crashing", async () => {
    const text = textOf(await seoRobotsValidator({ url: "http://169.254.169.254/" }));

    expect(text).toContain("private/reserved address");
  });

  it("names a malformed URL as the caller's problem", async () => {
    const result = await seoRobotsValidator({ url: "not-a-url" });

    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("Invalid URL");
  });

  it("returns text, never throws, when the network fails outright", async () => {
    globalThis.fetch = vi.fn(async () => {
      throw new Error("ECONNREFUSED 10.0.0.5:5432");
    }) as unknown as typeof fetch;

    const result = await seoRobotsValidator({ url: "https://example.com/" });

    expect(result.isError).toBe(true);
    // Not our sentence, so it must not be forwarded.
    expect(textOf(result)).not.toContain("ECONNREFUSED");
    expect(textOf(result)).toContain("validate the robots.txt for this site");
  });
});
