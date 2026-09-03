/**
 * `@id` references are pointers, not nodes.
 *
 * angelcruz.dev ships three `ld+json` blocks — `WebSite`, `Organization`, `Person` —
 * and the `WebSite` points at the Person by `@id`:
 *
 *     "author": { "@type": "Person", "@id": "https://www.angelcruz.dev/#person" }
 *
 * That is the whole point of `@id`, and it is not a second Person. Counting it as
 * one reported "TOTAL SCHEMAS 4 / INVALID 1" on a page whose markup is correct, and
 * the invalid one was the pointer, failed for a `name` a pointer never carries.
 *
 * The resolution has to see every block at once: the reference sits in the first
 * block and the node it names is in the third.
 */
import { describe, it, expect } from "vitest";

import { declaredNodes, isNodeReference, flattenJsonLd } from "@/lib/analyzers/json-ld-graph";

/** The real shape of angelcruz.dev's homepage, one entry per `<script>` tag. */
const WEBSITE = {
  "@context": "https://schema.org",
  "@type": "WebSite",
  "@id": "https://www.angelcruz.dev/#website",
  name: "Angel Cruz · Software Developer",
  url: "https://www.angelcruz.dev",
  publisher: { "@id": "https://www.angelcruz.dev/#organization" },
  author: { "@type": "Person", "@id": "https://www.angelcruz.dev/#person" },
};

const ORGANIZATION = {
  "@context": "https://schema.org",
  "@type": "Organization",
  "@id": "https://www.angelcruz.dev/#organization",
  name: "Angel Cruz · Software Developer",
  url: "https://www.angelcruz.dev",
};

const PERSON = {
  "@context": "https://schema.org",
  "@type": "Person",
  "@id": "https://www.angelcruz.dev/#person",
  name: "Angel Cruz",
  jobTitle: "Desarrollador Full Stack",
};

const BLOCKS = [WEBSITE, ORGANIZATION, PERSON];

describe("telling a pointer from a node", () => {
  it("calls @id-with-@type a reference", () => {
    expect(isNodeReference({ "@type": "Person", "@id": "x" })).toBe(true);
  });

  it("calls a bare @id a reference", () => {
    // The `publisher` form, which omits the type entirely.
    expect(isNodeReference({ "@id": "x" })).toBe(true);
  });

  it("does not call a described node a reference", () => {
    expect(isNodeReference(PERSON)).toBe(false);
    // One field of its own is enough to be a description.
    expect(isNodeReference({ "@type": "Person", "@id": "x", name: "A" })).toBe(false);
  });

  it("does not call an inline node a reference just for having no @id", () => {
    expect(isNodeReference({ "@type": "Person", name: "A" })).toBe(false);
  });
});

describe("the nodes a page declares", () => {
  it("counts the three angelcruz.dev declares, not four", () => {
    const nodes = declaredNodes(BLOCKS);
    expect(nodes.map((n) => n["@type"])).toEqual(["WebSite", "Organization", "Person"]);
  });

  it("resolves a reference against a node in a different block", () => {
    // The reference is in block 1, the Person in block 3. Reading a block on its
    // own cannot resolve it, which is why this takes the whole set.
    expect(flattenJsonLd(WEBSITE).map((n) => n["@type"])).toEqual(["WebSite", "Person"]);
    expect(declaredNodes([WEBSITE]).map((n) => n["@type"])).toEqual(["WebSite", "Person"]);
    expect(declaredNodes(BLOCKS).filter((n) => n["@type"] === "Person")).toHaveLength(1);
  });

  it("returns the described Person, not the pointer to it", () => {
    const person = declaredNodes(BLOCKS).find((n) => n["@type"] === "Person")!;
    expect(person.name).toBe("Angel Cruz");
  });

  it("keeps a reference that resolves to nothing", () => {
    // A pointer to a node no block declares is a broken graph. An assistant
    // following that `@id` finds nothing, so neither should we pretend otherwise.
    const dangling = { "@type": "WebSite", "@id": "#w", author: { "@type": "Person", "@id": "#nobody" } };
    expect(declaredNodes([dangling]).map((n) => n["@type"])).toEqual(["WebSite", "Person"]);
  });

  it("keeps an inline node that carries its own data", () => {
    // The other correct way to write it: no `@id`, the author spelled out in place.
    const inline = { "@type": "BlogPosting", author: { "@type": "Person", name: "Angel" } };
    expect(declaredNodes([inline]).map((n) => n["@type"])).toEqual(["BlogPosting", "Person"]);
  });

  it("keeps a genuine repeat of one type", () => {
    // Grouping in the report shows a count, and it must be a real count. Two
    // described Organizations are two Organizations.
    const two = {
      "@graph": [
        { "@type": "Organization", "@id": "#a", name: "A" },
        { "@type": "Organization", "@id": "#b", name: "B" },
      ],
    };
    expect(declaredNodes([two])).toHaveLength(2);
  });
});
