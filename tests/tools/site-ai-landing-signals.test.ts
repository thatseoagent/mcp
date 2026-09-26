import { describe, it, expect, afterEach } from "vitest";
import { handler } from "@/tools/site-ai-landing-signals";
import { fakeGoogleReader } from "@/lib/google/fake-reader";
import type { Ga4Report, Ga4ReportQuery } from "@/lib/google/reader";
import { UpstreamApiError } from "@/lib/upstream-api-error";
import { restoreFetch, serve, type Route } from "../helpers/serve";

afterEach(() => {
  restoreFetch();
});

const textOf = (result: { content: Array<{ text: string }> }): string =>
  result.content.map((part) => part.text).join("\n");

/** The handler's arguments as xmcp hands them over: optional keys present. */
const args = {
  force_refresh: undefined,
  propertyId: "123456789",
  site: "example.com",
  days: undefined,
  pages: undefined,
};

function report(dimensions: string[], rows: Array<[string[], number]>): Ga4Report {
  return {
    dimensionHeaders: dimensions.map((name) => ({ name })),
    metricHeaders: [{ name: "sessions" }],
    rows: rows.map(([dims, sessions]) => ({
      dimensionValues: dims.map((value) => ({ value })),
      metricValues: [{ value: String(sessions) }],
    })),
    rowCount: rows.length,
  };
}

/**
 * A reader answering this Tool's reports by what each asks for: Google organic
 * by landing page (the one with a filter), and the AI reads by source × medium,
 * with or without the landing page.
 */
function readerFor(options: {
  ai: Array<[string, string, string, number]>;
  organic: Array<[string, number]>;
}) {
  return fakeGoogleReader({
    analytics: {
      runReport: async (query: Ga4ReportQuery) => {
        if (query.dimensionFilter) {
          return report(["landingPage"], options.organic.map(([page, sessions]) => [[page], sessions]));
        }
        return report(
          ["sessionSource", "sessionMedium", "landingPage"],
          options.ai.map(([source, medium, page, sessions]) => [[source, medium, page], sessions]),
        );
      },
    },
  });
}

const FILLER =
  "This paragraph exists so the page carries enough copy to count as having arrived in the " +
  "static HTML, which takes a few hundred characters of visible text rather than a heading. ";

/** A page carrying most of the signals: figures, question headings, JSON-LD, a summary, a date. */
function richPage(title: string): Route {
  return {
    headers: { "content-type": "text/html; charset=utf-8" },
    body: `<!doctype html><html lang="en"><head><title>${title}</title>
<script type="application/ld+json">{"@context":"https://schema.org","@type":"Article","headline":"${title}","datePublished":"${new Date(Date.now() - 30 * 86_400_000).toISOString()}"}</script>
</head><body><main>
<h1>${title}</h1>
<div class="tldr"><p>In short: 73% of teams ship weekly.</p></div>
<h2>What is a release train?</h2>
<p>A release train is a fixed schedule for shipping. ${FILLER}</p>
<h2>How often should you ship?</h2>
<p>About 4 out of 5 teams ship at least monthly. ${FILLER}</p>
</main></body></html>`,
  };
}

/** A page carrying none of them. */
function plainPage(title: string): Route {
  return {
    headers: { "content-type": "text/html; charset=utf-8" },
    body: `<!doctype html><html lang="en"><head><title>${title}</title></head><body><main>
<h1>${title}</h1>
<h2>Our approach</h2>
<p>We build things carefully and talk to our customers often. ${FILLER}</p>
<h2>Get in touch</h2>
<p>Write to us and we will answer. ${FILLER}</p>
</main></body></html>`,
  };
}

const ALLOW_ALL: Route = { body: "User-agent: *\nAllow: /" };

