import { describe, expect, it } from "vitest";
import { extractJsonLd } from "@/lib/analyzers/json-ld-graph";
import { publishingEntity, isDeclared } from "@/lib/analyzers/publishing-entity";

/**
 * C3. "What brand is this page about?" was answered in three places by three
 * implementations that had never met — `ai-visibility-tools` read
 * `Organization.name` and fell back to the first label of the hostname,
 * `entity-mentions-tools` had its own regex JSON-LD parser, and `geo-tools` sent
 * the bare hostname with its TLD, so the Knowledge Graph was searched for
 * "bbva.es". #342 gave the lookup the real brand and the page's language, and
 * landed in one of the three.
 */

const ld = (json: string) => `<script type="application/ld+json">${json}</script>`;
const page = (head: string, title = "Acme Corp | Widgets since 1994") =>
  `<!DOCTYPE html><html lang="en"><head><title>${title}</title>${head}</head><body></body></html>`;

const entityOf = (html: string) => publishingEntity(extractJsonLd(html), html);

describe("the name a page declares", () => {
  it("reads Organization.name", () => {
    const e = entityOf(page(ld('{"@type":"Organization","name":"Acme Corp"}')));
    expect(e).toEqual({ name: "Acme Corp", source: "schema" });
  });

  it("sees an Organization inside a top-level array", () => {
    // The blind spot that made this worth a module. `entity-mentions`' private
    // parser flattened `@graph` and not a top-level array, which is what any site
    // without `@graph` emits — so it fell through to the title and searched
    // Wikipedia for "Acme Corp"'s page title instead of its name.
    const e = entityOf(page(ld('[{"@type":"Organization","name":"Acme Corp"}]')));
    expect(e?.source).toBe("schema");
    expect(e?.name).toBe("Acme Corp");
  });

  it("sees an Organization inside @graph", () => {
    // The other half, and the more common one: Yoast, RankMath and every
    // WordPress SEO plugin emit `@graph`. `findSchema` in `ai-visibility-analyzer`
    // only looked at top-level array elements, so it saw none of them.
    const e = entityOf(page(ld(
      '{"@context":"https://schema.org","@graph":[{"@type":"WebPage"},{"@type":"Organization","name":"Acme Corp"}]}',
    )));
    expect(e?.source).toBe("schema");
    expect(e?.name).toBe("Acme Corp");
  });

  it("accepts a Person, because a personal site is published by one", () => {
    // `CONTEXT.md` has always defined a Publishing Entity as Organization,
    // LocalBusiness *or* Person. None of the three implementations this replaces
    // looked for Person, so every personal site fell through to its title.
    const e = entityOf(page(ld('{"@type":"Person","name":"Ada Lovelace"}'), "Notes | Ada"));
    expect(e).toEqual({ name: "Ada Lovelace", source: "schema" });
  });

  it("prefers the organisation when a page declares both", () => {
    const e = entityOf(page(ld(
      '[{"@type":"Person","name":"Ada Lovelace"},{"@type":"Organization","name":"Acme Corp"}]',
    )));
    expect(e?.name).toBe("Acme Corp");
  });

  it("handles a @type array", () => {
    const e = entityOf(page(ld('{"@type":["Organization","LocalBusiness"],"name":"Acme Corp"}')));
    expect(e?.name).toBe("Acme Corp");
  });
});

describe("the fallbacks, and how far they can be trusted", () => {
  it("falls back to og:site_name", () => {
    const e = entityOf(page('<meta property="og:site_name" content="Acme Corp" />'));
    expect(e).toEqual({ name: "Acme Corp", source: "og" });
  });

  it("falls back to the title, stripped at the separator", () => {
    const e = entityOf(page(""));
    expect(e).toEqual({ name: "Acme Corp", source: "title" });
  });

  it("marks a title-derived name as not declared", () => {
    // The whole reason `source` exists. "No Wikipedia article for Acme Corp" and
    // "no Wikipedia article for the first four words of your page title" are
    // different sentences, and only one of them is about the brand.
    expect(isDeclared(entityOf(page(""))!)).toBe(false);
    expect(isDeclared(entityOf(page(ld('{"@type":"Organization","name":"Acme Corp"}')))!)).toBe(true);
  });

  it("returns nothing when the page names nobody", () => {
    // Deliberately not the hostname. That is a guess of ours, and returning it
    // here would leave a caller unable to tell a declaration from an assumption.
    // A caller may still guess — at its own call site, where the guess is visible.
    expect(publishingEntity([], "<!DOCTYPE html><html><body><p>Hi</p></body></html>")).toBeUndefined();
  });

  it("ignores an empty or whitespace name rather than returning it", () => {
    const e = entityOf(page(ld('{"@type":"Organization","name":"   "}')));
    expect(e?.source).toBe("title");
  });

  it("survives malformed JSON-LD without losing the fallbacks", () => {
    const e = entityOf(page(ld("{not json at all"), "Acme Corp | Widgets"));
    expect(e).toEqual({ name: "Acme Corp", source: "title" });
  });
});
