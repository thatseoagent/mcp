import { describe, it, expect, afterEach, vi } from "vitest";
import seoSecurityHeaders from "@/tools/seo-security-headers";
import { resetHttpCaches } from "@/lib/http-client";
import { serve } from "../helpers/serve";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
  resetHttpCaches();
  vi.restoreAllMocks();
});

const textOf = (result: Awaited<ReturnType<typeof seoSecurityHeaders>>): string =>
  result.content.map((part) => part.text).join("\n");

const ALL_HEADERS = {
  "strict-transport-security": "max-age=31536000; includeSubDomains; preload",
  "content-security-policy": "default-src 'self'; object-src 'none'; base-uri 'self'",
  "x-frame-options": "DENY",
  "x-content-type-options": "nosniff",
  "referrer-policy": "strict-origin-when-cross-origin",
  "permissions-policy": "geolocation=(), camera=()",
};

describe("seo_security_headers", () => {
  it("grades a site that sends nothing and says what to add", async () => {
    serve({
      "example.com/robots.txt": { status: 404, body: "" },
      "https://example.com/": { body: "" },
    });

    const text = textOf(await seoSecurityHeaders({ url: "https://example.com/" }));

    expect(text).toContain("Grade: F");
    expect(text).toContain("Content-Security-Policy: ✗ Missing");
    expect(text).toContain("Add CSP (basic example):");
  });

  it("grades a site that sends the full set", async () => {
    serve({
      "example.com/robots.txt": { status: 404, body: "" },
      "https://example.com/": { headers: ALL_HEADERS, body: "" },
    });

    const text = textOf(await seoSecurityHeaders({ url: "https://example.com/" }));

    expect(text).toMatch(/Grade: A/);
    expect(text).toContain("Strict-Transport-Security: ✓ Present");
  });

  it("never charges an http:// site for the HSTS header it may not send", async () => {
    // RFC 6797 §7.2 forbids sending HSTS over plain http and §8.1 requires
    // browsers to ignore it. Scoring it as missing invented a defect and then
    // told the owner to fix it with a header that would do nothing.
    serve({
      "example.com/robots.txt": { status: 404, body: "" },
      "http://example.com/": { body: "" },
    });

    const text = textOf(await seoSecurityHeaders({ url: "http://example.com/" }));

    expect(text).toMatch(/Strict-Transport-Security: [–?]/);
    expect(text).not.toContain("Add HSTS (requires HTTPS):");
    expect(text).toContain("Serve the site over HTTPS");
  });

  it("reads the headers off a 404, because they are server configuration", async () => {
    serve({
      "example.com/robots.txt": { status: 404, body: "" },
      "https://example.com/gone": { status: 404, headers: ALL_HEADERS, body: "" },
    });

    const result = await seoSecurityHeaders({ url: "https://example.com/gone" });

    expect(result.isError).toBeUndefined();
    expect(textOf(result)).toContain("X-Frame-Options: ✓ Present");
  });

  it("says out loud what its CSP check does not cover", async () => {
    serve({
      "example.com/robots.txt": { status: 404, body: "" },
      "https://example.com/": { body: "" },
    });

    const text = textOf(await seoSecurityHeaders({ url: "https://example.com/" }));

    expect(text).toContain("does not fully validate CSP syntax or coverage");
  });

  it("returns an error naming the input when the URL is not one", async () => {
    const result = await seoSecurityHeaders({ url: "not-a-url" });

    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("Invalid URL format");
  });
});