describe("site_ai_landing_signals", () => {
  it("sets the two groups side by side and reads out the differences", async () => {
    const google = readerFor({
      ai: [
        ["chatgpt.com", "ai-assistant", "/guide-a", 40],
        ["perplexity.ai", "referral", "/guide-b", 20],
        ["claude.ai", "ai-assistant", "/guide-c", 10],
        ["google", "organic", "/about", 900],
      ],
      organic: [
        ["/guide-a", 500],
        ["/about", 400],
        ["/services", 300],
        ["/contact", 200],
      ],
    });
    serve({
      "/robots.txt": ALLOW_ALL,
      "https://example.com/guide-a": richPage("Guide A"),
      "https://example.com/guide-b": richPage("Guide B"),
      "https://example.com/guide-c": richPage("Guide C"),
      "https://example.com/about": plainPage("About"),
      "https://example.com/services": plainPage("Services"),
      "https://example.com/contact": plainPage("Contact"),
    });

    const result = await handler(args, google);
    const text = textOf(result);

    expect(result.isError).toBeUndefined();
    expect(text).toContain("Property: properties/123456789");
    expect(text).toContain("Site: https://example.com");
    expect(text).toContain("/guide-a — 40 AI-referred sessions");
    // `/guide-a` has organic sessions too, so it cannot be in the comparison set.
    expect(text).toContain("/about — 400 Google organic sessions");
    expect(text).not.toContain("/guide-a — 500 Google organic sessions");
    expect(text).toContain("Pages read: 3 AI landing, 3 comparison.");
    expect(text).toContain("Question-phrased H2/H3 — 3 of 3 (100%) | 0 of 3 (0%)");
    expect(text).toContain("More common on AI landing pages: Question-phrased H2/H3 (+100 points");
    expect(text).toContain("not a test of significance");
    // No comparison page states a date, so its age cannot be asked: n/a, not a failed fetch.
    expect(text).toContain("Dated within the last 12 months — 3 of 3 (100%) | n/a");
    expect(text).toContain("Correlation over a small sample, and directional only");
    expect(text).toContain("GA4 only sees AI visits that arrived with a referrer");
    // The comparison group is Google's organic search, and the output says so.
    expect(text).toContain("Google organic search pages only");
  });

  it("lists a page it could not read as not checked and leaves it out of every denominator", async () => {
    const google = readerFor({
      ai: [
        ["chatgpt.com", "ai-assistant", "/guide-a", 40],
        ["chatgpt.com", "ai-assistant", "/gone", 30],
        ["chatgpt.com", "ai-assistant", "/guide-b", 20],
        ["chatgpt.com", "ai-assistant", "/guide-c", 10],
      ],
      organic: [
        ["/about", 400],
        ["/services", 300],
        ["/contact", 200],
      ],
    });
    serve({
      "/robots.txt": ALLOW_ALL,
      "https://example.com/guide-a": richPage("Guide A"),
      "https://example.com/guide-b": richPage("Guide B"),
      "https://example.com/guide-c": richPage("Guide C"),
      "https://example.com/about": plainPage("About"),
      "https://example.com/services": plainPage("Services"),
      "https://example.com/contact": plainPage("Contact"),
      // `/gone` is not routed, so it answers 404.
    });

    const text = textOf(await handler(args, google));

    expect(text).toContain("=== NOT CHECKED (1) ===");
    expect(text).toMatch(/\/gone \(AI group\) — /);
    expect(text).toContain("in no denominator");
    expect(text).toContain("Pages read: 3 AI landing, 3 comparison.");
    expect(text).toContain("States a figure (%, $, N out of M, millions) — 3 of 3 (100%)");
  });

  it("does not fetch a page robots.txt disallows, and says so", async () => {
    const google = readerFor({
      ai: [["chatgpt.com", "ai-assistant", "/private/guide", 40]],
      organic: [["/about", 400]],
    });
    serve({
      "/robots.txt": { body: "User-agent: *\nDisallow: /private/" },
      "https://example.com/private/guide": richPage("Private"),
      "https://example.com/about": plainPage("About"),
    });

    const text = textOf(await handler(args, google));

    expect(text).toContain("/private/guide (AI group) — robots.txt disallows this URL for our crawler, so it was not fetched");
    expect(text).toContain("Pages read: 0 AI landing, 1 comparison.");
    expect(text).toContain("not checked | 0 of 1 (0%)");
    expect(text).toContain("Not read: a difference needs at least 3 checked pages");
  });

  it("reads the pages a few at a time rather than all at once", async () => {
    // Sixteen pages of somebody else's site went out in one unbounded
    // `Promise.all`. The shared page reader caps it, and the pace underneath
    // is `crawl-pacing`'s either way.
    const ai = Array.from({ length: 6 }, (_, i): [string, string, string, number] => ["chatgpt.com", "ai-assistant", `/a${i}`, 60 - i]);
    const organic = Array.from({ length: 6 }, (_, i): [string, number] => [`/o${i}`, 600 - i]);
    const google = readerFor({ ai, organic });
    const served = serve({ "/robots.txt": ALLOW_ALL, "example.com": plainPage("Page") });
    const answer = served.getMockImplementation() as (input: Parameters<typeof fetch>[0]) => Promise<Response>;
    let open = 0;
    let peak = 0;
    served.mockImplementation(async (input: Parameters<typeof fetch>[0]) => {
      if (String(input).endsWith("/robots.txt")) return answer(input);
      open++;
      peak = Math.max(peak, open);
      await new Promise((resolve) => setTimeout(resolve, 250));
      open--;
      return answer(input);
    });

    const text = textOf(await handler(args, google));

    expect(text).toContain("Pages read: 6 AI landing, 6 comparison.");
    expect(peak).toBeGreaterThan(1);
    expect(peak).toBeLessThanOrEqual(3);
  });

  it("answers an empty window without fetching anything", async () => {
    const google = readerFor({
      ai: [["google", "organic", "/about", 900]],
      organic: [["/about", 900]],
    });
    const mock = serve({ "/robots.txt": ALLOW_ALL });

    const result = await handler(args, google);
    const text = textOf(result);

    expect(result.isError).toBeUndefined();
    expect(text).toContain("No AI-referred landing pages in this window");
    expect(text).toContain("No page was fetched.");
    expect(text).toContain("not a verdict on the site");
    expect(mock).not.toHaveBeenCalled();
  });

  it("keeps sessions with no landing page out of both groups and says how many", async () => {
    const google = readerFor({
      ai: [
        ["chatgpt.com", "ai-assistant", "(not set)", 7],
        ["chatgpt.com", "ai-assistant", "/guide-a", 5],
      ],
      organic: [],
    });
    serve({ "/robots.txt": ALLOW_ALL, "https://example.com/guide-a": richPage("Guide A") });

    const text = textOf(await handler(args, google));

    expect(text).toContain("7 AI-referred session(s) had no landing page GA4 could name");
    expect(text).toContain("Comparison: none.");
    expect(text).not.toContain("(not set) —");
  });

  it("reads /guide-a and /guide-a/ as one page, so it is not also in the comparison group", async () => {
    const google = readerFor({
      ai: [
        ["chatgpt.com", "ai-assistant", "/guide-a", 5],
        ["perplexity.ai", "referral", "/guide-a/", 3],
      ],
      organic: [
        ["/guide-a/", 500],
        ["/about", 400],
      ],
    });
    serve({
      "/robots.txt": ALLOW_ALL,
      "https://example.com/guide-a": richPage("Guide A"),
      "https://example.com/about": plainPage("About"),
    });

    const text = textOf(await handler(args, google));

    expect(text).toContain("of 1 that received any");
    expect(text).toContain("/guide-a — 8 AI-referred sessions");
    expect(text).toContain("/about — 400 Google organic sessions");
    expect(text).not.toContain("/guide-a/ — 500 Google organic sessions");
  });

  it("lets a Google refusal propagate rather than answering with part of the data", async () => {
    const google = fakeGoogleReader({
      analytics: {
        runReport: async () => {
          throw new UpstreamApiError("Google Analytics Data API", 403);
        },
      },
    });
    const mock = serve({ "/robots.txt": ALLOW_ALL });

    await expect(handler(args, google)).rejects.toBeInstanceOf(UpstreamApiError);
    expect(mock).not.toHaveBeenCalled();
  });

  it("prints no NaN, undefined, Infinity or [object Object] in any of its answers", async () => {
    const cases = [
      // Every page unreadable: both denominators are zero.
      readerFor({ ai: [["chatgpt.com", "ai-assistant", "/x", 3]], organic: [["/y", 4]] }),
      readerFor({ ai: [], organic: [] }),
    ];
    serve({ "/robots.txt": ALLOW_ALL });

    for (const google of cases) {
      const text = textOf(await handler(args, google));
      expect(text).not.toMatch(/NaN|undefined|Infinity|\[object Object\]/);
    }
  });

  it("refuses a site argument that is not a domain, naming it", async () => {
    const google = readerFor({ ai: [], organic: [] });

    await expect(handler({ ...args, site: "not a domain" }, google)).rejects.toThrow(
      /not a domain|not a registrable domain/,
    );
  });
});
