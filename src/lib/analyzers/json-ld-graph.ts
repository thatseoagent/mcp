/**
 * Flatten a JSON-LD payload into the individual nodes it declares.
 *
 * A single `<script type="application/ld+json">` can hold one node, an array of
 * nodes, or — overwhelmingly the common case on the real web — one object whose
 * `@graph` holds them all. Yoast, Rank Math and most WordPress SEO plugins emit
 * the `@graph` form, so it is what a large share of audited pages ship.
 *
 * Both readers used to miss it, in different ways:
 *
 * - `schema-analyzer.detectJsonLd` read the wrapper object, found no `@type` on
 *   it, and recorded the whole page as one schema of type "Unknown" that failed
 *   validation. Auditing joost.blog — 21 nodes including `WebSite`, `Person`,
 *   `BreadcrumbList` and eight `Organization`s — reported "0 of 1 valid" and
 *   "Missing: Organization, WebSite".
 * - `geo-analyzer`'s scorers ran `schemas.find(s => s["@type"] === "Organization")`
 *   against the top level, so every node check failed even though
 *   `getSchemaTypes` walked the tree and could see the types were there.
 *
 * Nested nodes count too: a `BlogPosting` with an inline `author` Person is
 * declaring both, and a check for Person schema should find it.
 */

const NODE_KEYS_TO_WALK = new Set([
  "@graph",
  "author",
  "publisher",
  "creator",
  "mainEntity",
  "mainEntityOfPage",
  "itemListElement",
  "item",
  "about",
  "offers",
  "brand",
  "hasPart",
  "isPartOf",
  "review",
  "aggregateRating",
  "breadcrumb",
]);

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/**
 * The keys a node can carry without saying anything about the thing itself.
 *
 * `@id` names the thing, `@type` says what kind it is, `@context` is boilerplate.
 * A node holding only these is a pointer, not a description.
 */
const REFERENCE_ONLY_KEYS = new Set(["@id", "@type", "@context"]);

/**
 * Is this a reference to a node declared elsewhere, rather than a node itself?
 *
 * The `@graph` form lets a page state a thing once and point at it from everywhere
 * else, which is what `@id` is for. angelcruz.dev declares `Person` in its own
 * block and its `WebSite` points back at it:
 *
 *     "author": { "@type": "Person", "@id": "https://www.angelcruz.dev/#person" }
 *
 * That is correct markup, and it is not a second Person. Counting it as one
 * inflated the page's schema total and then failed it for "Missing required field:
 * name" — a field a reference is not supposed to carry.
 */
export function isNodeReference(node: Record<string, unknown>): boolean {
  if (typeof node["@id"] !== "string") return false;
  return Object.keys(node).every((k) => REFERENCE_ONLY_KEYS.has(k));
}

/** Does this object declare a schema type of its own? */
function hasType(v: unknown): boolean {
  if (!isRecord(v)) return false;
  const t = v["@type"];
  return typeof t === "string" || (Array.isArray(t) && t.some((x) => typeof x === "string"));
}

/**
 * Every typed node in a parsed JSON-LD payload, outermost first.
 *
 * A node is returned as-is, not copied, so a caller reading `node.sameAs` sees
 * exactly what the page published. The wrapper object of an `@graph` is not a
 * node — it declares no type — and is never returned.
 */
export function flattenJsonLd(parsed: unknown, depth = 0): Record<string, unknown>[] {
  // Deeply self-referential payloads exist; a schema graph worth reading is never
  // more than a handful of levels deep.
  if (depth > 6) return [];

  if (Array.isArray(parsed)) {
    return parsed.flatMap((entry) => flattenJsonLd(entry, depth + 1));
  }

  if (!isRecord(parsed)) return [];

  const nodes: Record<string, unknown>[] = [];
  if (hasType(parsed)) nodes.push(parsed);

  for (const [key, value] of Object.entries(parsed)) {
    if (!NODE_KEYS_TO_WALK.has(key)) continue;
    nodes.push(...flattenJsonLd(value, depth + 1));
  }

  return nodes;
}

