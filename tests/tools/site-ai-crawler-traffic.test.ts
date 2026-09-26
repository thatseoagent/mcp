import { describe, it, expect, afterEach } from "vitest";
import { handler } from "@/tools/site-ai-crawler-traffic";
import { fakeGoogleReader } from "@/lib/google/fake-reader";
import type { Ga4Report } from "@/lib/google/reader";
import { UpstreamApiError } from "@/lib/upstream-api-error";
import { restoreFetch, serve, type Route } from "../helpers/serve";

afterEach(() => {
  restoreFetch();
});

const textOf = (result: { content: Array<{ text: string }> }): string =>
  result.content.map((part) => part.text).join("\n");

const args = {
  force_refresh: undefined,
  propertyId: "123456789",
  site: "example.com",
  days: undefined,
};

/** A reader answering the one report this Tool runs: sessions by source × medium. */
function readerFor(rows: Array<[string, string, number]>) {
  const report: Ga4Report = {
    dimensionHeaders: [{ name: "sessionSource" }, { name: "sessionMedium" }],
    metricHeaders: [{ name: "sessions" }],
    rows: rows.map(([source, medium, sessions]) => ({
      dimensionValues: [{ value: source }, { value: medium }],
      metricValues: [{ value: String(sessions) }],
    })),
    rowCount: rows.length,
  };
  return fakeGoogleReader({ analytics: { runReport: async () => report } });
}

const robots = (body: string): Record<string, Route> => ({ "/robots.txt": { body } });

/** The block of lines under one assistant's heading. */
function blockFor(text: string, assistant: string): string {
  const start = text.indexOf(`\n${assistant} (`);
  const end = text.indexOf("\n\n", start + 1);
  return text.slice(start, end === -1 ? undefined : end);
}

