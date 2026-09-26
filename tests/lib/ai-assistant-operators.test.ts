import { describe, it, expect } from "vitest";
import { ASSISTANT_OPERATORS, operatorForSource } from "@/lib/ai-assistant-operators";
import { AI_CRAWLERS, type AiCrawlerPurpose } from "@/lib/ai-crawlers";
import { classifyAiReferrer } from "@/lib/google/ai-referrers";

/**
 * The join between assistants and crawlers has to agree with the two lists it
 * joins. A token filed as a search crawler here and as a training crawler in
 * `ai-crawlers.ts` would have one Tool call a block "the training opt-out" and
 * another call it lost visibility, from the same robots.txt.
 */
describe("the assistant-to-crawler table", () => {
  const purposeHere = new Map<string, AiCrawlerPurpose>();
  for (const entry of ASSISTANT_OPERATORS) {
    for (const token of entry.search) purposeHere.set(token, "search");
    for (const token of entry.userFetch) purposeHere.set(token, "user-fetch");
    for (const token of entry.training) purposeHere.set(token, "training");
    for (const token of entry.answerControls) purposeHere.set(token, "control-token");
  }

  for (const crawler of AI_CRAWLERS) {
    if (!purposeHere.has(crawler.name)) continue;
    it(`files ${crawler.name} under the purpose ai-crawlers.ts gives it`, () => {
      expect(purposeHere.get(crawler.name)).toBe(crawler.purpose);
    });
  }

  it("names only referrer hosts the AI classification already counts", () => {
    // Otherwise a host here would never receive a session to be crossed with.
    for (const entry of ASSISTANT_OPERATORS) {
      for (const host of entry.referrerHosts) {
        expect(classifyAiReferrer(host, "referral"), host).toBe("host-list");
      }
    }
  });

  it("cites operator documentation for every entry", () => {
    for (const entry of ASSISTANT_OPERATORS) {
      expect(entry.docs.length, entry.assistant).toBeGreaterThan(0);
      for (const url of entry.docs) expect(url).toMatch(/^https:\/\//);
    }
  });

  it("matches a source on its host or a subdomain, never a substring", () => {
    expect(operatorForSource("chatgpt.com")?.assistant).toBe("ChatGPT");
    expect(operatorForSource("chat.mistral.ai")?.assistant).toBe("Mistral");
    expect(operatorForSource("www.perplexity.ai")?.assistant).toBe("Perplexity");
    expect(operatorForSource("notchatgpt.com")).toBeNull();
    expect(operatorForSource("grok.com")).toBeNull();
  });
});
