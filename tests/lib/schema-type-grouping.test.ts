/**
 * Grouping the declared schema types.
 *
 * Reading the `@graph` means a page can declare one type several times.
 * angelcruz.dev declares two `Person` nodes, one complete and one missing `name`,
 * and a chip per node put "Person" on the page twice in opposite colours — which
 * reads as a contradiction rather than as two nodes. The grouping below is what the
 * chip list renders from.
 */
import { describe, it, expect } from "vitest";

interface SchemaNode { type: string; valid: boolean; errors: string[] }

/** Mirrors SchemaTypeList's grouping, so the rule is checkable without a DOM. */
function group(schemas: SchemaNode[]) {
  const byType = new Map<string, { total: number; invalid: number; errors: string[] }>();
  for (const s of schemas) {
    const entry = byType.get(s.type) ?? { total: 0, invalid: 0, errors: [] };
    entry.total += 1;
    if (!s.valid) {
      entry.invalid += 1;
      for (const e of s.errors) if (!entry.errors.includes(e)) entry.errors.push(e);
    }
    byType.set(s.type, entry);
  }
  return byType;
}

// The real shape of angelcruz.dev's homepage graph.
const REAL: SchemaNode[] = [
  { type: "WebSite", valid: true, errors: [] },
  { type: "Person", valid: false, errors: ["Missing required field: name"] },
  { type: "Organization", valid: true, errors: [] },
  { type: "Person", valid: true, errors: [] },
];

describe("one chip per type, not per node", () => {
  it("collapses the two Person nodes into one entry", () => {
    const g = group(REAL);
    expect([...g.keys()]).toEqual(["WebSite", "Person", "Organization"]);
    expect(g.get("Person")).toMatchObject({ total: 2, invalid: 1 });
  });

  it("marks a type invalid when any of its nodes is", () => {
    // The old rendering showed Person twice, once red and once green, so the reader
    // could not tell which was which. One entry, and it reports the fault.
    expect(group(REAL).get("Person")!.invalid).toBe(1);
    expect(group(REAL).get("WebSite")!.invalid).toBe(0);
  });

  it("carries the validation errors, which the report never showed", () => {
    // "Invalid 1" with no reason left the reader guessing at the one thing they
    // need in order to fix it.
    expect(group(REAL).get("Person")!.errors).toEqual(["Missing required field: name"]);
  });

  it("does not repeat an error two nodes of a type share", () => {
    const g = group([
      { type: "Product", valid: false, errors: ["Missing required field: name"] },
      { type: "Product", valid: false, errors: ["Missing required field: name"] },
    ]);
    expect(g.get("Product")).toMatchObject({ total: 2, invalid: 2 });
    expect(g.get("Product")!.errors).toEqual(["Missing required field: name"]);
  });

  it("keeps every distinct error when nodes fail differently", () => {
    const g = group([
      { type: "Product", valid: false, errors: ["Missing required field: name"] },
      { type: "Product", valid: false, errors: ["Missing required field: offers"] },
    ]);
    expect(g.get("Product")!.errors.sort()).toEqual([
      "Missing required field: name",
      "Missing required field: offers",
    ]);
  });

  it("preserves document order of first appearance", () => {
    const g = group([
      { type: "B", valid: true, errors: [] },
      { type: "A", valid: true, errors: [] },
      { type: "B", valid: true, errors: [] },
    ]);
    expect([...g.keys()]).toEqual(["B", "A"]);
  });

  it("counts totals that match the summary the card prints above it", () => {
    const g = group(REAL);
    const total = [...g.values()].reduce((n, v) => n + v.total, 0);
    const invalid = [...g.values()].reduce((n, v) => n + v.invalid, 0);
    // "TOTAL SCHEMAS 4 / VALID 3 / INVALID 1" must agree with the chips below it.
    expect(total).toBe(4);
    expect(invalid).toBe(1);
    expect(total - invalid).toBe(3);
  });
});
