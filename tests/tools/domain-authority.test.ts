import { describe, it, expect, afterEach, vi } from "vitest";
import domainAuthority from "@/tools/domain-authority";
import { readBulk } from "@/lib/open-pagerank";
import { requestsOf, serve } from "../helpers/serve";

/**
 * `domain_authority` against the response documented at
 * https://openpagerank.keywordseverywhere.com/docs (read 2026-09-24). A live
 * payload needs a key; the 401 below is the one the API gave without one, and
 * the rest follows the documented example and the OpenAPI spec's field list.
 */

/** The documented example, plus a year-ago point and a domain they do not rank. */
const A_COMPARISON = {
  as_of: "2026-06-01",
  count: 3,
  results: [
    {
      domain: "github.com",
      found: true,
      open_page_rank: 9.67,
      rank: 30,
      referring_domains: 282833,
      history: [
        { date: "2018-01-01", open_page_rank: 9.41, estimated: false },
        { date: "2025-06-01", open_page_rank: 9.5, estimated: false },
        { date: "2026-06-01", open_page_rank: 9.67, estimated: false },
      ],
    },
    { domain: "google.com", found: true, open_page_rank: 10, rank: 2, referring_domains: 2308810, history: [] },
    { domain: "zzqx-unknown.com", found: false, open_page_rank: null, rank: null, referring_domains: null },
  ],
  invalid: [],
};

/** The 401 the API returned, verbatim, to a request without a key. */
const UNAUTHORIZED = {
  error: {
    type: "authentication_error",
    message: "Missing OPR API key. Provide it as: Authorization: Bearer <api_key>",
  },
};

