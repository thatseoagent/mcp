import { describe, it, expect } from "vitest";
import {
  hostKey,
  inProperty,
  landingUrl,
  normaliseDomain,
  pathKey,
  propertyDomain,
  propertyRoot,
  sameUrl,
  siteOrigin,
  urlKey,
  type UrlKeyOptions,
} from "@/lib/url-match";
import { InvalidInputError } from "@/lib/invalid-input-error";

/**
 * One rule for "the same page" and "the same host", because Search Console, GA4,
 * the crawl and sitemaps are crossed by a dozen Tools and a disagreement between
 * any two of them is a false orphan, a false zombie or a page joined in one
 * report and missing from the next.
 */

describe("hostKey", () => {
  it.each<[string, string | null, string]>([
    ["example.com", "example.com", "a bare domain"],
    ["Example.COM", "example.com", "case"],
    ["www.example.com", "example.com", "a leading www."],
    ["example.com.", "example.com", "a trailing dot"],
    ["  www.Example.com.  ", "example.com", "all of them, with whitespace"],
    ["https://www.example.com/pricing?a=1#x", "example.com", "a URL"],
    ["www.example.com/pricing", "example.com", "a domain with a path"],
    ["https://example.com:8443/", "example.com", "a port"],
    ["sc-domain:www.example.com", "example.com", "a Domain Property"],
    ["https://shop.example.com/", "shop.example.com", "a URL-Prefix Property"],
    ["blog.example.com", "blog.example.com", "a subdomain other than www"],
    ["wwwexample.com", "wwwexample.com", "www with no dot is part of the name"],
    ["", null, "nothing"],
    ["   ", null, "whitespace"],
    ["not a host", null, "something with a space in it"],
    ["https://", null, "a scheme and no host"],
  ])("%j → %j (%s)", (input, expected) => {
    expect(hostKey(input)).toBe(expected);
  });
});

describe("urlKey and sameUrl", () => {
  it.each<[string, string | null, string]>([
    ["https://www.example.com/pricing/", "example.com/pricing", "www. and a trailing slash"],
    ["http://example.com/pricing", "example.com/pricing", "the scheme"],
    ["https://EXAMPLE.com/pricing#plans", "example.com/pricing", "host case and the fragment"],
    ["https://example.com:443/pricing//", "example.com/pricing", "the default port, repeated slashes"],
    ["https://example.com./pricing", "example.com/pricing", "a trailing dot on the host"],
    ["https://example.com:8080/pricing", "example.com:8080/pricing", "a port that is not the default"],
    ["https://example.com", "example.com/", "the root stays a slash"],
    ["https://example.com/blog/?page=2", "example.com/blog?page=2", "the query is kept"],
    ["https://example.com/a?", "example.com/a", "an empty query is none"],
    ["https://example.com/About", "example.com/About", "path case is kept"],
    ["https://blog.example.com/x", "blog.example.com/x", "a subdomain is kept"],
    ["mailto:a@example.com", null, "not http(s)"],
    ["not a url", null, "not a URL"],
  ])("%j → %j (%s)", (url, expected) => {
    expect(urlKey(url)).toBe(expected);
  });

  it("resolves a relative href against its page, as the crawler does", () => {
    expect(urlKey("/about/", "https://www.example.com/team")).toBe("example.com/about");
  });

  it.each<[string, string, UrlKeyOptions | undefined, boolean, string]>([
    ["https://example.com", "https://www.example.com/", undefined, true, "www. and the root slash"],
    ["https://example.com/blog?page=2", "https://example.com/blog", undefined, false, "the query is its own URL"],
    ["https://example.com/blog?page=2", "https://example.com/blog/?page=2", undefined, true, "the slash is not"],
    ["https://example.com/About", "https://example.com/about", undefined, false, "path case"],
    ["https://blog.example.com/x", "https://example.com/x", undefined, false, "another subdomain"],
    ["not a url", "not a url", undefined, false, "unparseable is the same page as nothing"],
    // The crawler's de-duplication.
    ["https://example.com/list?page=2", "https://example.com/list/", { query: "drop" }, true, "query dropped"],
    // Declared URLs: canonical and hreflang.
    ["http://example.com/a", "https://example.com/a", { origin: "exact" }, false, "exact: the scheme"],
    ["https://www.example.com/a", "https://example.com/a", { origin: "exact" }, false, "exact: www."],
    ["https://EXAMPLE.com/a/", "https://example.com/a#x", { origin: "exact" }, true, "exact: still case, slash, fragment"],
    ["https://example.com/a?b=1", "https://example.com/a", { origin: "exact" }, false, "exact: the query"],
  ])("%j and %j with %j → %j (%s)", (a, b, options, expected) => {
    expect(sameUrl(a, b, options)).toBe(expected);
  });
});

