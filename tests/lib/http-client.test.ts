import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { validateUrl, fetchWithTimeout, fetchHtml } from "@/lib/http-client";
import { PAGE_AUDIT_USER_AGENT } from "@/lib/bot-identity";
import { expectPacedStarts } from "../helpers/pacing";
import { fetchAuditablePage } from "@/lib/page-reachability";
import { resetAllSingleFlightCaches } from "@/lib/single-flight";
import { requestsOf, serve } from "../helpers/serve";

// ── validateUrl ────────────────────────────────────────────────────────────

describe("validateUrl", () => {
  it("does not throw for a valid HTTP URL", () => {
    expect(() => validateUrl("http://example.com")).not.toThrow();
  });

  it("does not throw for a valid HTTPS URL", () => {
    expect(() => validateUrl("https://example.com/path?q=1")).not.toThrow();
  });

  it("throws for an invalid URL format", () => {
    expect(() => validateUrl("not-a-url")).toThrow("Invalid URL format");
  });

  it("throws when protocol is not http/https", () => {
    expect(() => validateUrl("ftp://example.com")).toThrow(
      "URL must use HTTP or HTTPS protocol"
    );
  });

  it("throws for javascript: protocol (XSS guard)", () => {
    expect(() => validateUrl("javascript:alert(1)")).toThrow();
  });
});

// ── The identity every fetch presents ──────────────────────────────────────
//
// Read from `bot-identity.ts` rather than through a re-export on the client: the
// module that owns the token is the one to assert against, and this client no
// longer re-exports it.

describe("PAGE_AUDIT_USER_AGENT", () => {
  it("presents the one product token, not the old SEO-MCP-Bot", () => {
    // Three different user agents used to reach third-party sites. One token now:
    // a `Disallow` under `User-agent: ThatSEOAgentBot` has to bind every fetch we
    // make, and it did not while page audits arrived under another name.
    expect(PAGE_AUDIT_USER_AGENT).toContain("ThatSEOAgentBot");
    expect(PAGE_AUDIT_USER_AGENT).not.toContain("SEO-MCP-Bot");
  });

  it("distinguishes a page audit from a bulk crawl", () => {
    expect(PAGE_AUDIT_USER_AGENT).toContain("page-audit");
  });

  it("points at documentation a webmaster can actually reach", () => {
    // The URL moved with the extraction: it used to point at a page on the site
    // that is shutting down, and a user agent whose URL 404s tells a webmaster
    // reading their logs nothing. The product token deliberately did not move.
    expect(PAGE_AUDIT_USER_AGENT).toContain("https://github.com/thatseoagent/mcp");
  });
});

// ── fetchWithTimeout ───────────────────────────────────────────────────────

describe("fetchWithTimeout", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("resolves with the response on success", async () => {
    serve({ "example.com": { body: "ok" } });

    const response = await fetchWithTimeout("https://example.com");
    expect(response.status).toBe(200);
  });

  it("sends the User-Agent header", async () => {
    const mock = serve({ "example.com": { body: "ok" } });

    await fetchWithTimeout("https://example.com");
    // The page's request, after the robots.txt read the gate makes first.
    const page = requestsOf(mock).find((request) => !request.url.endsWith("/robots.txt"));
    expect(page?.headers["user-agent"]).toBe(PAGE_AUDIT_USER_AGENT);
  });

  it("throws on non-2xx response", async () => {
    serve({ "/robots.txt": { status: 404 }, "example.com": { status: 404, body: "Not Found" } });

    await expect(fetchWithTimeout("https://example.com")).rejects.toThrow("HTTP 404");
  });

  it("throws a timeout error when the site does not answer within the budget", async () => {
    // The page hangs until the client's own signal fires, so this fails if the
    // client stops setting a timeout — not only if it stops translating one.
    serve({ "/robots.txt": { status: 404 }, "example.com": { hang: true } });

    await expect(fetchWithTimeout("https://example.com", 100)).rejects.toThrow(
      "Request timeout after 100ms"
    );
  });
});

