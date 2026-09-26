import { describe, it, expect, afterEach, vi } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import waybackHistory from "@/tools/wayback-history";
import { readCaptures } from "@/lib/wayback-cdx";
import { requestsOf, serve, type Route } from "../helpers/serve";

/**
 * `wayback_history` against payloads captured from the live CDX server on
 * 2026-09-24 (`tests/tools/fixtures/wayback-cdx-*.json`), trimmed where noted.
 */

const fixture = (name: string): string =>
  readFileSync(path.resolve(__dirname, "fixtures", name), "utf8");

const VERSIONS = fixture("wayback-cdx-versions.json");
const LATEST = fixture("wayback-cdx-latest.json");
/** A trimmed prefix read of backlinko.com/hub/: nine URLs that answered 200. */
const PREFIX_200 = fixture("wayback-cdx-prefix-200.json");
/** The same prefix's 404/410 read, trimmed to three URLs. */
const PREFIX_404 = fixture("wayback-cdx-prefix-404.json");

/**
 * The CDX endpoint. Its two reads share this path and differ only in their
 * parameters, so a route that must tell them apart is a function of the request.
 */
const CDX = "https://web.archive.org/cdx/search/cdx";

const isCdx = (url: URL) => url.hostname === "web.archive.org" && url.pathname === "/cdx/search/cdx";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const textOf = (result: Awaited<ReturnType<typeof waybackHistory>>): string =>
  result.content.map((part) => part.text).join("\n");

const run = (args: {
  url: string;
  scope?: "url" | "prefix" | "domain";
  from?: string;
  to?: string;
  live_checks?: number;
}) => waybackHistory({ scope: undefined, from: undefined, to: undefined, live_checks: undefined, ...args });

function expectNoJunk(text: string): void {
  expect(text).not.toMatch(/NaN|undefined|Infinity|\[object Object\]/);
}

describe("wayback_history for one URL", () => {
  const answerVersions = () =>
    serve({
      [CDX]: (request) => ({ body: request.searchParams.get("fastLatest") === "true" ? LATEST : VERSIONS }),
    });

  it("asks the index for content versions, then for the latest capture", async () => {
    const mock = answerVersions();

    await run({ url: "https://backlinko.com/11-advanced-seo-hacks" });

    const asked = mock.mock.calls.map((call) => new URL(String(call[0])));
    expect(asked).toHaveLength(2);
    expect(asked[0]?.searchParams.get("collapse")).toBe("digest");
    expect(asked[0]?.searchParams.get("fl")).toBe("urlkey,timestamp,original,mimetype,statuscode,digest,length");
    expect(asked[0]?.searchParams.get("output")).toBe("json");
    expect(asked[1]?.searchParams.get("limit")).toBe("-1");
    // A fixed API: never asked robots.txt, and identified by our agent.
    expect(asked.every(isCdx)).toBe(true);
    expect(requestsOf(mock)[0]?.headers["user-agent"]).toContain("ThatSEOAgentBot");
  });

  it("reports first and latest capture, the versions and the status history", async () => {
    answerVersions();

    const text = textOf(await run({ url: "https://backlinko.com/11-advanced-seo-hacks" }));

    expect(text).toContain("First capture: 2017-02-06 (HTTP 200)");
    expect(text).toContain("Latest capture: 2025-02-11 (HTTP 200)");
    expect(text).toContain("Content versions: 24 —");
    expect(text).toContain("HTTP 200 from 2017-02-06 until 2017-09-14 — 18 versions");
    expect(text).toContain("HTTP 301 from 2017-09-14 until 2018-07-19 — 1 version");
    expect(text).toContain("HTTP 200 from 2018-07-19 (still so at the latest capture)");
    expect(text).toContain("The status changed 2 times");
    expect(text).toContain("https://web.archive.org/web/20250211211723/https://backlinko.com/11-advanced-seo-hacks");
    expect(text).toContain("... and 9 more versions.");
    expectNoJunk(text);
  });

  it("says archive coverage is not site history, where every Tool says what its answer rests on", async () => {
    answerVersions();

    const text = textOf(await run({ url: "https://backlinko.com/11-advanced-seo-hacks" }));
    const basis = text.slice(text.indexOf("=== WHAT THIS IS BASED ON ==="));

    expect(text).toContain("=== WHAT THIS IS BASED ON ===");
    expect(basis).toContain("from the Internet Archive's CDX index");
    expect(basis).toContain("Archive coverage is not site history");
  });

  it("answers, rather than erroring, when the archive has nothing — and says whose fact that is", async () => {
    const mock = serve({ [CDX]: { body: "[]" } });

    const result = await run({ url: "https://example.com/never-archived" });

    expect(result.isError).toBeUndefined();
    expect(textOf(result)).toContain("holds no capture of this URL");
    expect(textOf(result)).toContain("a fact about the");
    // Nothing to find the latest of, so no second request.
    expect(mock).toHaveBeenCalledTimes(1);
  });

  it("says where a truncated read stopped, and how to read further", async () => {
    const header = ["urlkey", "timestamp", "original", "mimetype", "statuscode", "digest", "length"];
    const rows = Array.from({ length: 1_000 }, (_, i) => [
      "com,example)/",
      `2010${String(Math.floor(i / 28) % 12 + 1).padStart(2, "0")}${String((i % 28) + 1).padStart(2, "0")}000000`,
      "https://example.com/",
      "text/html",
      "200",
      `DIGEST${i}`,
      "1000",
    ]);
    serve({
      [CDX]: (request) => ({
        body: JSON.stringify(request.searchParams.get("fastLatest") ? [header, rows[999]] : [header, ...rows]),
      }),
    });

    const text = textOf(await run({ url: "https://example.com/" }));

    expect(text).toContain("Content versions: 1000+");
    expect(text).toContain("more than 1,000 versions");
    expect(text).toContain("Pass `from`");
    expect(text).toContain("(the read stopped here)");
  });

  it("passes the window through as given", async () => {
    const mock = serve({ [CDX]: { body: "[]" } });

    await run({ url: "https://example.com/", from: "2018", to: "202003" });

    const asked = new URL(String(mock.mock.calls[0]?.[0]));
    expect(asked.searchParams.get("from")).toBe("2018");
    expect(asked.searchParams.get("to")).toBe("202003");
  });

  it("refuses a window that ends before it starts", async () => {
    const mock = serve({});

    const result = await run({ url: "https://example.com/", from: "2021", to: "2019" });

    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("from (2021) is after to (2019)");
    expect(mock).not.toHaveBeenCalled();
  });
});

