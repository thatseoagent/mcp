/**
 * Flattening a JSON-LD payload into its nodes.
 *
 * Auditing joost.blog exposed why this exists: the page ships one `ld+json` block
 * whose `@graph` holds 21 nodes, including `WebSite`, `Person`, `BreadcrumbList`
 * and eight `Organization`s. The report said "0 of 1 schemas valid" and "Missing:
 * Organization, WebSite" — on the site of Yoast's founder. `@graph` is what Yoast
 * and Rank Math emit, so it is the common shape, not an edge case.
 */
import { describe, it, expect } from "vitest";

import { flattenJsonLd, findJsonLdNode, findNodeInAll, findNodeWith, findPageAuthor } from "@/lib/analyzers/json-ld-graph";

const types = (nodes: Record<string, unknown>[]) => nodes.map((n) => n["@type"]);

describe("flattenJsonLd", () => {
  it("returns a single node as itself", () => {
    expect(types(flattenJsonLd({ "@type": "Organization", name: "A" }))).toEqual(["Organization"]);
  });

  it("expands a top-level array", () => {
    const nodes = flattenJsonLd([{ "@type": "Organization" }, { "@type": "WebSite" }]);
    expect(types(nodes)).toEqual(["Organization", "WebSite"]);
  });

  it("expands @graph, which is the shape Yoast and Rank Math emit", () => {
    const payload = {
      "@context": "https://schema.org",
      "@graph": [
        { "@type": "WebSite", name: "Joost" },
        { "@type": "Person", name: "Joost de Valk" },
        { "@type": "Organization", name: "Yoast" },
        { "@type": "BreadcrumbList" },
      ],
    };
    expect(types(flattenJsonLd(payload))).toEqual(["WebSite", "Person", "Organization", "BreadcrumbList"]);
  });

  it("does not return the @graph wrapper, which declares no type of its own", () => {
    const nodes = flattenJsonLd({ "@context": "https://schema.org", "@graph": [{ "@type": "WebSite" }] });
    expect(nodes).toHaveLength(1);
    expect(nodes[0]["@type"]).toBe("WebSite");
  });

  it("finds a node nested as a property, not only in @graph", () => {
    // An inline author is a Person declaration, and a Person check should see it.
    const payload = {
      "@type": "BlogPosting",
      author: { "@type": "Person", name: "Joost", sameAs: ["https://x.com/jdevalk"] },
    };
    expect(types(flattenJsonLd(payload))).toEqual(["BlogPosting", "Person"]);
  });

  it("walks an itemListElement", () => {
    const payload = {
      "@type": "BreadcrumbList",
      itemListElement: [{ "@type": "ListItem", position: 1 }, { "@type": "ListItem", position: 2 }],
    };
    expect(types(flattenJsonLd(payload))).toEqual(["BreadcrumbList", "ListItem", "ListItem"]);
  });

  it("keeps an array @type", () => {
    const nodes = flattenJsonLd({ "@graph": [{ "@type": ["Person", "Author"] }] });
    expect(nodes).toHaveLength(1);
  });

  it("returns nothing for payloads that declare nothing", () => {
    expect(flattenJsonLd(null)).toEqual([]);
    expect(flattenJsonLd("a string")).toEqual([]);
    expect(flattenJsonLd({ "@context": "https://schema.org" })).toEqual([]);
    expect(flattenJsonLd({ "@graph": [] })).toEqual([]);
  });

  it("survives a self-referential payload instead of recursing forever", () => {
    const a: Record<string, unknown> = { "@type": "Organization" };
    a.publisher = a;
    expect(() => flattenJsonLd(a)).not.toThrow();
    expect(flattenJsonLd(a).length).toBeGreaterThan(0);
  });

  it("returns nodes by reference, so a caller reads what the page published", () => {
    const org = { "@type": "Organization", sameAs: ["https://linkedin.com/x"] };
    const [found] = flattenJsonLd({ "@graph": [org] });
    expect(found).toBe(org);
  });
});