describe("pathKey", () => {
  it.each<[string, string | null, string]>([
    ["https://example.com/pricing/?utm=x#top", "/pricing", "scheme, host, query, fragment, slash"],
    ["/pricing?ref=1", "/pricing", "a GA4 path with a query"],
    ["/pricing/", "/pricing", "a trailing slash"],
    ["https://example.com", "/", "the root of a URL"],
    ["https://example.com/", "/", "the root with a slash"],
    ["/", "/", "GA4's root"],
    ["/About", "/About", "case is kept"],
    ["(not set)", null, "GA4's (not set)"],
    ["", null, "GA4's empty landing page"],
  ])("%j → %j (%s)", (input, expected) => {
    expect(pathKey(input)).toBe(expected);
  });

  it("meets an encoded and a decoded spelling of the same path", () => {
    expect(pathKey("https://example.com/caf%C3%A9")).toBe(pathKey("/café"));
  });
});

describe("landingUrl", () => {
  it.each<[string, string | null, string]>([
    ["/", "https://example.com/", "the root is a page"],
    ["/a?b=1", "https://example.com/a?b=1", "a path with a query"],
    ["//evil.example/x", "https://example.com//evil.example/x", "a double slash stays on the site"],
    ["", null, "empty is unattributed, not the root"],
    ["(not set)", null, "(not set) is unattributed"],
  ])("%j → %j (%s)", (landingPage, expected) => {
    expect(landingUrl("https://example.com", landingPage)).toBe(expected);
  });

  it("agrees with pathKey on which landing pages name no page", () => {
    for (const page of ["", "(not set)", "/", "/a?b=1"]) {
      expect(landingUrl("https://example.com", page) === null, page).toBe(pathKey(page) === null);
    }
  });
});

describe("the two property shapes", () => {
  it.each<[string, string | null, string, string]>([
    ["sc-domain:example.com", "example.com", "https://example.com/", "a Domain Property"],
    ["sc-domain:Example.com", "example.com", "https://example.com/", "a Domain Property, cased"],
    ["sc-domain:www.example.com", "www.example.com", "https://www.example.com/", "a narrower Domain Property"],
    ["https://shop.example.com/", null, "https://shop.example.com/", "a URL-Prefix Property"],
    ["sc-domain:", null, "sc-domain:", "a Domain Property naming nothing"],
  ])("%j: domain %j, root %j (%s)", (property, domain, root) => {
    expect(propertyDomain(property)).toBe(domain);
    expect(propertyRoot(property)).toBe(root);
  });

  it.each<[string, string, boolean, string]>([
    ["http://blog.example.com/a", "sc-domain:example.com", true, "any subdomain, any scheme"],
    ["https://example.com/", "sc-domain:example.com", true, "the domain itself"],
    ["https://notexample.com/", "sc-domain:example.com", false, "a suffix that is not a subdomain"],
    ["https://example.com/", "sc-domain:www.example.com", false, "not above a narrower Domain Property"],
    ["https://shop.example.com/a", "https://shop.example.com/", true, "inside the prefix"],
    ["http://shop.example.com/a", "https://shop.example.com/", false, "the prefix's scheme counts"],
    ["https://example.com/a", "https://shop.example.com/", false, "outside the prefix"],
    ["not a url", "sc-domain:example.com", false, "not a URL"],
  ])("%j in %j → %j (%s)", (url, property, expected) => {
    expect(inProperty(url, property)).toBe(expected);
  });
});

describe("a domain an Operator typed", () => {
  it.each([
    "example.com",
    "www.example.com",
    "https://example.com",
    "https://www.example.com/pricing?a=1",
    "  EXAMPLE.com  ",
    "example.com.",
  ])("stores %j as the one Site example.com", (input) => {
    expect(normaliseDomain(input)).toBe("example.com");
  });

  it("keeps a subdomain, because that really is a different Site", () => {
    // An Operator may legitimately want `example.com` and `blog.example.com` as
    // separate Sites with separate histories.
    expect(normaliseDomain("blog.example.com")).toBe("blog.example.com");
  });

  it.each(["localhost", "", "not a domain"])("refuses %j with a sentence", (input) => {
    expect(() => normaliseDomain(input)).toThrow(InvalidInputError);
    expect(() => siteOrigin(input)).toThrow(InvalidInputError);
  });

  it.each<[string, string]>([
    ["example.com", "https://example.com"],
    ["www.example.com/pricing", "https://www.example.com"],
    ["http://Example.com:8080/x", "http://example.com:8080"],
  ])("fetches %j from %j, www. kept because that is where requests go", (input, origin) => {
    expect(siteOrigin(input)).toBe(origin);
  });
});