/**
 * The nodes a page actually declares, across every `ld+json` block it ships.
 *
 * A reference is dropped when the thing it points at is declared somewhere in the
 * same set. This has to see every block at once: angelcruz.dev puts `WebSite`,
 * `Organization` and `Person` in three separate `<script>` tags, so the reference
 * in the first only resolves against the third.
 *
 * A reference that resolves to nothing is kept. A pointer to a node no block
 * declares is a broken graph, and reporting it as an incomplete node is the honest
 * outcome — assistants following that `@id` find nothing either.
 */
export function declaredNodes(payloads: readonly unknown[]): Record<string, unknown>[] {
  const all = payloads.flatMap((p) => flattenJsonLd(p));

  const described = new Set<string>();
  for (const node of all) {
    const id = node["@id"];
    if (typeof id === "string" && !isNodeReference(node)) described.add(id);
  }

  return all.filter((n) => !(isNodeReference(n) && described.has(n["@id"] as string)));
}

/** The first node declaring any of `types`, searching the whole payload. */
export function findJsonLdNode(
  parsed: unknown,
  types: readonly string[],
): Record<string, unknown> | undefined {
  const wanted = new Set(types);
  return declaredNodes([parsed]).find((node) => {
    const t = node["@type"];
    if (typeof t === "string") return wanted.has(t);
    if (Array.isArray(t)) return t.some((x) => typeof x === "string" && wanted.has(x));
    return false;
  });
}

/**
 * The same, across a list of parsed payloads — one per `ld+json` block.
 *
 * Searching the blocks together, rather than one at a time, is what lets a
 * reference in an early block resolve against the node a later block declares —
 * so a lookup for `Person` returns the described node and not the pointer to it.
 */
export function findNodeInAll(
  payloads: readonly unknown[],
  types: readonly string[],
): Record<string, unknown> | undefined {
  const wanted = new Set(types);
  return declaredNodes(payloads).find((node) => {
    const t = node["@type"];
    if (typeof t === "string") return wanted.has(t);
    if (Array.isArray(t)) return t.some((x) => typeof x === "string" && wanted.has(x));
    return false;
  });
}

/**
 * The first node of one of `types` that also satisfies `predicate`.
 *
 * A page can declare many nodes of one type — joost.blog carries eight
 * `Organization`s, one per company its author is involved with — so "the first
 * one" is the wrong node to interrogate. A check asking whether the page declares
 * an Organization with `sameAs` means *any* of them, not whichever happened to be
 * serialized first.
 */
export function findNodeWith(
  payloads: readonly unknown[],
  types: readonly string[],
  predicate: (node: Record<string, unknown>) => boolean,
): Record<string, unknown> | undefined {
  const wanted = new Set(types);
  const isWanted = (node: Record<string, unknown>) => {
    const t = node["@type"];
    if (typeof t === "string") return wanted.has(t);
    if (Array.isArray(t)) return t.some((x) => typeof x === "string" && wanted.has(x));
    return false;
  };
  return declaredNodes(payloads).find((n) => isWanted(n) && predicate(n));
}


/**
 * Types that carry an `author`, most specific first.
 *
 * Order decides which node is "the page's", and an article beats the `WebPage`
 * wrapping it: a blog post whose `WebPage` names the site owner and whose
 * `BlogPosting` names the writer should credit the writer.
 */
const AUTHORED_TYPES = [
  "Article", "BlogPosting", "NewsArticle", "TechArticle", "ScholarlyArticle",
  "Report", "Review", "Recipe", "HowTo", "ProfilePage", "AboutPage", "WebPage",
] as const;

/**
 * How a page names its author, when it names one.
 *
 * A string author is valid markup and Google accepts it, so it is an answer — just
 * not one that can carry `sameAs`, which is why the two forms are told apart rather
 * than collapsed into a node with a fabricated `@type`.
 */
export type PageAuthor =
  | { form: "node"; node: Record<string, unknown> }
  | { form: "name"; name: string };