function answerWith(payload: unknown, status = 200) {
  return serve({
    "openpagerank.keywordseverywhere.com": {
      status,
      body: JSON.stringify(payload),
      headers: { "content-type": "application/json" },
    },
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

const textOf = (result: Awaited<ReturnType<typeof domainAuthority>>): string =>
  result.content.map((part) => part.text).join("\n");

function expectNoJunk(text: string): void {
  expect(text).not.toMatch(/NaN|undefined|Infinity|\[object Object\]/);
}

describe("domain_authority without the key configured", () => {
  it("refuses with the variable and where to get it, before any request", async () => {
    vi.stubEnv("OPEN_PAGERANK_API_KEY", undefined);
    const mock = answerWith(A_COMPARISON);

    const result = await domainAuthority({ domains: ["github.com"] });

    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("OPEN_PAGERANK_API_KEY is not set");
    expect(textOf(result)).toContain("https://openpagerank.keywordseverywhere.com/dashboard");
    expect(textOf(result)).toContain("30,000 domain lookups a month");
    expect(mock).not.toHaveBeenCalled();
  });
});

describe("domain_authority with the key configured", () => {
  it("asks for every domain in one request, with the key as a bearer token", async () => {
    vi.stubEnv("OPEN_PAGERANK_API_KEY", "opr_live_test");
    const mock = answerWith(A_COMPARISON);

    await domainAuthority({ domains: ["https://www.github.com/about", "google.com", "zzqx-unknown.com", "github.com"] });

    expect(mock).toHaveBeenCalledTimes(1);
    const [asked] = requestsOf(mock);
    expect(asked?.url).toBe("https://openpagerank.keywordseverywhere.com/v1/domains/bulk");
    expect(asked?.method).toBe("POST");
    expect(asked?.headers.authorization).toBe("Bearer opr_live_test");
    // `www.` is the site itself, and a repeat is asked for once.
    expect(asked?.json).toEqual({
      domains: ["github.com", "google.com", "zzqx-unknown.com"],
      include_history: true,
    });
  });

  it("compares highest first, with the rank, the referring domains and a year's change", async () => {
    vi.stubEnv("OPEN_PAGERANK_API_KEY", "opr_live_test");
    answerWith(A_COMPARISON);

    const text = textOf(await domainAuthority({ domains: ["github.com", "google.com", "zzqx-unknown.com"] }));

    expect(text).toContain("Data release: 2026-06-01");
    expect(text).toContain("google.com: 10.00 / 10, global rank #2, 2,308,810 referring domains");
    expect(text).toContain("github.com: 9.67 / 10, global rank #30, 282,833 referring domains");
    expect(text).toContain("A year earlier (2025-06-01): 9.50, +0.17");
    expect(text.indexOf("google.com:")).toBeLessThan(text.indexOf("github.com:"));
    expectNoJunk(text);
  });

  it("reports a domain outside their dataset as not ranked, never as zero", async () => {
    vi.stubEnv("OPEN_PAGERANK_API_KEY", "opr_live_test");
    answerWith(A_COMPARISON);

    const text = textOf(await domainAuthority({ domains: ["zzqx-unknown.com", "github.com"] }));

    expect(text).toContain("zzqx-unknown.com: not ranked");
    expect(text).toContain("not a score of zero");
    expect(text).not.toMatch(/zzqx-unknown\.com: 0/);
    // Ranked first, the unranked after.
    expect(text.indexOf("github.com:")).toBeLessThan(text.indexOf("zzqx-unknown.com:"));
  });

  it("says whose number this is, before any number", async () => {
    vi.stubEnv("OPEN_PAGERANK_API_KEY", "opr_live_test");
    answerWith(A_COMPARISON);

    const text = textOf(await domainAuthority({ domains: ["github.com"] }));

    const caveat = text.indexOf("It is not a Google metric");
    expect(caveat).toBeGreaterThan(-1);
    expect(caveat).toBeLessThan(text.indexOf("9.67"));
    expect(text).toContain("Common Crawl");
  });

  it("scores a subdomain on its own as well as its root", async () => {
    vi.stubEnv("OPEN_PAGERANK_API_KEY", "opr_live_test");
    answerWith({
      as_of: "2026-07-01",
      results: [
        {
          domain: "github.com",
          found: true,
          open_page_rank: 9.5,
          rank: 30,
          referring_domains: 282833,
          hosts: [{ host: "pages.github.com", found: true, open_page_rank: 9.15, rank: 1954, referring_hosts: 5888 }],
        },
      ],
    });

    const text = textOf(await domainAuthority({ domains: ["pages.github.com"] }));

    expect(text).toContain("pages.github.com (on github.com): 9.50 / 10");
    expect(text).toContain("pages.github.com itself: 9.15 / 10, rank #1,954 among hosts");
  });

  it("names a refused key by status, without forwarding the API's message", async () => {
    vi.stubEnv("OPEN_PAGERANK_API_KEY", "opr_live_wrong");
    answerWith(UNAUTHORIZED, 401);

    const result = await domainAuthority({ domains: ["github.com"] });

    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("Open PageRank API returned HTTP 401");
    expect(textOf(result)).not.toContain("Missing OPR API key");
  });

  it("says when the monthly allowance is spent", async () => {
    vi.stubEnv("OPEN_PAGERANK_API_KEY", "opr_live_test");
    answerWith({ error: { type: "quota_error", message: "Monthly domain limit reached" } }, 429);

    const result = await domainAuthority({ domains: ["github.com"] });

    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("returned HTTP 429");
  });

  it("refuses an input that names no domain, before any request", async () => {
    vi.stubEnv("OPEN_PAGERANK_API_KEY", "opr_live_test");
    const mock = answerWith(A_COMPARISON);

    const result = await domainAuthority({ domains: ["localhost"] });

    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain('"localhost" does not name a registrable domain');
    expect(mock).not.toHaveBeenCalled();
  });
});

describe("reading the payload", () => {
  it("does not believe a 'found' row with no score", () => {
    const read = readBulk({ results: [{ domain: "x.com", found: true, open_page_rank: "9" }] });
    expect(read.results[0]).toMatchObject({ found: false, score: null });
    expect(read.asOf).toBeNull();
  });
});
