import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { analyzeOnPageSeo } from "@/lib/analyzers/onpage-seo";
import { analyzeContent } from "@/lib/analyzers/content-analyzer";
import { resetAllSingleFlightCaches } from "@/lib/single-flight";

/**
 * #348. `onpage-seo` was the odd one out on three independent axes, and three
 * independent deviations in one file usually have one cause. Each cost
 * something:
 *
 *  - its own `safeFetch`, outside the single-flight cache, so the baseline batch
 *    hit the customer's page twice;
 *  - its own JSON-LD parser, the last one blind to a top-level array;
 *  - its own `<html lang>` read, the only one that did not know about
 *    `xml:lang`, which made `seo-rules` fire `lang-missing` at a page that had
 *    declared its language.
 */

const URL_A = "https://onpage.example/page";

const PAGE = `<!DOCTYPE html>
<html lang="en-GB">
  <head><title>A page</title><meta name="description" content="About the page." /></head>
  <body><main><h1>A page</h1><p>Some words about the page and what it does.</p></main></body>
</html>`;

let originalFetch: typeof fetch;
let requests: string[];

function serve(html: string) {
  requests = [];
  globalThis.fetch = vi.fn(async (input: Parameters<typeof fetch>[0]) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : (input as Request).url;
    requests.push(url);
    if (url.includes("robots.txt")) return new Response("", { status: 404 });
    return new Response(html, { status: 200, headers: { "Content-Type": "text/html" } });
  }) as unknown as typeof fetch;
}

beforeEach(() => { originalFetch = globalThis.fetch; resetAllSingleFlightCaches(); });
afterEach(() => { globalThis.fetch = originalFetch; resetAllSingleFlightCaches(); });

describe("it shares one request with the analyzers running beside it", () => {
  it("does not fetch the page a second time when another analyzer already has it", async () => {
    // `seo_analyze_page` runs in the same baseline batch as
    // `seo_content_analysis`, `seo_eeat_score` and `seo_geo_score`, all on this
    // URL. They share one request through `fetchHtml`; this one used to open its
    // own, so every shared report made an extra round trip to the customer.
    serve(PAGE);

    await analyzeContent(URL_A);
    const before = requests.filter((u) => u === URL_A).length;
    await analyzeOnPageSeo(URL_A);
    const after = requests.filter((u) => u === URL_A).length;

    expect(before).toBe(1);
    expect(after).toBe(1);
  });
});

describe("it reads JSON-LD the way every other reader does", () => {
  it("sees each payload of a top-level array, not one opaque value", async () => {
    // `[{...},{...}]` is what any site without `@graph` emits. The private parser
    // pushed the array itself, so the stored section disagreed with every other
    // reading of the same markup.
    serve(PAGE.replace("</head>", `<script type="application/ld+json">
      [{"@type":"Organization","name":"Acme"},{"@type":"WebSite","name":"Acme site"}]
    </script></head>`));

    const result = await analyzeOnPageSeo(URL_A);

    expect(result.jsonLd).toHaveLength(2);
    expect((result.jsonLd[0] as Record<string, unknown>)["@type"]).toBe("Organization");
  });

  it("still reads a plain object and skips malformed JSON", async () => {
    serve(PAGE.replace("</head>", `<script type="application/ld+json">{"@type":"WebPage"}</script>
      <script type="application/ld+json">{ not json</script></head>`));

    const result = await analyzeOnPageSeo(URL_A);

    expect(result.jsonLd).toHaveLength(1);
  });
});

describe("it reports the language the page declares", () => {
  it("keeps the region subtag, which the report is more useful for", async () => {
    serve(PAGE);
    expect((await analyzeOnPageSeo(URL_A)).meta.lang).toBe("en-GB");
  });

  it("finds a declaration made only with xml:lang", async () => {
    // `seo-rules` fires `lang-missing` on this field, so an XHTML page that had
    // declared its language was told it had not.
    serve(PAGE.replace('<html lang="en-GB">', '<html xml:lang="es-419">'));
    expect((await analyzeOnPageSeo(URL_A)).meta.lang).toBe("es-419");
  });

  it("still reports nothing when the page declares nothing", async () => {
    serve(PAGE.replace('<html lang="en-GB">', "<html>"));
    expect((await analyzeOnPageSeo(URL_A)).meta.lang).toBeNull();
  });
});