// ── What every fetch owes the site at the other end ───────────────────────────

describe("clearToFetch binds every fetch, not only the crawler", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    resetAllSingleFlightCaches();
  });

  it("refuses a URL the site's robots.txt disallows for us", async () => {
    serve({
      "/robots.txt": { body: "User-agent: ThatSEOAgentBot\nDisallow: /private/\n" },
      "example.com": { body: "<html></html>" },
    });

    await expect(fetchWithTimeout("https://example.com/private/page")).rejects.toThrow(
      /robots\.txt disallows/,
    );
  });

  it("spaces its requests to one origin", async () => {
    // `crawl-pacing` has its own unit tests; none of them would fail if this
    // client stopped calling it. This one would.
    const startedAt: number[] = [];
    serve({
      "example.com": () => {
        startedAt.push(Date.now());
        return { body: "ok" };
      },
    });

    await fetchWithTimeout("https://example.com/one");
    await fetchWithTimeout("https://example.com/two");

    // Three: the robots.txt read the gate makes, then the two pages. It is
    // paced too — it is a connection to somebody else's server like any other.
    expect(startedAt.length).toBe(3);
    expectPacedStarts(startedAt);
  });
});

// ── One request per page, however many analyzers want it ──────────────────────

/**
 * How many times one exact URL was asked for.
 *
 * A bare call count stopped being the question once every fetch began clearing
 * itself with the site's robots.txt first: the counts below would then be
 * measuring the gate rather than the deduplication these tests exist to pin.
 */
function timesFetched(fetchMock: { mock: { calls: unknown[][] } }, url: string): number {
  return fetchMock.mock.calls.filter((call) => String(call[0]) === url).length;
}

describe("one turn fetches each document once", () => {
  beforeEach(() => {
    resetAllSingleFlightCaches();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    resetAllSingleFlightCaches();
  });

  /**
   * The shape a refresh actually has: every subtask launched in one
   * `Promise.allSettled`, so all of them reach the cache before any of them
   * fills it. The old cache read the resolved value and therefore missed every
   * time, and the same homepage went out a dozen times to a customer's server.
   */
  it("serves twelve concurrent analyzers from one request", async () => {
    const fetchMock = serve({ "example.com": { body: "<html>page</html>" } });

    const results = await Promise.all(
      Array.from({ length: 12 }, () => fetchHtml("https://example.com/"))
    );

    expect(new Set(results).size).toBe(1);
    expect(timesFetched(fetchMock, "https://example.com/")).toBe(1);
  });

  it("shares one request between the HTML fetcher and the reachability check", async () => {
    const fetchMock = serve({ "example.com": { body: "<html>page</html>" } });

    // geo-tools and ai-visibility-tools both ask for the page this way.
    const [a, b] = await Promise.all([
      fetchAuditablePage("https://example.com/"),
      fetchAuditablePage("https://example.com/"),
    ]);

    expect(a.ok && b.ok).toBe(true);
    expect(timesFetched(fetchMock, "https://example.com/")).toBe(1);
  });

  it("keeps separate documents separate", async () => {
    const fetchMock = serve({ "example.com": { body: "body" } });

    await Promise.all([
      fetchHtml("https://example.com/"),
      fetchHtml("https://example.com/robots.txt"),
      fetchHtml("https://example.com/llms.txt"),
    ]);

    expect(timesFetched(fetchMock, "https://example.com/")).toBe(1);
    expect(timesFetched(fetchMock, "https://example.com/llms.txt")).toBe(1);
    // Twice, and both are correct: the robots gate reads it once for the origin
    // before letting the other two through, and the caller asked for it as a
    // document in its own right. Deduplicating those against each other would
    // mean the gate handing a caller bytes it fetched for a different purpose.
    expect(timesFetched(fetchMock, "https://example.com/robots.txt")).toBe(2);
  });
});
