import { describe, it, expect } from "vitest";
import { detectedRichResults, expectsRichResult, producedBy, schemaTypesFor } from "@/lib/rich-result-types";

describe("rich result mapping", () => {
  it("matches Google's report names by keyword, whatever their casing", () => {
    expect(producedBy("Product snippets", "Product")).toBe(true);
    expect(producedBy("Merchant listings", "Product")).toBe(true);
    expect(producedBy("Breadcrumbs", "BreadcrumbList")).toBe(true);
    expect(producedBy("Breadcrumbs", "Product")).toBe(false);
  });

  it("returns null for a rich result it does not map, so it is not compared", () => {
    expect(schemaTypesFor("Some future feature")).toBeNull();
    expect(schemaTypesFor("Videos")).toEqual(["VideoObject"]);
  });

  it("never expects a rich result from sitewide or nested markup", () => {
    expect(expectsRichResult("Organization")).toBe(false);
    expect(expectsRichResult("AggregateRating")).toBe(false);
    expect(expectsRichResult("Article")).toBe(false);
    expect(expectsRichResult("Recipe")).toBe(true);
  });

  it("reads every issue off every item, tolerating Google's optional fields", () => {
    const detected = detectedRichResults({
      inspectionResult: {
        richResultsResult: {
          detectedItems: [
            {
              richResultType: "Product snippets",
              items: [
                { name: "A", issues: [{ issueMessage: "Missing field \"offers\"", severity: "ERROR" }] },
                { name: "B", issues: [{ severity: "WARNING" }] },
                { name: "C" },
              ],
            },
            { items: [] },
            "not an object",
          ],
        },
      },
    });
    expect(detected).toEqual([
      {
        type: "Product snippets",
        issues: [
          { severity: "ERROR", message: "Missing field \"offers\"" },
          { severity: "WARNING", message: "an issue Google did not describe" },
        ],
      },
    ]);
  });

  it("reads nothing out of an inspection with no rich results section", () => {
    expect(detectedRichResults({ inspectionResult: {} })).toEqual([]);
  });
});
