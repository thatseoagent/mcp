import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import aiVisibilityScore from "@/tools/ai-visibility-score";
import { serve, type Route } from "../helpers/serve";
import { resetAllSingleFlightCaches } from "@/lib/single-flight";

const originalFetch = globalThis.fetch;

beforeEach(() => {
  resetAllSingleFlightCaches();
  // Unset so no case reaches the real Knowledge Graph API.
  delete process.env.GOOGLE_KG_API_KEY;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  resetAllSingleFlightCaches();
  vi.restoreAllMocks();
});

const PAGE = "https://acme.test/guides/widgets";

/** The page under test, plus the files and APIs every run reads beside it. */
function servePage(html: string, extra: Record<string, Route> = {}): void {
  serve({
    [PAGE]: { body: html },
    "robots.txt": { body: "" },
    "llms.txt": { status: 404, body: "" },
    // Wikidata answers "no match" rather than failing, so a case that is not about
    // the lookup does not fill its output with "not run". Overridable: `extra`
    // comes last, and a route matches on the first key the URL contains.
    "wikidata.org": { body: JSON.stringify({ search: [] }) },
    ...extra,
  });
}

const scoreOf = async (url = PAGE): Promise<string> => {
  const result = await aiVisibilityScore({ url });
  return result.content.map((part) => part.text).join("\n");
};

const ORG_PAGE = `<html lang="en"><head><title>Widgets</title>
  <script type="application/ld+json">
    {"@context":"https://schema.org","@type":"Organization","name":"Acme Widgets",
     "url":"https://acme.test","sameAs":["https://twitter.com/acme"]}
  </script></head>
  <body><h1>Widgets</h1><p>We make widgets.</p></body></html>`;

describe("ai_visibility_score", () => {
  it("reports all four layers of the stack", async () => {
    servePage(ORG_PAGE);

    const text = await scoreOf();

    expect(text).toContain("=== AI VISIBILITY SCORE — The Stack ===");
    expect(text).toMatch(/── L1 Entity Establishment: \d+\/\d+/);
    expect(text).toContain("── L2 Entity Depth: Informational ──");
    expect(text).toContain("── L3 Category Citation: Manual Check Required ──");
    expect(text).toMatch(/── L4 Informational Citation: \d+\/\d+/);
    expect(text).toContain("=== TOP ACTIONS (prioritized by layer impact) ===");
  });

  it("searches for the brand the page declares, not the domain label", async () => {
    // Both external searches used to go out carrying the hostname's first label —
    // "Acme" for acme.test — while the page's own `Organization.name` sat unparsed.
    servePage(ORG_PAGE);

    expect(await scoreOf()).toContain("Brand: Acme Widgets");
  });

  it("says the brand was assumed when the page names itself nowhere", async () => {
    // No schema, no `og:site_name`, no title: `publishingEntity` reads all three
    // before it gives up, and only then is the domain label a guess of ours.
    servePage(`<html lang="en"><head></head><body><h1>Hi</h1></body></html>`);

    expect(await scoreOf()).toContain("(assumed from the domain");
  });

  it("names the AI crawlers a site shuts out", async () => {
    // Through `parseRobots`, which knows what a group is: with no blank line
    // between the blocks, a record parser collapses them and reports nothing.
    servePage(ORG_PAGE, {
      "robots.txt": { body: "User-agent: GPTBot\nDisallow: /\nUser-agent: *\nAllow: /\n" },
    });

    expect(await scoreOf()).toMatch(/GPTBot/);
  });

  it("excludes a lookup that did not answer from both sides of the score", async () => {
    // Charging for a question nobody managed to ask is the failure this guards.
    servePage(ORG_PAGE, { "wikidata.org": { status: 503, body: "" } });

    const text = await scoreOf();

    expect(text).toMatch(/Coverage: \d+ pts could not be evaluated on this run/);
    expect(text).toMatch(/\? .*Wikidata.*\(not run\)/);
  });

  it("runs no checks at all on a URL that cannot be read", async () => {
    // An unreadable URL would otherwise be scored as a site with no entity
    // signals rather than as a URL that does not exist.
    serve({ "acme.test": { status: 404, body: "Not Found" } });

    const result = await aiVisibilityScore({ url: PAGE });
    const text = result.content.map((part) => part.text).join("\n");

    expect(result.isError).toBe(true);
    expect(text).toContain("Not scored: the page could not be read.");
    expect(text).not.toContain("L1 Entity Establishment");
  });
});
