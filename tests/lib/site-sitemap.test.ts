import { describe, it, expect, afterEach, vi } from "vitest";
import { gzipSync } from "node:zlib";
import {
  findSitemaps,
  readSitemaps,
  describeSitemapRead,
  entryFor,
  listingFor,
  type SitemapRead,
} from "@/lib/site-sitemap";
import { fakeGoogleReader } from "@/lib/google/fake-reader";
import { UpstreamApiError } from "@/lib/upstream-api-error";
import { resetAllSingleFlightCaches } from "@/lib/single-flight";
import { restoreFetch, serve } from "../helpers/serve";

/**
 * The one sitemap reader.
 *
 * `sitemap-parser.ts` had its own suite, and most of what it pinned was learned
 * the hard way behind a caller that turned every throw into `[]`: an empty
 * `<urlset>` that crashed, a lone `<url>` parsed as an object, one 404 child
 * failing a whole index. Those cases are here now, against the reader every
 * sitemap-consuming Tool shares.
 */

afterEach(() => {
  restoreFetch();
  vi.restoreAllMocks();
});

const XMLNS = "http://www.sitemaps.org/schemas/sitemap/0.9";

const urlset = (...urls: Array<[string, string?]>) =>
  `<?xml version="1.0"?><urlset xmlns="${XMLNS}">` +
  urls.map(([loc, lastmod]) => `<url><loc>${loc}</loc>${lastmod ? `<lastmod>${lastmod}</lastmod>` : ""}</url>`).join("") +
  `</urlset>`;

const index = (...locs: string[]) =>
  `<?xml version="1.0"?><sitemapindex xmlns="${XMLNS}">` +
  locs.map((loc) => `<sitemap><loc>${loc}</loc></sitemap>`).join("") +
  `</sitemapindex>`;

const ROOT = [{ url: "https://example.com/sitemap.xml", source: "convention" as const }];
const locs = (read: SitemapRead) => read.entries.map((entry) => entry.loc);

/** A fetch stub that answers bytes, which `serve` cannot: it answers text. */
function serveBytes(body: ConstructorParameters<typeof Response>[0], contentType: string): void {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: unknown) =>
      String(input).endsWith("robots.txt")
        ? new Response("", { status: 404 })
        : new Response(body, { status: 200, headers: { "content-type": contentType } }),
    ),
  );
}

