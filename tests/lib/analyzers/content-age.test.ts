/**
 * Content Age — the second date question.
 *
 * `isUndatedPage` answers "should this page carry a date at all". These pin the
 * other one: "this page has a date, and it is three years old". The two are
 * composed, never conflated — an undated *kind* has no age, and an *unknown*
 * age is never allowed to read as legacy.
 */
import { describe, it, expect } from "vitest";

import {
  readContentAge,
  agedSeverity,
  legacyNote,
  LEGACY_AFTER_DAYS,
  UNDATED,
} from "@/lib/analyzers/content-age";

const NOW = Date.parse("2026-08-30T00:00:00.000Z");
const daysAgo = (n: number) => new Date(NOW - n * 86_400_000).toISOString();

describe("readContentAge — where the date comes from", () => {
  it("reads datePublished out of JSON-LD", () => {
    const age = readContentAge([{ "@type": "BlogPosting", datePublished: daysAgo(30) }], "", "article", NOW);
    expect(age.tier).toBe("new");
    expect(age.ageDays).toBe(30);
    expect(age.evidence).toMatch(/JSON-LD/i);
  });

  it("falls back to the article:published_time meta tag", () => {
    const html = `<meta property="article:published_time" content="${daysAgo(900)}">`;
    const age = readContentAge([], html, "article", NOW);
    expect(age.tier).toBe("legacy");
    expect(age.ageDays).toBe(900);
    expect(age.evidence).toMatch(/article:published_time/);
  });

  it("falls back to a visible pubdate <time> element", () => {
    const html = `<time itemprop="datePublished" datetime="${daysAgo(10)}">10 days ago</time>`;
    const age = readContentAge([], html, "article", NOW);
    expect(age.ageDays).toBe(10);
    expect(age.evidence).toMatch(/<time>/);
  });

  /**
   * Yoast, Rank Math and most WordPress SEO plugins ship one `@graph` wrapper
   * holding every node, and `extractJsonLd` returns payloads rather than nodes.
   * A top-level scan reads the wrapper, which declares no `datePublished`, so
   * every such page came back `unknown` and the whole feature was inert on a
   * large share of the sites we audit.
   */
  it("finds the date inside an @graph wrapper", () => {
    const payload = {
      "@context": "https://schema.org",
      "@graph": [
        { "@type": "WebSite", url: "https://example.com/" },
        { "@type": "BlogPosting", datePublished: daysAgo(700) },
      ],
    };
    const age = readContentAge([payload], "", "article", NOW);
    expect(age.tier).toBe("legacy");
    expect(age.ageDays).toBe(700);
  });

  it("prefers the article's own date over another node's", () => {
    const payload = {
      "@graph": [
        { "@type": "WebPage", datePublished: daysAgo(5) },
        { "@type": "NewsArticle", datePublished: daysAgo(900) },
      ],
    };
    expect(readContentAge([payload], "", "article", NOW).ageDays).toBe(900);
  });

  it("accepts an array-valued @type on the article node", () => {
    const payload = { "@graph": [{ "@type": ["Article", "BlogPosting"], datePublished: daysAgo(800) }] };
    expect(readContentAge([payload], "", "article", NOW).ageDays).toBe(800);
  });

  it("never reads dateModified, because that is the signal the tier downgrades", () => {
    // A 2022 post refreshed last week is still a 2022 post. Reading the modified
    // date would also make the freshness rule decide its own severity.
    const age = readContentAge([{ "@type": "Article", dateModified: daysAgo(3) }], "", "article", NOW);
    expect(age.tier).toBe("unknown");
    expect(age.ageDays).toBeNull();
  });
});

describe("readContentAge — the tier", () => {
  it(`calls a page published ${LEGACY_AFTER_DAYS} days ago legacy`, () => {
    expect(readContentAge([{ datePublished: daysAgo(LEGACY_AFTER_DAYS) }], "", "article", NOW).tier).toBe("legacy");
  });

  it("calls a page one day inside the threshold new", () => {
    expect(readContentAge([{ datePublished: daysAgo(LEGACY_AFTER_DAYS - 1) }], "", "article", NOW).tier).toBe("new");
  });

  it("does not let an unknown age become legacy", () => {
    const age = readContentAge([], "<p>nothing dated here</p>", "article", NOW);
    expect(age.tier).toBe("unknown");
    expect(age.evidence).toMatch(/no publication date/i);
  });

  it("treats an unparseable date as unknown rather than guessing", () => {
    expect(readContentAge([{ datePublished: "last Tuesday" }], "", "article", NOW).tier).toBe("unknown");
  });

  it("treats a future date as new, not as a very large negative age", () => {
    const html = `<meta property="article:published_time" content="${new Date(NOW + 86_400_000).toISOString()}">`;
    expect(readContentAge([], html, "article", NOW).tier).toBe("new");
  });

  it("has no age at all for a page kind that is not published on a date", () => {
    const age = readContentAge([{ datePublished: daysAgo(2000) }], "", "homepage", NOW);
    expect(age.tier).toBe("unknown");
    expect(age.evidence).toMatch(/homepage/);
  });
});

describe("agedSeverity — what the tier is allowed to change", () => {
  const legacy = readContentAge([{ datePublished: daysAgo(2000) }], "", "article", NOW);
  const fresh = readContentAge([{ datePublished: daysAgo(5) }], "", "article", NOW);

  it("drops a warning to an opportunity on legacy content", () => {
    expect(agedSeverity("warning", legacy)).toBe("opportunity");
  });

  it("leaves a critical alone, whatever the age", () => {
    expect(agedSeverity("critical", legacy)).toBe("critical");
  });

  it("never downgrades new content", () => {
    expect(agedSeverity("warning", fresh)).toBe("warning");
  });

  it("never downgrades on an unknown age", () => {
    expect(agedSeverity("warning", UNDATED)).toBe("warning");
    expect(agedSeverity("warning", undefined)).toBe("warning");
  });

  it("never upgrades", () => {
    expect(agedSeverity("opportunity", fresh)).toBe("opportunity");
    expect(agedSeverity("opportunity", legacy)).toBe("opportunity");
  });
});

describe("legacyNote — the drop is never silent", () => {
  it("says how old the page is when the tier moved", () => {
    const legacy = readContentAge([{ datePublished: daysAgo(1100) }], "", "article", NOW);
    expect(legacyNote(legacy)).toMatch(/3 years/);
  });

  it("says nothing on content that was not downgraded", () => {
    expect(legacyNote(readContentAge([{ datePublished: daysAgo(5) }], "", "article", NOW))).toBe("");
    expect(legacyNote(UNDATED)).toBe("");
    expect(legacyNote(undefined)).toBe("");
  });
});
