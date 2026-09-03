import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import seoEeatScore from "@/tools/seo-eeat-score";
import { serve } from "../helpers/serve";
import { resetAllSingleFlightCaches } from "@/lib/single-flight";

/**
 * Three trustworthiness indicators ask whether the SITE publishes a privacy
 * policy, an about page and contact details. They used to decide it from whatever
 * this one page happened to link — 15 points, and an ordinary deep article on a
 * site with a full footer scored 0 on all three because the template it renders
 * under carries no chrome.
 *
 * This file goes through the Tool, deliberately, while the E-E-A-T scoring itself
 * is tested against the pure `scoreEeat` in `tests/lib/analyzers/`. Its subject IS
 * the second read: whether a bare deep article sends us to the site home, and what
 * happens when the home does not answer. That runs end to end or not at all.
 */

const originalFetch = globalThis.fetch;

beforeEach(resetAllSingleFlightCaches);

afterEach(() => {
  globalThis.fetch = originalFetch;
  resetAllSingleFlightCaches();
  vi.restoreAllMocks();
});

// `fetchHtml` caches by URL, so every case needs its own page URL.
const article = (name: string) => `https://trust.example/blog/${name}`;

/** A deep article with no chrome at all: no footer, no nav, no trust links. */
const BARE_ARTICLE = `<!DOCTYPE html>
<html lang="en">
  <head><title>How we migrated 40 sites</title>
    <script type="application/ld+json">{"@type":"Article","headline":"How we migrated 40 sites","datePublished":"2026-01-04"}</script>
  </head>
  <body><main>
    <h1>How we migrated 40 sites</h1>
    <p>I migrated 40 client sites last year and the results surprised me.</p>
  </main></body>
</html>`;

/** A home with the full footer the article's template does not render. */
const FULL_HOME = `<!DOCTYPE html>
<html lang="en"><body>
  <h1>Trust Example</h1>
  <footer>
    <a href="/privacy-policy">Privacy policy</a>
    <a href="/about-us">About us</a>
    <a href="mailto:hola@trust.example">Email us</a>
  </footer>
</body></html>`;

const SITE_SIGNALS = ["Privacy policy", "About page", "Contact information"] as const;

/**
 * What the module is worth when every indicator applies. Not 100: "Before/after
 * evidence" was retired to 0 points, because no word list shows that a page
 * documents a transformation.
 */
const EEAT_MAX = 91;

type Indicator = { mark: string; earned: number | null; words: string | null; details: string };

/** Read one indicator back out of the text an agent is given. */
function indicatorOf(text: string, signal: string): Indicator {
  const lines = text.split("\n");
  const at = lines.findIndex((line) => line.trim().slice(2).startsWith(`${signal} (`));
  if (at === -1) throw new Error(`no indicator named ${signal}`);

  const line = lines[at].trim();
  const mark = line[0];
  const inside = line.slice(line.indexOf("(") + 1, line.lastIndexOf(")"));
  const fraction = inside.match(/^(\d+)\/(\d+) pts$/);
  // The detail sits on the next line, indented further than the indicator itself.
  const next = lines[at + 1] ?? "";
  const details = next.startsWith("     ") ? next.trim() : "";

  return {
    mark,
    earned: fraction ? Number(fraction[1]) : null,
    words: fraction ? null : inside,
    details,
  };
}

async function score(name: string, home?: string): Promise<string> {
  const target = article(name);
  serve(
    home
      ? { [target]: { body: BARE_ARTICLE }, "https://trust.example/": { body: home } }
      : { [target]: { body: BARE_ARTICLE } },
  );
  const result = await seoEeatScore({ url: target });
  expect(result.isError).toBeUndefined();
  return result.content.map((part) => part.text).join("\n");
}

describe("seo_eeat_score answers a site-level question about the site", () => {
  it("credits a deep article for the trust pages its site publishes", async () => {
    const text = await score("full-footer", FULL_HOME);

    for (const signal of SITE_SIGNALS) {
      expect(indicatorOf(text, signal).mark, signal).toBe("✓");
      expect(indicatorOf(text, signal).earned, signal).toBe(5);
    }
  });

  it("tells the reader the link is on the home and not on this page", async () => {
    const text = await score("says-where", FULL_HOME);

    // Still a pass — the site has a privacy policy. What changed is the advice:
    // the reader has a template global chrome does not reach, not a missing page.
    expect(indicatorOf(text, "Privacy policy").details).toMatch(
      /site home, but not from this page/,
    );
  });

  it("still fails a site that genuinely publishes none of them", async () => {
    const text = await score(
      "truly-bare",
      `<!DOCTYPE html><html lang="en"><body><h1>Nothing here</h1></body></html>`,
    );

    for (const signal of SITE_SIGNALS) {
      expect(indicatorOf(text, signal).mark, signal).toBe("✗");
      expect(indicatorOf(text, signal).earned, signal).toBe(0);
      expect(indicatorOf(text, signal).details, signal).toMatch(/on this page or the site home/);
    }
  });

  it("does not score a site whose home could not be read", async () => {
    // A 404 on the home is not evidence that the site has no privacy policy, so
    // the 15 points leave the denominator rather than the score.
    const text = await score("home-unreachable");

    for (const signal of SITE_SIGNALS) {
      expect(indicatorOf(text, signal).mark, signal).toBe("?");
      expect(indicatorOf(text, signal).words, signal).toBe("not run");
      expect(indicatorOf(text, signal).details, signal).toMatch(/Not scored:/);
    }
    expect(text).toContain(`/ ${EEAT_MAX - 15} (`);
  });

  it("says what the score is not, before saying what it is", async () => {
    const text = await score("disclaimer", FULL_HOME);

    expect(text).toMatch(/^Note: This score uses on-page signals as proxies/);
    expect(text).toContain("=== E-E-A-T SCORE ===");
    expect(text).toMatch(/Grade: (Excellent|Good|Fair|Poor)/);
  });

  it("names the status when the page cannot be read", async () => {
    serve({ "trust.example": { status: 404, body: "Not Found" } });

    const result = await seoEeatScore({ url: "https://trust.example/blog/gone" });

    expect(result.isError).toBe(true);
    expect(result.content.map((part) => part.text).join("\n")).toContain("HTTP 404");
  });
});