describe("readSitemaps — one file", () => {
  it("keeps each URL with its lastmod, or null where it gave none", async () => {
    serve({ "https://example.com/sitemap.xml": { body: urlset(["https://example.com/one", "2026-09-01"], ["https://example.com/two"]) } });

    const read = await readSitemaps(ROOT);

    expect(read.entries.map((entry) => [entry.loc, entry.lastmod])).toEqual([
      ["https://example.com/one", "2026-09-01"],
      ["https://example.com/two", null],
    ]);
    expect(read.filesRead).toEqual(["https://example.com/sitemap.xml"]);
    expect(read.failed).toEqual([]);
  });

  it("reads a sitemap with exactly one URL", async () => {
    // `fast-xml-parser` gives a lone child as an object and two as an array.
    serve({ "https://example.com/sitemap.xml": { body: urlset(["https://example.com/only"]) } });

    expect(locs(await readSitemaps(ROOT))).toEqual(["https://example.com/only"]);
  });

  it("reads an empty sitemap as a sitemap that lists nothing, rather than crashing", async () => {
    // This threw `Cannot read properties of undefined (reading 'loc')` in the old
    // parser: an empty `<urlset>` carrying only its namespace has no `url` key,
    // and a missing key wrapped in an array is `[undefined]`. A site that has
    // published a sitemap and not filled it in yet is not a broken site.
    serve({ "https://example.com/sitemap.xml": { body: `<?xml version="1.0"?><urlset xmlns="${XMLNS}"></urlset>` } });

    const read = await readSitemaps(ROOT);
    expect(read.entries).toEqual([]);
    expect(read.filesRead).toEqual(["https://example.com/sitemap.xml"]);
    expect(read.failed).toEqual([]);
  });

  it("skips an entry with no location instead of failing the document", async () => {
    serve({
      "https://example.com/sitemap.xml": {
        body: `<urlset><url><lastmod>2026-01-01</lastmod></url><url><loc>https://example.com/a</loc></url></urlset>`,
      },
    });

    expect(locs(await readSitemaps(ROOT))).toEqual(["https://example.com/a"]);
  });

  it("reads a gzipped sitemap", async () => {
    serveBytes(gzipSync(urlset(["https://example.com/z", "2026-01-01"])), "application/gzip");

    const read = await readSitemaps([{ url: "https://example.com/sitemap.xml.gz", source: "argument" }]);
    expect(locs(read)).toEqual(["https://example.com/z"]);
  });

  it("reads a .gz the transport already inflated, rather than inflating it twice", async () => {
    // A `.gz` served with `Content-Encoding: gzip` reaches us as plain XML, because
    // `fetch` undoes the encoding. Both old readers gunzipped it again on the
    // suffix alone, and reported a readable sitemap as one that could not be fetched.
    serveBytes(urlset(["https://example.com/z"]), "application/x-gzip");

    const read = await readSitemaps([{ url: "https://example.com/sitemap.xml.gz", source: "argument" }]);
    expect(locs(read)).toEqual(["https://example.com/z"]);
    expect(read.failed).toEqual([]);
  });

  it("records malformed XML as a file that is not a sitemap", async () => {
    serve({ "https://example.com/sitemap.xml": { body: `<urlset><url><loc>https://example.com/a</loc></url` } });

    const read = await readSitemaps(ROOT);
    expect(read.entries).toEqual([]);
    expect(read.failed).toEqual([
      { url: "https://example.com/sitemap.xml", reason: "it is not well-formed XML", kind: "not-a-sitemap" },
    ]);
  });

  it("records a page that answers where a sitemap should be as not a sitemap", async () => {
    // The single-page app that serves its shell for every path, `/sitemap.xml` included.
    serve({ "https://example.com/sitemap.xml": { body: "<html><body>Welcome</body></html>" } });

    expect((await readSitemaps(ROOT)).failed).toEqual([
      {
        url: "https://example.com/sitemap.xml",
        reason: "it answered, but not with a sitemap or a sitemap index",
        kind: "not-a-sitemap",
      },
    ]);
  });

  it("tells a sitemap that is not there from one that did not answer", async () => {
    // The document the caller named has no partial answer to give, and the old
    // parser threw for it. It is recorded now, with which of the two it was.
    serve({ "https://example.com/sitemap.xml": { status: 404 } });
    expect((await readSitemaps(ROOT)).failed).toEqual([
      { url: "https://example.com/sitemap.xml", reason: "it answered HTTP 404", kind: "absent" },
    ]);

    restoreFetch();
    resetAllSingleFlightCaches();
    serve({ "https://example.com/sitemap.xml": { status: 503 } });
    expect((await readSitemaps(ROOT)).failed).toEqual([
      { url: "https://example.com/sitemap.xml", reason: "it answered HTTP 503", kind: "unavailable" },
    ]);
  });

  it("does not fetch a sitemap robots.txt disallows, and says why", async () => {
    const mock = serve({
      "/robots.txt": { body: "User-agent: *\nDisallow: /" },
      "https://example.com/sitemap.xml": { body: urlset(["https://example.com/x"]) },
    });

    const read = await readSitemaps(ROOT);

    expect(read.entries).toEqual([]);
    expect(read.failed[0].reason).toContain("robots.txt disallows this URL for our crawler");
    expect(read.failed[0].kind).toBe("unavailable");
    expect(mock.mock.calls.map((call) => String(call[0]))).not.toContain("https://example.com/sitemap.xml");
  });
});

