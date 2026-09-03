import { describe, expect, it } from "vitest";
import {
  isPathAllowed,
  groupFor,
  parseRobots,
  NO_ROBOTS,
  type RobotsGroup,
} from "@/lib/analyzers/robots-ruleset";

const groups = (...g: RobotsGroup[]) => g;

describe("path matching, as Google documents it", () => {
  it("allows anything robots.txt does not name", () => {
    const g = groups({ userAgent: "*", rules: [{ type: "disallow", pattern: "/admin" }] });
    expect(isPathAllowed(g, "/blog/post")).toBe(true);
  });

  it("disallows by prefix", () => {
    const g = groups({ userAgent: "*", rules: [{ type: "disallow", pattern: "/admin" }] });
    expect(isPathAllowed(g, "/admin/users")).toBe(false);
  });

  it("treats an empty Disallow as allowing everything", () => {
    const g = groups({ userAgent: "*", rules: [{ type: "disallow", pattern: "" }] });
    expect(isPathAllowed(g, "/anything")).toBe(true);
  });

  it("lets the longest matching rule win, so Allow can carve an exception", () => {
    const g = groups({
      userAgent: "*",
      rules: [
        { type: "disallow", pattern: "/products" },
        { type: "allow", pattern: "/products/featured" },
      ],
    });
    expect(isPathAllowed(g, "/products/archive")).toBe(false);
    expect(isPathAllowed(g, "/products/featured/shoes")).toBe(true);
  });

  it("gives an equal-length tie to allow, the least restrictive rule", () => {
    const g = groups({
      userAgent: "*",
      rules: [
        { type: "disallow", pattern: "/page" },
        { type: "allow", pattern: "/page" },
      ],
    });
    expect(isPathAllowed(g, "/page")).toBe(true);
  });
});

describe("wildcards", () => {
  it("expands * to any run of characters", () => {
    const g = groups({ userAgent: "*", rules: [{ type: "disallow", pattern: "/*.pdf" }] });
    expect(isPathAllowed(g, "/docs/manual.pdf")).toBe(false);
    expect(isPathAllowed(g, "/docs/manual.html")).toBe(true);
  });

  it("anchors $ to the end of the URL", () => {
    const g = groups({ userAgent: "*", rules: [{ type: "disallow", pattern: "/*.php$" }] });
    expect(isPathAllowed(g, "/index.php")).toBe(false);
    expect(isPathAllowed(g, "/index.php?id=1")).toBe(true);
  });

  /**
   * Real robots.txt files are full of characters that mean something to a regex
   * and nothing to Google. Converting patterns without escaping turns
   * `/search?q=` into an optional `h`, which quietly matches the wrong paths.
   */
  it("treats regex metacharacters as literals", () => {
    const g = groups({ userAgent: "*", rules: [{ type: "disallow", pattern: "/search?q=" }] });
    expect(isPathAllowed(g, "/search?q=shoes")).toBe(false);
    expect(isPathAllowed(g, "/searcq=shoes")).toBe(true);
  });

  it("does not let a dot match an arbitrary character", () => {
    const g = groups({ userAgent: "*", rules: [{ type: "disallow", pattern: "/a.php" }] });
    expect(isPathAllowed(g, "/axphp")).toBe(true);
  });
});

describe("group selection", () => {
  it("prefers the named crawler over the wildcard group", () => {
    const g = groups(
      { userAgent: "*", rules: [{ type: "disallow", pattern: "/" }] },
      { userAgent: "Googlebot", rules: [{ type: "allow", pattern: "/" }] }
    );
    expect(isPathAllowed(g, "/anything", "Googlebot")).toBe(true);
    expect(isPathAllowed(g, "/anything", "BingBot")).toBe(false);
  });

  it("matches the user agent case-insensitively", () => {
    const g = groups({ userAgent: "googlebot", rules: [{ type: "disallow", pattern: "/x" }] });
    expect(isPathAllowed(g, "/x", "Googlebot")).toBe(false);
  });

  it("falls back to a broader group for a crawler variant", () => {
    const g = groups({ userAgent: "Googlebot", rules: [{ type: "disallow", pattern: "/x" }] });
    // Lowercased: the returned group may be several blocks merged, which can
    // disagree on casing, so it is reported in one canonical form.
    expect(groupFor(g, "Googlebot-Image")?.userAgent).toBe("googlebot");
    expect(isPathAllowed(g, "/x", "Googlebot-Image")).toBe(false);
  });

  /**
   * A file may address the same crawler more than once, and Google merges the
   * blocks. Taking only the first fails open: the second block's Disallow
   * disappears and the path reads as crawlable.
   */
  it("merges repeated blocks for the same user agent", () => {
    const g = groups(
      { userAgent: "*", rules: [{ type: "disallow", pattern: "/admin" }] },
      { userAgent: "*", rules: [{ type: "disallow", pattern: "/private" }] }
    );
    expect(isPathAllowed(g, "/admin/x")).toBe(false);
    expect(isPathAllowed(g, "/private/x")).toBe(false);
    expect(isPathAllowed(g, "/public")).toBe(true);
  });

  it("returns null when no group matches and nothing is a wildcard", () => {
    const g = groups({ userAgent: "BingBot", rules: [{ type: "disallow", pattern: "/" }] });
    expect(groupFor(g, "Googlebot")).toBeNull();
    expect(isPathAllowed(g, "/anything", "Googlebot")).toBe(true);
  });
});