describe("site_ai_crawler_traffic", () => {
  it("flags a blocked search crawler for an assistant that is still referring, quoting its operator", async () => {
    serve(robots("User-agent: OAI-SearchBot\nDisallow: /\n\nUser-agent: *\nAllow: /"));
    const google = readerFor([
      ["chatgpt.com", "ai-assistant", 80],
      ["google", "organic", 900],
    ]);

    const text = textOf(await handler(args, google));
    const chatgpt = blockFor(text, "ChatGPT");

    expect(text).toContain("AI-referred sessions in the window: 80");
    expect(text).toContain("Risks flagged: 1");
    expect(chatgpt).toContain("ChatGPT (OpenAI) — 80 AI-referred session(s)");
    expect(chatgpt).toContain("Search crawler OAI-SearchBot: BLOCKED");
    expect(chatgpt).toContain("RISK: OAI-SearchBot is blocked while ChatGPT sent 80 session(s)");
    expect(chatgpt).toContain("will not be shown in ChatGPT search answers");
    expect(chatgpt).toContain("not a measured decline");
    expect(chatgpt).toContain("https://developers.openai.com/api/docs/bots");
  });

  it("calls a training-only block what it is, and flags nothing", async () => {
    serve(robots("User-agent: GPTBot\nUser-agent: ClaudeBot\nDisallow: /\n\nUser-agent: *\nAllow: /"));
    const google = readerFor([
      ["chatgpt.com", "ai-assistant", 30],
      ["claude.ai", "referral", 5],
    ]);

    const text = textOf(await handler(args, google));

    expect(text).toContain("Risks flagged: 0");
    expect(blockFor(text, "ChatGPT")).toContain("training opt-out only");
    expect(blockFor(text, "ChatGPT")).toContain("does not affect whether ChatGPT's answers can cite the site");
    expect(blockFor(text, "Claude")).toContain("training opt-out only");
    // The host-list count is kept apart from Google's.
    expect(blockFor(text, "Claude")).toContain("5 counted by the host list");
    expect(text).toContain("GPTBot (OpenAI model training): BLOCKED");
  });

  it("says allowing everything while receiving nothing is not a problem by itself", async () => {
    serve(robots("User-agent: *\nAllow: /"));
    const google = readerFor([["google", "organic", 900]]);

    const result = await handler(args, google);
    const text = textOf(result);

    expect(result.isError).toBeUndefined();
    expect(text).toContain("AI-referred sessions in the window: 0");
    expect(text).toContain("not a verdict");
    expect(blockFor(text, "Perplexity")).toContain("Not a problem by itself");
  });

  it("reads Google-Extended as an answer control for Gemini, citing Google on grounding", async () => {
    serve(robots("User-agent: Google-Extended\nDisallow: /\n\nUser-agent: *\nAllow: /"));
    const google = readerFor([["gemini.google.com", "ai-assistant", 12]]);

    const text = textOf(await handler(args, google));
    const gemini = blockFor(text, "Gemini");

    expect(gemini).toContain("Search crawler Googlebot: allowed");
    expect(gemini).toContain("Answer control Google-Extended: BLOCKED");
    expect(gemini).toContain("RISK: Google-Extended is blocked while Gemini sent 12 session(s)");
    expect(gemini).toContain("grounding");
    expect(text).toContain("Risks flagged: 1");
  });

  it("says Copilot's crawler mapping is an inference", async () => {
    serve(robots("User-agent: *\nAllow: /"));
    const google = readerFor([["copilot.microsoft.com", "ai-assistant", 4]]);

    const copilot = blockFor(textOf(await handler(args, google)), "Copilot");

    expect(copilot).toContain("Search crawler Bingbot: allowed");
    expect(copilot).toContain("(Inference: Microsoft names no separate crawler for Copilot");
  });

  it("warns that a blocked user-requested fetch may not be obeyed where the operator says so", async () => {
    serve(robots("User-agent: Perplexity-User\nDisallow: /\n\nUser-agent: *\nAllow: /"));
    const google = readerFor([["perplexity.ai", "ai-assistant", 9]]);

    const perplexity = blockFor(textOf(await handler(args, google)), "Perplexity");

    expect(perplexity).toContain("Perplexity-User: BLOCKED");
    expect(perplexity).toContain('"generally ignores robots.txt rules"');
    expect(perplexity).toContain("may not be obeyed");
  });

  it("reports a partial restriction without calling it a block", async () => {
    serve(robots("User-agent: PerplexityBot\nDisallow: /private/\n\nUser-agent: *\nAllow: /"));
    const google = readerFor([["perplexity.ai", "ai-assistant", 9]]);

    const text = textOf(await handler(args, google));

    expect(text).toContain("PerplexityBot: allowed at the root, restricted by 1 Disallow pattern(s)");
    expect(text).toContain("not paths matching /private/");
    expect(text).toContain("Risks flagged: 0");
  });

  it("marks every rule not checked when robots.txt cannot be read, and still reports the traffic", async () => {
    serve({ "/robots.txt": { status: 503, body: "busy" } });
    const google = readerFor([["chatgpt.com", "ai-assistant", 20]]);

    const result = await handler(args, google);
    const text = textOf(result);

    expect(result.isError).toBeUndefined();
    expect(text).toContain("robots.txt: NOT CHECKED — /robots.txt returned HTTP 503");
    expect(text).toContain("Risks flagged: not checked");
    expect(text).toContain("ChatGPT (OpenAI) — 20 AI-referred session(s)");
    expect(blockFor(text, "ChatGPT")).toContain("Rules: not checked");
    expect(text).not.toContain("BLOCKED");
    expect(text).not.toMatch(/: allowed/);
  });

  it("reads a missing robots.txt as no rules at all", async () => {
    serve({});
    const google = readerFor([["chatgpt.com", "ai-assistant", 20]]);

    const text = textOf(await handler(args, google));

    expect(text).toContain("robots.txt: none (HTTP 404), so nothing is disallowed to any crawler.");
    expect(text).toContain("Search crawler OAI-SearchBot: allowed");
    expect(text).toContain("Risks flagged: 0");
  });

  it("lists AI sources with no verified crawler mapping without crossing them", async () => {
    serve(robots("User-agent: *\nAllow: /"));
    const google = readerFor([
      ["grok.com", "referral", 3],
      ["chatgpt.com", "ai-assistant", 2],
    ]);

    const text = textOf(await handler(args, google));

    expect(text).toContain("=== AI SOURCES NOT JOINED TO A CRAWLER (1) ===");
    expect(text).toContain("grok.com — 3 session(s)");
    expect(text).toContain("AI-referred sessions in the window: 5");
  });

  it("mentions a Content-Signal preference stated to a search crawler, as a preference", async () => {
    serve(robots("User-agent: OAI-SearchBot\nContent-Signal: ai-input=no\nAllow: /"));
    const google = readerFor([["chatgpt.com", "ai-assistant", 2]]);

    const text = textOf(await handler(args, google));

    expect(text).toContain("Content-Signal stated to OAI-SearchBot: ai-input=no");
    expect(text).toContain("not an access rule");
  });

  it("lets a Google refusal propagate without reading robots.txt", async () => {
    const mock = serve(robots("User-agent: *\nAllow: /"));
    const google = fakeGoogleReader({
      analytics: {
        runReport: async () => {
          throw new UpstreamApiError("Google Analytics Data API", 403);
        },
      },
    });

    await expect(handler(args, google)).rejects.toBeInstanceOf(UpstreamApiError);
    expect(mock).not.toHaveBeenCalled();
  });

  it("prints no NaN, undefined, Infinity or [object Object]", async () => {
    const cases: Array<[Record<string, Route>, Array<[string, string, number]>]> = [
      [robots("User-agent: *\nDisallow: /"), [["chatgpt.com", "ai-assistant", 1]]],
      [{ "/robots.txt": { status: 500 } }, []],
      [{}, [["unknown-ai.example", "ai-assistant", 4]]],
    ];

    for (const [routes, rows] of cases) {
      serve(routes);
      const text = textOf(await handler(args, readerFor(rows)));
      expect(text).not.toMatch(/NaN|undefined|Infinity|\[object Object\]/);
      restoreFetch();
    }
  });
});
