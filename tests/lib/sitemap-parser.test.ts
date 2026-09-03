import { describe, it, expect, afterEach, vi } from "vitest";
import { gzipSync } from "node:zlib";
import { parseSitemap } from "@/lib/sitemap-parser";
import { serve, restoreFetch } from "../helpers/serve";

/**
 * The sitemap reader, which had no test of its own.
 *
 * It was reached only through `llms-txt-generator`, whose one caller wraps it in
 * a `catch` that returns `[]` — so every way this module could fail arrived as
 * "the sitemap had no URLs", which is also what a site with no sitemap looks
 * like. Two crashes and a lost-children bug lived in there behind that `catch`.
 */

const XMLNS = "http://www.sitemaps.org/schemas/sitemap/0.9";
const xml = (body: string) => ({ headers: { "content-type": "application/xml" }, body });

const urlset = (...locs: string[]) =>
  xml(
    `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="${XMLNS}">${locs
      .map((loc) => `<url><loc>${loc}</loc></url>`)
      .join("")}</urlset>`,
  );

const index = (...locs: string[]) =>
  xml(
    `<?xml version="1.0" encoding="UTF-8"?>\n<sitemapindex xmlns="${XMLNS}">${locs
      .map((loc) => `<sitemap><loc>${loc}</loc></sitemap>`)
      .join("")}</sitemapindex>`,
  );

afterEach(() => {
  restoreFetch();
  vi.restoreAllMocks();
});

describe("a plain sitemap", () => {
  it("returns the locations it lists", async () => {
    serve({ "https://example.com/sitemap.xml": urlset("https://example.com/a", "https://example.com/b") });

    expect(await parseSitemap("https://example.com/sitemap.xml")).toEqual([
      "https://example.com/a",
      "https://example.com/b",
    ]);
  });

  it("reads a sitemap with exactly one URL", async () => {
    // `fast-xml-parser` gives a lone child as an object and two as an array.
    serve({ "https://example.com/sitemap.xml": urlset("https://example.com/only") });

    expect(await parseSitemap("https://example.com/sitemap.xml")).toEqual(["https://example.com/only"]);
  });

  it("reads an empty sitemap as empty, rather than crashing", async () => {
    serve({ "https://example.com/sitemap.xml": xml(`<?xml version="1.0"?><urlset xmlns="${XMLNS}"></urlset>`) });

    // This threw `Cannot read properties of undefined (reading 'loc')`: an empty
    // `<urlset>` carrying only its namespace parses to an object with no `url`
    // key, and a missing key wrapped in an array is `[undefined]`. A site that
    // has published a sitemap and not filled it in yet is not a broken site.
    expect(await parseSitemap("https://example.com/sitemap.xml")).toEqual([]);
  });

  it("skips an entry with no location instead of failing the document", async () => {
    serve({
      "https://example.com/sitemap.xml": xml(
        `<?xml version="1.0"?><urlset xmlns="${XMLNS}"><url><lastmod>2026-01-01</lastmod></url><url><loc>https://example.com/a</loc></url></urlset>`,
      ),
    });

    expect(await parseSitemap("https://example.com/sitemap.xml")).toEqual(["https://example.com/a"]);
  });

  it("reads a gzipped sitemap", async () => {
    const body = `<?xml version="1.0"?><urlset xmlns="${XMLNS}"><url><loc>https://example.com/z</loc></url></urlset>`;
    const mock = vi.fn(
      async () =>
        new Response(gzipSync(Buffer.from(body)), {
          status: 200,
          headers: { "content-type": "application/gzip" },
        }),
    );
    vi.stubGlobal("fetch", mock);

    expect(await parseSitemap("https://example.com/sitemap.xml.gz")).toEqual(["https://example.com/z"]);
  });

  it("throws when the sitemap it was asked for cannot be read", async () => {
    serve({ "https://example.com/sitemap.xml": { status: 404, body: "Not Found" } });

    // The document the caller named is a different case from a child of it: this
    // one has no partial answer to give.
    await expect(parseSitemap("https://example.com/sitemap.xml")).rejects.toThrow(/404/);
  });
});

describe("a sitemap index", () => {
  it("follows its children", async () => {
    serve({
      "https://example.com/sitemap.xml": index("https://example.com/one.xml", "https://example.com/two.xml"),
      "https://example.com/one.xml": urlset("https://example.com/a"),
      "https://example.com/two.xml": urlset("https://example.com/b"),
    });

    expect(await parseSitemap("https://example.com/sitemap.xml")).toEqual([
      "https://example.com/a",
      "https://example.com/b",
    ]);
  });

  it("keeps the children it could read when one of them cannot be", async () => {
    const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    serve({
      "https://example.com/sitemap.xml": index(
        "https://example.com/one.xml",
        "https://example.com/gone.xml",
        "https://example.com/three.xml",
      ),
      "https://example.com/one.xml": urlset("https://example.com/a"),
      "https://example.com/gone.xml": { status: 404, body: "Not Found" },
      "https://example.com/three.xml": urlset("https://example.com/c"),
    });

    // One 404 among the children used to fail the whole index, and the one
    // caller turns a throw into `[]` — so a site whose second sitemap had moved
    // got an llms.txt built from none of the others.
    expect(await parseSitemap("https://example.com/sitemap.xml")).toEqual([
      "https://example.com/a",
      "https://example.com/c",
    ]);
    // Lost, not hidden: the child that could not be read reaches stderr.
    expect(stderr).toHaveBeenCalled();
    expect(stderr.mock.calls.map((call) => String(call[0])).join("\n")).toContain("gone.xml");
  });

  it("reads an empty index as empty", async () => {
    serve({
      "https://example.com/sitemap.xml": xml(`<?xml version="1.0"?><sitemapindex xmlns="${XMLNS}"></sitemapindex>`),
    });

    expect(await parseSitemap("https://example.com/sitemap.xml")).toEqual([]);
  });

  it("stops at the depth limit rather than following a cycle forever", async () => {
    // An index that lists itself. Four requests — the limit is a depth of three
    // below the document asked for — and then it stops.
    const mock = serve({ "https://example.com/sitemap.xml": index("https://example.com/sitemap.xml") });

    expect(await parseSitemap("https://example.com/sitemap.xml")).toEqual([]);
    expect(mock.mock.calls.length).toBeLessThan(6);
  });

  it("honours a maximum, counted across children", async () => {
    serve({
      "https://example.com/sitemap.xml": index("https://example.com/one.xml", "https://example.com/two.xml"),
      "https://example.com/one.xml": urlset("https://example.com/a", "https://example.com/b"),
      "https://example.com/two.xml": urlset("https://example.com/c"),
    });

    expect(await parseSitemap("https://example.com/sitemap.xml", 2)).toEqual([
      "https://example.com/a",
      "https://example.com/b",
    ]);
  });

  it("does not return the same URL twice, whichever child listed it", async () => {
    serve({
      "https://example.com/sitemap.xml": index("https://example.com/one.xml", "https://example.com/two.xml"),
      "https://example.com/one.xml": urlset("https://example.com/a"),
      "https://example.com/two.xml": urlset("https://example.com/a", "https://example.com/b"),
    });

    expect(await parseSitemap("https://example.com/sitemap.xml")).toEqual([
      "https://example.com/a",
      "https://example.com/b",
    ]);
  });
});