describe("wayback_history when the archive does not answer", () => {
  it("reports a refusal by status, without the archive's body", async () => {
    serve({ [CDX]: { status: 429, body: "Slow down, robot" } });

    const result = await run({ url: "https://example.com/" });

    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("Wayback CDX API returned HTTP 429");
    expect(textOf(result)).not.toContain("Slow down");
  });
});

describe("wayback_history across a prefix", () => {
  const SITE = "https://backlinko.com";

  /** The archive, plus the live site as it answers now. */
  function answerPrefix(live: Record<string, Route>, robots = "User-agent: *\nAllow: /") {
    return serve({
      [CDX]: (request) => ({
        body: request.searchParams.getAll("filter").includes("statuscode:200") ? PREFIX_200 : PREFIX_404,
      }),
      [`${SITE}/robots.txt`]: { body: robots },
      [SITE]: (request) =>
        live[new URL(request.url).pathname] ?? {
          status: 200,
          body: "<html>ok</html>",
          headers: { "content-type": "text/html" },
        },
    });
  }

  it("asks for one row per URL, once for 200s and once for 404s and 410s", async () => {
    const mock = answerPrefix({});

    await run({ url: `${SITE}/hub/`, scope: "prefix", live_checks: 0 });

    const cdx = mock.mock.calls.map((call) => new URL(String(call[0]))).filter(isCdx);
    expect(cdx).toHaveLength(2);
    for (const asked of cdx) {
      expect(asked.searchParams.get("matchType")).toBe("prefix");
      expect(asked.searchParams.get("collapse")).toBe("urlkey");
      expect(asked.searchParams.get("limit")).toBe("1000");
    }
    expect(cdx[0]?.searchParams.getAll("filter")).toEqual(["statuscode:200", "mimetype:text/html"]);
    expect(cdx[1]?.searchParams.getAll("filter")).toEqual(["statuscode:40[40]"]);
  });

  it("finds the page the archive saw die, checks it first, and reports it lost", async () => {
    answerPrefix({
      "/hub/content/viral": { status: 404, body: "gone", headers: { "content-type": "text/html" } },
      "/hub/content": { status: 301, headers: { location: `${SITE}/hub/` } },
    });

    const text = textOf(await run({ url: `${SITE}/hub/`, scope: "prefix" }));

    expect(text).toContain("URLs the archive saw answering 200 with HTML: 7 (2 more skipped");
    expect(text).toContain("Of those, later captured answering 404 or 410: 1");
    expect(text).toContain("Lost — answering 404 or 410 now: 1");
    expect(text).toContain(
      `${SITE}/hub/content/viral — HTTP 404 now; archived 200 on 2020-02-28, archived HTTP 404 on 2021-01-03`,
    );
    expect(text).toContain("https://web.archive.org/web/20200228222008/https://backlinko.com/hub/content/viral");
    expect(text).toContain(`${SITE}/hub/content → ${SITE}/hub/, HTTP 200`);
    expect(text).toContain("Still answering 2xx: 5");
    expectNoJunk(text);
  });

  it("does not report as lost what nobody published: query variants, assets, a neighbouring path", async () => {
    const mock = answerPrefix({});

    const text = textOf(await run({ url: `${SITE}/hub/`, scope: "prefix" }));

    const fetched = mock.mock.calls.map((call) => String(call[0])).filter((u) => u.startsWith(SITE));
    expect(fetched.some((u) => u.includes("gtm.js"))).toBe(false);
    expect(fetched.some((u) => u.includes("?ref="))).toBe(false);
    // `/hub/` matched `/hubspot-users` in the archive's key; the real path decides.
    expect(fetched.some((u) => u.includes("hubspot"))).toBe(false);
    expect(text).not.toContain("hubspot");
  });

  it("states how many it fetched, and calls the rest unknown rather than fine", async () => {
    answerPrefix({ "/hub/content/viral": { status: 410 } });

    const text = textOf(await run({ url: `${SITE}/hub/`, scope: "prefix", live_checks: 2 }));

    expect(text).toContain("LIVE CHECK (2 of 7 fetched now");
    expect(text).toContain("Not fetched: 5 archived URL(s). Their live status is unknown, not fine.");
    expect(text).toContain("HTTP 410 now");
  });

  it("reports a URL robots.txt keeps us from as not checked, not as lost or live", async () => {
    answerPrefix({}, "User-agent: *\nDisallow: /hub/");

    const result = await run({ url: `${SITE}/hub/`, scope: "prefix", live_checks: 3 });
    const text = textOf(result);

    expect(result.isError).toBeUndefined();
    expect(text).toContain("=== NOT CHECKED (3) ===");
    expect(text).toContain(" — robots.txt disallows this URL for our crawler, so it was not fetched");
    expect(text).toContain("Still answering 2xx: 0");
    expect(text).not.toContain("Lost —");
  });

  it("answers when the archive holds nothing under the path", async () => {
    serve({ [CDX]: { body: "[]" } });

    const result = await run({ url: "https://example.com/blog/", scope: "prefix" });

    expect(result.isError).toBeUndefined();
    expect(textOf(result)).toContain("holds no capture that answered 200 with HTML here");
    expect(textOf(result)).toContain("a fact about the archive's coverage");
  });

  it("reads a domain by its host alone, subdomains included", async () => {
    const mock = serve({ [CDX]: { body: "[]" } });

    await run({ url: "https://www.example.com/some/page", scope: "domain" });

    const asked = new URL(String(mock.mock.calls[0]?.[0]));
    expect(asked.searchParams.get("url")).toBe("www.example.com");
    expect(asked.searchParams.get("matchType")).toBe("domain");
  });
});

describe("reading the CDX payload", () => {
  it("reads rows by the header's names, and a '-' status as no status rather than NaN", () => {
    const captures = readCaptures([
      ["timestamp", "statuscode", "original"],
      ["20200101000000", "-", "https://example.com/"],
      ["not-a-date", "200", "https://example.com/"],
    ]);

    expect(captures).toHaveLength(1);
    expect(captures[0]?.status).toBeNull();
    expect(captures[0]?.length).toBeNull();
  });
});