describe("readSitemaps — an index", () => {
  it("follows its children, and records a child it could not read without losing the rest", async () => {
    // One 404 among the children used to fail the whole index in the old parser,
    // and its one caller turned the throw into `[]`: a site whose second sitemap
    // had moved got an llms.txt built from none of the others.
    serve({
      "https://example.com/sitemap.xml": {
        body: index("https://example.com/a.xml", "https://example.com/gone.xml", "https://example.com/c.xml"),
      },
      "https://example.com/a.xml": { body: urlset(["https://example.com/one", "2026-09-01"]) },
      "https://example.com/gone.xml": { status: 404 },
      "https://example.com/c.xml": { body: urlset(["https://example.com/three"]) },
    });

    const read = await readSitemaps(ROOT);

    expect(locs(read)).toEqual(["https://example.com/one", "https://example.com/three"]);
    expect(read.filesRead).toEqual([
      "https://example.com/sitemap.xml",
      "https://example.com/a.xml",
      "https://example.com/c.xml",
    ]);
    // Lost, not hidden: the report names it.
    expect(read.failed).toEqual([{ url: "https://example.com/gone.xml", reason: "it answered HTTP 404", kind: "absent" }]);
    expect(describeSitemapRead(read).notChecked).toEqual([
      { subject: "https://example.com/gone.xml", reason: "it answered HTTP 404" },
    ]);
  });

  it("reads an empty index as an index that lists nothing", async () => {
    // It parses to `""` rather than an object, and this reader used to call that
    // "not a sitemap or a sitemap index".
    serve({ "https://example.com/sitemap.xml": { body: `<?xml version="1.0"?><sitemapindex xmlns="${XMLNS}"></sitemapindex>` } });

    const read = await readSitemaps(ROOT);
    expect(read.entries).toEqual([]);
    expect(read.filesRead).toEqual(["https://example.com/sitemap.xml"]);
    expect(read.failed).toEqual([]);
  });

  it("follows an index of indexes", async () => {
    serve({
      "https://example.com/sitemap.xml": { body: index("https://example.com/posts-index.xml") },
      "https://example.com/posts-index.xml": { body: index("https://example.com/posts-1.xml") },
      "https://example.com/posts-1.xml": { body: urlset(["https://example.com/post", "2026-08-01"]) },
    });

    const read = await readSitemaps(ROOT);
    expect(read.entries.map((entry) => [entry.loc, entry.sitemap])).toEqual([
      ["https://example.com/post", "https://example.com/posts-1.xml"],
    ]);
  });

  it("stops at the depth limit rather than following nesting forever", async () => {
    // Each level names a new file, so the de-duplication of files does not stop
    // it; the depth limit does — three levels below the document asked for.
    const mock = serve({
      "https://example.com/sitemap.xml": { body: index("https://example.com/l1.xml") },
      "https://example.com/l1.xml": { body: index("https://example.com/l2.xml") },
      "https://example.com/l2.xml": { body: index("https://example.com/l3.xml") },
      "https://example.com/l3.xml": { body: index("https://example.com/l4.xml") },
      "https://example.com/l4.xml": { body: urlset(["https://example.com/deep"]) },
    });

    const read = await readSitemaps(ROOT);
    expect(read.entries).toEqual([]);
    expect(mock.mock.calls.map((call) => String(call[0]))).not.toContain("https://example.com/l4.xml");
  });

  it("reads an index that lists itself once", async () => {
    const mock = serve({ "https://example.com/sitemap.xml": { body: index("https://example.com/sitemap.xml") } });

    const read = await readSitemaps(ROOT);
    expect(read.filesRead).toEqual(["https://example.com/sitemap.xml"]);
    expect(mock.mock.calls.filter((call) => String(call[0]) === "https://example.com/sitemap.xml")).toHaveLength(1);
  });

  it("honours a URL cap counted across children, and says it stopped", async () => {
    serve({
      "https://example.com/sitemap.xml": { body: index("https://example.com/one.xml", "https://example.com/two.xml") },
      "https://example.com/one.xml": { body: urlset(["https://example.com/a"], ["https://example.com/b"]) },
      "https://example.com/two.xml": { body: urlset(["https://example.com/c"]) },
    });

    const read = await readSitemaps(ROOT, { maxUrls: 2 });
    expect(locs(read)).toEqual(["https://example.com/a", "https://example.com/b"]);
    expect(read.truncated).toBe(true);
  });

  it("stops at its file cap, says the read was truncated, and names the cap it ran under", async () => {
    serve({
      "https://example.com/sitemap.xml": {
        body: index(...[1, 2, 3].map((n) => `https://example.com/${n}.xml`)),
      },
      ".xml": { body: urlset(["https://example.com/p"]) },
    });

    const read = await readSitemaps(ROOT, { maxFiles: 2 });
    expect(read.truncated).toBe(true);
    expect(read.filesRead).toHaveLength(2);
    // It printed the default caps whatever the read had been given.
    expect(describeSitemapRead(read).read.join("\n")).toContain("stopped at our cap of 2 files");
  });

  it("does not return the same URL twice, whichever child listed it", async () => {
    serve({
      "https://example.com/sitemap.xml": { body: index("https://example.com/one.xml", "https://example.com/two.xml") },
      "https://example.com/one.xml": { body: urlset(["https://example.com/a"]) },
      "https://example.com/two.xml": { body: urlset(["https://example.com/a"], ["https://example.com/b"]) },
    });

    expect(locs(await readSitemaps(ROOT))).toEqual(["https://example.com/a", "https://example.com/b"]);
  });
});