/**
 * The author **of this page's main entity**, not any Person the page mentions.
 *
 * The distinction is the whole function. `eeat-analyzer` used to award its largest
 * indicator, 10 points, for `@type === "Person"` on any top-level node or for the
 * mere presence of an `author` key anywhere — so a `Person` describing the author of
 * a *testimonial*, or a `Review` written by a customer, scored the page as carrying
 * an author bio it does not have (#341).
 *
 * A reference is followed: `"author": { "@id": "…#person" }` beside a `Person`
 * declaring that id is correct markup and the commonest shape there is, which
 * ADR-0016 already had to settle for a different check. A reference that resolves to
 * nothing returns nothing — an assistant following that `@id` finds nothing either.
 */
export function findPageAuthor(payloads: readonly unknown[]): PageAuthor | undefined {
  const nodes = declaredNodes(payloads);

  const described = new Map<string, Record<string, unknown>>();
  for (const node of nodes) {
    const id = node["@id"];
    if (typeof id === "string" && !isNodeReference(node)) described.set(id, node);
  }

  const isOfType = (node: Record<string, unknown>, type: string): boolean => {
    const t = node["@type"];
    if (typeof t === "string") return t === type;
    return Array.isArray(t) && t.some((x) => x === type);
  };

  for (const type of AUTHORED_TYPES) {
    for (const node of nodes.filter((n) => isOfType(n, type))) {
      const raw = node["author"];
      const first = Array.isArray(raw) ? raw[0] : raw;

      if (typeof first === "string" && first.trim()) return { form: "name", name: first };
      if (!isRecord(first)) continue;

      if (isNodeReference(first)) {
        const resolved = typeof first["@id"] === "string" ? described.get(first["@id"]) : undefined;
        if (resolved) return { form: "node", node: resolved };
        continue;
      }
      return { form: "node", node: first };
    }
  }
  return undefined;
}

/**
 * Every JSON-LD payload a page ships, one per `<script type="application/ld+json">`.
 *
 * Lived in `geo-analyzer` and was imported from there by `eeat-analyzer` and
 * `geo-tools`, neither of which has anything to do with GEO scoring — a leak that
 * grew a third head when `ai-visibility-tools` copied the body into a private
 * function of its own rather than import from a module named for another concern.
 * Three readers, two implementations, and the one place that owns what a JSON-LD
 * graph *is* was not either of them. It is here now, so the dependency runs toward
 * this module instead of away from it.
 *
 * Returns payloads, not nodes: a payload can be a single node, an array, or an
 * `@graph` wrapper, and untangling that is `flattenJsonLd`'s job above. Invalid JSON
 * is skipped rather than thrown — one malformed block on a page should not cost the
 * reader the other six.
 */
export function extractJsonLd(html: string): unknown[] {
  const schemas: unknown[] = [];
  const re = /<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) {
    try {
      const parsed = JSON.parse(m[1]) as unknown;
      if (Array.isArray(parsed)) schemas.push(...(parsed as unknown[]));
      else schemas.push(parsed);
    } catch { /* skip invalid JSON */ }
  }
  return schemas;
}

/**
 * Every `@type` named anywhere in these payloads.
 *
 * Walks every value, not just the node keys `flattenJsonLd` follows, and the
 * difference is deliberate: this answers "does this page mention `Article` at all",
 * which is what `identifyPage` needs to classify a **Page Kind**, whereas
 * `flattenJsonLd` answers "which nodes does this page declare", which is what a
 * check needs before it can assert one is missing. A type buried in a property this
 * module would not treat as a node still tells you what the page is about.
 */
export function getSchemaTypes(schemas: readonly unknown[]): Set<string> {
  const types = new Set<string>();
  function traverse(obj: unknown): void {
    if (!obj || typeof obj !== "object") return;
    if (Array.isArray(obj)) { obj.forEach(traverse); return; }
    const rec = obj as Record<string, unknown>;
    const t = rec["@type"];
    if (typeof t === "string") types.add(t);
    if (Array.isArray(t)) t.forEach((v) => typeof v === "string" && types.add(v));
    for (const val of Object.values(rec)) traverse(val);
  }
  schemas.forEach(traverse);
  return types;
}