describe("findJsonLdNode", () => {
  const yoastLike = {
    "@context": "https://schema.org",
    "@graph": [
      { "@type": "WebSite", url: "https://joost.blog/" },
      { "@type": "Person", name: "Joost de Valk", sameAs: ["https://x.com/jdevalk"] },
      { "@type": "Organization", name: "Yoast", logo: { "@type": "ImageObject" } },
    ],
  };

  it("finds a node inside @graph", () => {
    expect(findJsonLdNode(yoastLike, ["Organization"])?.name).toBe("Yoast");
    expect(findJsonLdNode(yoastLike, ["Person"])?.name).toBe("Joost de Valk");
  });

  it("accepts several candidate types and takes the first match in document order", () => {
    expect(findJsonLdNode(yoastLike, ["Article", "WebSite"])?.["@type"]).toBe("WebSite");
  });

  it("returns undefined rather than a false positive", () => {
    expect(findJsonLdNode(yoastLike, ["Product"])).toBeUndefined();
  });

  it("searches every block when a page ships more than one", () => {
    const blocks = [{ "@type": "WebSite" }, { "@graph": [{ "@type": "Product", name: "Thing" }] }];
    expect(findNodeInAll(blocks, ["Product"])?.name).toBe("Thing");
    expect(findNodeInAll(blocks, ["Recipe"])).toBeUndefined();
  });
});

describe("findNodeWith — the right node, not the first one", () => {
  // joost.blog declares eight Organizations, one per company its author is
  // involved with. Only one of them could ever carry the publisher's identity, and
  // it is not necessarily the one serialized first.
  const manyOrgs = [{
    "@graph": [
      { "@type": "Organization", name: "Your.Online", url: "https://your.online/" },
      { "@type": "Organization", name: "Emilia Capital", url: "https://emilia.capital/" },
      {
        "@type": "Organization", name: "Yoast", url: "https://yoast.com/",
        logo: { "@type": "ImageObject" },
        sameAs: ["https://x.com/yoast", "https://linkedin.com/company/yoast"],
      },
    ],
  }];

  it("skips the thin nodes and finds the one that qualifies", () => {
    const withSameAs = findNodeWith(manyOrgs, ["Organization"],
      (n) => Array.isArray(n.sameAs) && n.sameAs.length >= 2);
    expect(withSameAs?.name).toBe("Yoast");

    const withLogo = findNodeWith(manyOrgs, ["Organization"], (n) => !!(n.url && n.logo));
    expect(withLogo?.name).toBe("Yoast");
  });

  it("returns the first match when several qualify", () => {
    const both = [{ "@graph": [{ "@type": "Organization", url: "a", logo: {} }, { "@type": "Organization", url: "b", logo: {} }] }];
    expect(findNodeWith(both, ["Organization"], (n) => !!(n.url && n.logo))?.url).toBe("a");
  });

  it("returns undefined when no node of that type qualifies", () => {
    expect(findNodeWith(manyOrgs, ["Organization"], (n) => !!n.foundingDate)).toBeUndefined();
    expect(findNodeWith(manyOrgs, ["Product"], () => true)).toBeUndefined();
  });
});

describe("findPageAuthor", () => {
  it("does not read the author of a testimonial as the page's author", () => {
    // 10 points, E-E-A-T's largest indicator, awarded for `@type === "Person"` on any
    // node or for an `author` key anywhere — so a customer who wrote a review scored
    // the page as carrying an author bio (#341).
    const payloads = [
      { "@type": "WebPage", name: "Pricing" },
      { "@type": "Review", author: { "@type": "Person", name: "A happy customer" } },
    ];
    expect(findPageAuthor([payloads[0]])).toBeUndefined();
  });

  it("prefers the article's author over the WebPage wrapping it", () => {
    const author = findPageAuthor([{
      "@graph": [
        { "@type": "WebPage", author: { "@type": "Organization", name: "The Studio" } },
        { "@type": "BlogPosting", author: { "@type": "Person", name: "The writer" } },
      ],
    }]);
    expect(author).toEqual({ form: "node", node: { "@type": "Person", name: "The writer" } });
  });

  it("follows an @id reference to the node that declares it", () => {
    // The commonest correct shape there is, and the one ADR-0016 already had to
    // settle for a different check: the author is a pointer, the Person is elsewhere.
    const author = findPageAuthor([
      { "@type": "Article", author: { "@id": "https://example.com/#person" } },
      { "@type": "Person", "@id": "https://example.com/#person", name: "Jane", sameAs: ["https://linkedin.com/in/jane"] },
    ]);
    expect(author?.form).toBe("node");
    if (author?.form === "node") expect(author.node["sameAs"]).toEqual(["https://linkedin.com/in/jane"]);
  });

  it("returns nothing when the reference resolves to nothing", () => {
    // An assistant following that @id finds nothing either.
    expect(findPageAuthor([{ "@type": "Article", author: { "@id": "https://example.com/#ghost" } }])).toBeUndefined();
  });

  it("accepts a string author, which cannot carry sameAs", () => {
    expect(findPageAuthor([{ "@type": "Article", author: "Jane Doe" }])).toEqual({ form: "name", name: "Jane Doe" });
  });
});