/** A read, built by hand: `entryFor` and `listingFor` are pure over it. */
function readOf(overrides: Partial<SitemapRead> = {}): SitemapRead {
  return {
    roots: ROOT,
    entries: [],
    filesRead: ["https://example.com/sitemap.xml"],
    failed: [],
    truncated: false,
    limits: { maxFiles: 6, maxUrls: 10_000 },
    ...overrides,
  };
}

const entry = (loc: string, lastmod: string | null = null) => ({
  loc,
  lastmod,
  sitemap: "https://example.com/sitemap.xml",
  fetchedAt: 0,
});

describe("entryFor", () => {
  it("finds the page's own entry, not the first one in the file", () => {
    // The GEO check once took the first <lastmod> in the document, whatever page
    // it belonged to.
    const read = readOf({ entries: [entry("https://example.com/a", "2026-01-01"), entry("https://example.com/b", "2026-08-01")] });
    expect(entryFor(read, "https://example.com/b")).toEqual({ listed: true, lastmod: "2026-08-01" });
  });

  it("says listed with no lastmod apart from not listed", () => {
    const read = readOf({ entries: [entry("https://example.com/b")] });
    expect(entryFor(read, "https://example.com/b")).toEqual({ listed: true, lastmod: null });
    expect(entryFor(read, "https://example.com/c")).toEqual({ listed: false });
  });

  it("matches by url-match's identity: trailing slash, scheme and www. do not make a second page", () => {
    const read = readOf({ entries: [entry("http://www.example.com/b/", "2026-08-01")] });
    expect(entryFor(read, "https://example.com/b")).toEqual({ listed: true, lastmod: "2026-08-01" });
  });

  it("keeps path case and the query string, which can be two pages", () => {
    const read = readOf({ entries: [entry("https://example.com/B"), entry("https://example.com/c?page=2")] });
    expect(entryFor(read, "https://example.com/b")).toEqual({ listed: false });
    expect(entryFor(read, "https://example.com/c")).toEqual({ listed: false });
  });
});

describe("listingFor", () => {
  const PAGE = "https://example.com/b";

  it("settles on a positive even when another file failed or the read was cut short", () => {
    // Finding the page is conclusive; nothing in a file we did not read can unfind it.
    const read = readOf({
      entries: [entry(PAGE, "2026-08-01")],
      failed: [{ url: "https://example.com/2.xml", reason: "it answered HTTP 503", kind: "unavailable" }],
      truncated: true,
    });
    expect(listingFor(read, PAGE)).toEqual({ outcome: "listed", lastmod: "2026-08-01" });
  });

  it("says not listed only when every file was read, counting a 404 child as an answer", () => {
    const read = readOf({
      entries: [entry("https://example.com/other")],
      failed: [{ url: "https://example.com/gone.xml", reason: "it answered HTTP 404", kind: "absent" }],
    });
    expect(listingFor(read, PAGE)).toEqual({ outcome: "not-listed" });
  });

  it("does not say not listed when a file it might be in did not answer", () => {
    const read = readOf({
      filesRead: ["https://example.com/sitemap.xml", "https://example.com/1.xml"],
      entries: [entry("https://example.com/other")],
      failed: [{ url: "https://example.com/2.xml", reason: "it answered HTTP 500", kind: "unavailable" }],
    });
    expect(listingFor(read, PAGE)).toEqual({ outcome: "unread", reason: "1 of the 3 sitemap files could not be read" });
  });

  it("names the one sitemap it could not read when that was the only one", () => {
    const read = readOf({
      filesRead: [],
      failed: [{ url: "https://example.com/sitemap.xml", reason: "it answered HTTP 503", kind: "unavailable" }],
    });
    expect(listingFor(read, PAGE)).toEqual({
      outcome: "unread",
      reason: "https://example.com/sitemap.xml could not be read: it answered HTTP 503",
    });
  });

  it("does not say not listed when a cap stopped the read", () => {
    const listing = listingFor(readOf({ entries: [entry("https://example.com/other")], truncated: true }), PAGE);
    expect(listing.outcome).toBe("unread");
    expect(listing.outcome === "unread" && listing.reason).toContain("not all of them were searched");
  });

  it("says there is no sitemap when every file the site points at is missing or is not one", () => {
    const read = readOf({
      filesRead: [],
      failed: [
        { url: "https://example.com/sitemap.xml", reason: "it answered HTTP 404", kind: "absent" },
        { url: "https://example.com/map.xml", reason: "it is not well-formed XML", kind: "not-a-sitemap" },
      ],
    });
    expect(listingFor(read, PAGE)).toEqual({ outcome: "no-sitemap" });
  });
});

