import { describe, it, expect } from "vitest";
import { GOOGLE_SCOPES, SCOPE_URLS, describeScopes } from "@/lib/google/scopes";

describe("the scopes this server asks for", () => {
  it("asks for read-only access and nothing else", () => {
    // A design constraint rather than a default. Search Console offers
    // `webmasters`, which would let this server submit sitemaps and request
    // indexing; an Operator granting access to *look* at their data has not
    // agreed to have it changed, and a read-only token cannot be turned into a
    // write by a later bug or a later Tool.
    for (const scope of GOOGLE_SCOPES) {
      expect(scope.url, scope.product).toMatch(/\.readonly$/);
    }
  });

  it("asks for no more than the two products it reads", () => {
    // Every extra scope is another permission on the consent screen. If this
    // count grows, the reason has to be written down next to it.
    expect(SCOPE_URLS).toEqual([
      "https://www.googleapis.com/auth/webmasters.readonly",
      "https://www.googleapis.com/auth/analytics.readonly",
    ]);
  });

  it("says what stops working without each one", () => {
    // The consent screen lists permissions over the Operator's own data. The
    // honest thing is to have told them beforehand what each one buys, in terms
    // of Tools rather than of API surfaces.
    for (const scope of GOOGLE_SCOPES) {
      expect(scope.withoutIt.length, scope.product).toBeGreaterThan(40);
      expect(scope.withoutIt, scope.product).toMatch(/Tool|report/i);
    }
  });

  it("renders every scope, its URL and its reason for a person about to authorize", () => {
    const text = describeScopes().join("\n");

    for (const scope of GOOGLE_SCOPES) {
      expect(text).toContain(scope.url);
      expect(text).toContain(scope.product);
      expect(text).toContain(scope.withoutIt);
    }
    expect(text).toContain("never submits a sitemap");
  });
});
