import { describe, it, expect, afterEach, vi } from "vitest";
import seoHreflangValidator from "@/tools/seo-hreflang-validator";
import { serve } from "../helpers/serve";
import { resetAllSingleFlightCaches } from "@/lib/single-flight";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
  resetAllSingleFlightCaches();
  vi.restoreAllMocks();
});

const textOf = (result: Awaited<ReturnType<typeof seoHreflangValidator>>): string =>
  result.content.map((part) => part.text).join("\n");

const withLinks = (links: string) => ({
  headers: { "content-type": "text/html" },
  body: `<html><head>${links}</head><body></body></html>`,
});

const alternate = (lang: string, href: string) =>
  `<link rel="alternate" hreflang="${lang}" href="${href}" />`;

/**
 * The handler's arguments as xmcp hands them over: every key present, optional
 * ones explicitly undefined. Calling the handler directly skips the schema, so
 * the defaults have to be written out.
 */
const run = (args: {
  url: string;
  checkBidirectional?: boolean;
  checkAccessibility?: boolean;
  sitemapUrl?: string;
}) =>
  seoHreflangValidator({
    checkBidirectional: undefined,
    checkAccessibility: undefined,
    sitemapUrl: undefined,
    ...args,
  });

describe("seo_hreflang_validator", () => {
  it("reads the tags and names the languages", async () => {
    serve({
      "example.com/robots.txt": { status: 404, body: "" },
      "https://example.com/en": withLinks(
        alternate("en", "https://example.com/en") + alternate("fr", "https://example.com/fr"),
      ),
      "https://example.com/fr": withLinks(
        alternate("en", "https://example.com/en") + alternate("fr", "https://example.com/fr"),
      ),
    });

    const text = textOf(await run({ url: "https://example.com/en" }));

    expect(text).toContain("Total hreflang tags: 2");
    expect(text).toContain("From HTML <link> tags:");
    expect(text).toContain("(fr): https://example.com/fr");
  });

  it("reports a missing self-reference", async () => {
    serve({
      "example.com/robots.txt": { status: 404, body: "" },
      "https://example.com/en": withLinks(alternate("fr", "https://example.com/fr")),
      "https://example.com/fr": withLinks(alternate("fr", "https://example.com/fr")),
    });

    const text = textOf(
      await run({
        url: "https://example.com/en",
        checkBidirectional: false,
        checkAccessibility: false,
      }),
    );

    expect(text).toContain("Self-referencing present: ✗");
  });

  it("rejects an underscore where Google wants a hyphen", async () => {
    serve({
      "example.com/robots.txt": { status: 404, body: "" },
      "https://example.com/en": withLinks(alternate("en_US", "https://example.com/en")),
    });

    const text = textOf(
      await run({
        url: "https://example.com/en",
        checkBidirectional: false,
        checkAccessibility: false,
      }),
    );

    expect(text).toContain("Language codes valid: ✗");
    expect(text).toContain("Invalid hreflang value: en_US");
  });

  it("says the accessibility check did not run rather than passing it", async () => {
    // The bug this pins: the field used to start at `true`, so a run that never
    // made a request still claimed every alternate was reachable.
    serve({
      "example.com/robots.txt": { status: 404, body: "" },
      "https://example.com/en": withLinks(
        alternate("en", "https://example.com/en") + alternate("fr", "https://example.com/fr"),
      ),
    });

    const text = textOf(
      await run({
        url: "https://example.com/en",
        checkBidirectional: false,
        checkAccessibility: false,
      }),
    );

    expect(text).toContain("URLs accessible: ? (not checked)");
  });

  it("flags an alternate that is not there", async () => {
    serve({
      "example.com/robots.txt": { status: 404, body: "" },
      "https://example.com/en": withLinks(
        alternate("en", "https://example.com/en") + alternate("fr", "https://example.com/fr"),
      ),
      "https://example.com/fr": { status: 404, body: "Not Found" },
    });

    const text = textOf(
      await run({
        url: "https://example.com/en",
        checkBidirectional: false,
        checkAccessibility: true,
      }),
    );

    expect(text).toContain("URLs accessible: ✗");
  });

  it("warns when an international setup has no x-default", async () => {
    serve({
      "example.com/robots.txt": { status: 404, body: "" },
      "https://example.com/en": withLinks(
        alternate("en", "https://example.com/en") + alternate("fr", "https://example.com/fr"),
      ),
    });

    const text = textOf(
      await run({
        url: "https://example.com/en",
        checkBidirectional: false,
        checkAccessibility: false,
      }),
    );

    expect(text).toContain("Has x-default: ✗");
    expect(text).toContain("Missing x-default");
  });

  it("returns an error naming the input when the URL is not one", async () => {
    const result = await run({ url: "not-a-url" });

    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("Invalid URL format");
  });
});
