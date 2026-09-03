import { findNodeInAll } from "./json-ld-graph";

/**
 * The **Publishing Entity** a page declares as itself, and how we came to know it.
 *
 * ── Why this exists ──
 *
 * "What brand is this page about?" was answered in three places, by three
 * implementations that had never met, and every fix reached one of them:
 *
 *   - `ai-visibility-tools` read `Organization.name`, falling back to the first
 *     label of the hostname.
 *   - `entity-mentions-tools` had its own regex JSON-LD parser and its own
 *     `@graph` walk.
 *   - `geo-tools` sent the raw hostname, TLD and all, so the Knowledge Graph was
 *     searched for `"bbva.es"`.
 *
 * #342 gave the Wikidata lookup the page's real brand and its language. It
 * landed in the first of the three. The other two still ship the bug.
 *
 * ── The blind spot that made it worse ──
 *
 * `entity-mentions`' private parser flattened `@graph` but not a top-level array,
 * so `[{"@type":"Organization",…}]` — what any site without `@graph` emits — was
 * invisible to it. That is the exact blind spot `eeat-analyzer` deleted from
 * itself when it moved to `extractJsonLd`, surviving one directory away. The name
 * then silently degraded to `og:site_name`, or to a fragment of `<title>`, and
 * that fragment is what got searched on Wikipedia and Wikidata — so a brand with
 * an article was reported as having none.
 *
 * ── What `source` is for ──
 *
 * A reader deciding how much to trust a `NOT FOUND` needs to know what we
 * searched for. "No Wikipedia article for Acme Corp" and "no Wikipedia article
 * for the first four words of your page title" are different sentences, and the
 * second one is not a finding about the brand at all.
 *
 * ── What is deliberately not here ──
 *
 * The hostname. It is not a name the page declares, it is a guess of ours, and
 * putting it at the end of this ladder would make `source` lie: a caller could no
 * longer tell "the page says it is Acme" from "we assumed Acme from the domain".
 * A caller that wants to guess may still guess, at its own call site, where the
 * guess is visible.
 *
 * The language. `page-language.ts` answers that, and a caller that already knows
 * the language — from a stored audit, from a user setting — should not have to
 * hand this module an HTML document to get an answer. Same reasoning
 * `answer-patterns` wrote for not reading the language itself.
 */
export type PublishingEntity = {
  name: string;
  /**
   * Where the name came from, weakest last.
   *
   * `schema` is a declaration. `og` is a declaration about the site rather than
   * the publisher, which is usually the same thing and occasionally is not.
   * `title` is a guess made from prose, and the caller should say so.
   */
  source: "schema" | "og" | "title";
};

/**
 * Most specific first, and `Person` last because a page declaring both is
 * published by the organisation.
 *
 * `Person` is in the list because `CONTEXT.md` has always said it is: a personal
 * site is published by a Person, and demanding an Organization of one is the same
 * error as demanding `Article` of a homepage. None of the three implementations
 * this replaces looked for it, so every personal site fell straight through to
 * the title.
 */
const PUBLISHER_TYPES = ["Organization", "LocalBusiness", "Corporation", "NGO", "Person"] as const;

export function publishingEntity(
  schemas: readonly unknown[],
  html: string,
): PublishingEntity | undefined {
  // One type at a time, in the order declared above, because `findNodeInAll`
  // answers in document order and the precedence is ours: a page carrying both a
  // `Person` and an `Organization` is published by the organisation, whichever
  // was serialized first. Same shape as `findPageAuthor` walking `AUTHORED_TYPES`.
  //
  // `findNodeInAll` rather than a fourth private type-matcher: it already handles
  // `@type` arrays, `@graph` nesting and top-level arrays, and already skips bare
  // `@id` references (ADR-0016). The walks it replaces did those partly or not at
  // all — one of them could not see `@graph`, which is what every WordPress SEO
  // plugin emits.
  for (const type of PUBLISHER_TYPES) {
    const declared = findNodeInAll(schemas, [type])?.["name"];
    if (typeof declared === "string" && declared.trim()) {
      return { name: declared.trim(), source: "schema" };
    }
  }

  const ogSiteName = html.match(
    /<meta[^>]+property=["']og:site_name["'][^>]+content=["']([^"']+)["']/i,
  )?.[1];
  if (ogSiteName?.trim()) return { name: ogSiteName.trim(), source: "og" };

  const title = html.match(/<title[^>]*>([^<]+)<\/title>/i)?.[1];
  if (title?.trim()) {
    // "Acme Corp | Widgets since 1994" — the separator convention is near
    // universal and the part before it is usually the site. Usually.
    const trimmed = title.trim().replace(/\s*[|–—-]\s*.+$/, "").trim();
    if (trimmed) return { name: trimmed, source: "title" };
  }

  return undefined;
}

/**
 * How much weight a reader should put on an absence we report about this name.
 *
 * A `NOT FOUND` against a declared name is a finding. Against a fragment of a
 * page title it is mostly a finding about the page title.
 */
export function isDeclared(entity: PublishingEntity): boolean {
  return entity.source !== "title";
}