describe("findSitemaps", () => {
  it("prefers what was submitted in Search Console", async () => {
    const roots = await findSitemaps("https://example.com", {
      searchConsole: fakeGoogleReader().searchConsole,
      property: "sc-domain:example.com",
    });
    expect(roots).toEqual([{ url: "https://example.com/sitemap.xml", source: "search-console" }]);
  });

  it("falls back to robots.txt, then to the convention", async () => {
    const none = fakeGoogleReader({ searchConsole: { listSitemaps: async () => [] } });
    const options = { searchConsole: none.searchConsole, property: "sc-domain:example.com" };

    serve({ "/robots.txt": { body: "User-agent: *\nAllow: /\nSitemap: https://example.com/map.xml" } });
    expect(await findSitemaps("https://example.com", options)).toEqual([
      { url: "https://example.com/map.xml", source: "robots.txt" },
    ]);

    restoreFetch();
    resetAllSingleFlightCaches();
    serve({ "/robots.txt": { status: 404 } });
    expect(await findSitemaps("https://example.com", options)).toEqual([
      { url: "https://example.com/sitemap.xml", source: "convention" },
    ]);
  });

  it("lets a refusal from Search Console propagate", async () => {
    const refusing = fakeGoogleReader({
      searchConsole: {
        listSitemaps: async () => {
          throw new UpstreamApiError("Search Console", 403);
        },
      },
    });
    await expect(
      findSitemaps("https://example.com", { searchConsole: refusing.searchConsole, property: "sc-domain:example.com" }),
    ).rejects.toBeInstanceOf(UpstreamApiError);
  });

  it("without Search Console, starts from robots.txt and never asks Google", async () => {
    // What a credential-free Tool does. A reader with no property is not asked
    // either: the step needs both.
    const listSitemaps = vi.fn(async () => []);
    const reader = fakeGoogleReader({ searchConsole: { listSitemaps } });

    serve({ "/robots.txt": { body: "Sitemap: https://example.com/a.xml\nSitemap: https://example.com/b.xml" } });
    expect(await findSitemaps("https://example.com")).toEqual([
      { url: "https://example.com/a.xml", source: "robots.txt" },
      { url: "https://example.com/b.xml", source: "robots.txt" },
    ]);
    await findSitemaps("https://example.com", { searchConsole: reader.searchConsole });
    expect(listSitemaps).not.toHaveBeenCalled();
  });

  it("guesses /sitemap.xml when robots.txt names none, or could not be read", async () => {
    serve({ "/robots.txt": { status: 503 } });
    expect(await findSitemaps("https://example.com")).toEqual([
      { url: "https://example.com/sitemap.xml", source: "convention" },
    ]);
  });

  it("takes a named sitemap over everything else", async () => {
    const mock = serve({ "/robots.txt": { body: "Sitemap: https://example.com/a.xml" } });
    expect(await findSitemaps("https://example.com", { explicit: "https://example.com/mine.xml" })).toEqual([
      { url: "https://example.com/mine.xml", source: "argument" },
    ]);
    expect(mock).not.toHaveBeenCalled();
  });
});