// ── Parsing ──────────────────────────────────────────────────────────────────

describe("parsing a real robots.txt", () => {
  it("reads groups, rules and sitemaps", () => {
    const r = parseRobots(`
User-agent: *
Disallow: /admin/
Allow: /admin/public/

Sitemap: https://example.com/sitemap.xml
    `);

    expect(r.exists).toBe(true);
    expect(r.sitemaps).toEqual(["https://example.com/sitemap.xml"]);
    expect(r.allows("/admin/secret")).toBe(false);
    expect(r.allows("/admin/public/page")).toBe(true);
  });

  it("strips trailing comments from a pattern", () => {
    // Left in, the pattern became "/admin/ # legacy" and matched nothing.
    const r = parseRobots("User-agent: *\nDisallow: /admin/ # legacy");
    expect(r.allows("/admin/x")).toBe(false);
  });

  it("treats an empty Disallow as the allow-everything idiom, not an error", () => {
    const r = parseRobots("User-agent: *\nDisallow:");
    expect(r.allows("/anything")).toBe(true);
    expect(r.issues.filter((i) => i.type === "syntax")).toEqual([]);
  });

  it("gives consecutive User-agent lines one shared set of rules", () => {
    const r = parseRobots("User-agent: GPTBot\nUser-agent: ClaudeBot\nDisallow: /");
    expect(r.blocksEntirely("GPTBot")).toBe(true);
    expect(r.blocksEntirely("ClaudeBot")).toBe(true);
    expect(r.blocksEntirely("Googlebot")).toBe(false);
  });

  it("says which directives Google ignores, rather than calling them unknown", () => {
    const r = parseRobots("User-agent: *\nCrawl-delay: 10\nHost: example.com");
    expect(r.issues.some((i) => /Crawl-delay is ignored by Google/.test(i.message))).toBe(true);
    expect(r.issues.some((i) => /Host is not supported by Google/.test(i.message))).toBe(true);
  });

  it("catches Noindex, which reads like it works and never has", () => {
    const r = parseRobots("User-agent: *\nNoindex: /secret");
    expect(r.issues.find((i) => i.type === "conflict")?.message).toMatch(/not a robots.txt directive/);
  });

  it("has no rules at all when the site serves no robots.txt", () => {
    expect(NO_ROBOTS.exists).toBe(false);
    expect(NO_ROBOTS.allows("/anything")).toBe(true);
    expect(NO_ROBOTS.blocksEntirely("GPTBot")).toBe(false);
  });
});

// ── The contradictions this module exists to end ─────────────────────────────

/**
 * Before one matcher owned the file, these inputs produced different verdicts in
 * different sections of the same audit. Each case is one of those disagreements.
 */
describe("one file, one verdict", () => {
  /**
   * The headline case. `robots-analyzer` counted any disallow rule as a block and
   * reported "GPTBot blocked", while GEO and AI visibility looked only for a
   * literal `Disallow: /` and both reported it allowed — in the same report.
   */
  it("a path restriction is not a site-wide block", () => {
    const r = parseRobots("User-agent: GPTBot\nDisallow: /admin/");

    expect(r.blocksEntirely("GPTBot")).toBe(false);
    expect(r.restrictionsFor("GPTBot")).toEqual(["/admin/"]);
    expect(r.allows("/admin/x", "GPTBot")).toBe(false);
    expect(r.allows("/blog", "GPTBot")).toBe(true);
  });

  /** `geo-analyzer` read this as allowed; `ai-visibility-tools` read it as blocked. */
  it("Disallow: /* is a site-wide block", () => {
    expect(parseRobots("User-agent: GPTBot\nDisallow: /*").blocksEntirely("GPTBot")).toBe(true);
  });

  /** `ai-visibility-tools` matched agent names case-sensitively and missed this. */
  it("matches an agent named in lower case", () => {
    expect(parseRobots("User-agent: gptbot\nDisallow: /").blocksEntirely("GPTBot")).toBe(true);
  });

  /**
   * No blank line between blocks. The blank-line record parser collapsed these
   * into one record, so the `Allow: /` cancelled the block and nothing was
   * reported as blocked.
   */
  it("does not let one group's Allow cancel another group's Disallow", () => {
    const r = parseRobots("User-agent: *\nAllow: /\nUser-agent: GPTBot\nDisallow: /");
    expect(r.blocksEntirely("GPTBot")).toBe(true);
    expect(r.blocksEntirely("Googlebot")).toBe(false);
  });

  /**
   * The crawler refused to crawl a site that had invited it by name, because it
   * unioned the `*` rules with its own instead of taking the most specific group.
   */
  it("honours an invitation addressed to our own crawler", () => {
    const r = parseRobots("User-agent: *\nDisallow: /\n\nUser-agent: ThatSEOAgentBot\nDisallow:");
    expect(r.allows("/any/page", "ThatSEOAgentBot/1.0 (+https://thatseoagent.com/seo-bot)")).toBe(true);
    expect(r.allows("/any/page", "Googlebot")).toBe(false);
  });
});
