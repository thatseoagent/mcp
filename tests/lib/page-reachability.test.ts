/**
 * The Reachability Gate.
 *
 * Auditing a URL that did not exist used to produce a full GEO report: 24
 * findings, 23 of them consequences of there being no page, with the one that
 * mattered — "HTTP 200 status code" — fourteenth in the list. The page fetch was
 * bundled into a `Promise.allSettled` with robots.txt and the sitemap, and a 404
 * resolves with a real status and the error page's body, so nothing stopped.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

import { fetchAuditablePage, resetPageCache } from "@/lib/page-reachability";

const realFetch = globalThis.fetch;
// Each case mocks its own response for the same URL, so the shared-request cache
// has to be dropped between them or the second case reads the first case's page.
beforeEach(() => { resetPageCache(); });
afterEach(() => { globalThis.fetch = realFetch; vi.restoreAllMocks(); });

const serve = (status: number, body = "<html><body>ok</body></html>", headers: Record<string, string> = {}) => {
  globalThis.fetch = vi.fn(async () => new Response(body, { status, headers })) as unknown as typeof fetch;
};

describe("a readable page", () => {
  it("returns the body and the headers", async () => {
    serve(200, "<html><body>hello</body></html>", { "x-test": "1", "Last-Modified": "now" });
    const r = await fetchAuditablePage("https://example.com/");

    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.status).toBe(200);
    expect(r.html).toContain("hello");
    // Header keys are lowercased so callers do not have to guess the casing.
    expect(r.headers["last-modified"]).toBe("now");
  });
});

describe("an unreadable page stops the audit", () => {
  it.each([
    [404, /no page here to audit/i],
    [410, /no page here to audit/i],
    [403, /behind authentication or blocking/i],
    [401, /behind authentication or blocking/i],
    [500, /server failed to serve/i],
    [503, /server failed to serve/i],
  ])("refuses HTTP %i and says why", async (status, expected) => {
    serve(status, "<html><body>Not found</body></html>");
    const r = await fetchAuditablePage("https://example.com/gone");

    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.status).toBe(status);
    expect(r.reason).toMatch(expected);
    // The reason names the status, so a reader does not have to read the code.
    expect(r.reason).toContain(String(status));
  });

  it("does not hand back the error page's body", async () => {
    serve(404, "<html><body>Our 404 page, with a nav and a footer</body></html>");
    const r = await fetchAuditablePage("https://example.com/gone");
    expect(r.ok).toBe(false);
    expect(r).not.toHaveProperty("html");
  });

  it("refuses a 200 with an empty body, which is not a page either", async () => {
    serve(200, "   \n  ");
    const r = await fetchAuditablePage("https://example.com/blank");
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.status).toBe(200);
    expect(r.reason).toMatch(/empty body/i);
  });

  it("reports a network failure as status 0 rather than inventing one", async () => {
    globalThis.fetch = vi.fn(async () => { throw new Error("ENOTFOUND"); }) as unknown as typeof fetch;
    const r = await fetchAuditablePage("https://nope.invalid/");
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.status).toBe(0);
    expect(r.reason).toMatch(/could not be reached/i);
  });

  it("distinguishes a timeout from a refusal", async () => {
    globalThis.fetch = vi.fn(async () => {
      const e = new Error("The operation was aborted");
      e.name = "AbortError";
      throw e;
    }) as unknown as typeof fetch;
    const r = await fetchAuditablePage("https://slow.example.com/", 5_000);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toMatch(/did not respond within 5s/i);
  });
});
