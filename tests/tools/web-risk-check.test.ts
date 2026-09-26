import { describe, it, expect, afterEach, vi } from "vitest";
import webRiskCheck from "@/tools/web-risk-check";
import { readVerdict } from "@/lib/web-risk";
import { requestsOf, serve, type FetchMock } from "../helpers/serve";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

const textOf = (result: Awaited<ReturnType<typeof webRiskCheck>>): string =>
  result.content.map((part) => part.text).join("\n");

const run = (args: { url: string; urls?: string[] }) => webRiskCheck({ urls: undefined, ...args });

/** The documented match payload. https://docs.cloud.google.com/web-risk/docs/lookup-api */
const MALWARE_MATCH = JSON.stringify({
  threat: { threatTypes: ["MALWARE"], expireTime: "2026-09-24T15:01:23.045123456Z" },
});

/**
 * Answer Web Risk lookups by the `uri` asked about: `{}` — on no list — unless
 * the table says otherwise. Chosen from the parsed parameter, because a URL key
 * for the URI would be out-matched by the endpoint's own host.
 */
function answerLookups(byUri: Record<string, { body: string; status?: number } | string> = {}): FetchMock {
  return serve({
    "webrisk.googleapis.com": (request) => {
      const route = byUri[request.searchParams.get("uri") ?? ""] ?? "{}";
      return typeof route === "string" ? { body: route } : route;
    },
  });
}

const lookedUp = (mock: FetchMock): string[] =>
  requestsOf(mock).map((request) => request.searchParams.get("uri") ?? "");

describe("web_risk_check without the key configured", () => {
  it("refuses naming the variable, the API and billing, before any request", async () => {
    vi.stubEnv("GOOGLE_CLOUD_API_KEY", undefined);
    vi.stubEnv("PAGESPEED_API_KEY", "a-free-key");
    const mock = answerLookups();

    const result = await run({ url: "https://example.com/" });

    expect(result.isError).toBe(true);
    const text = textOf(result);
    expect(text).toContain("GOOGLE_CLOUD_API_KEY is not set");
    expect(text).toContain("Web Risk API");
    expect(text).toContain("billing");
    expect(text).toContain("100,000");
    // The free PageSpeed key is never borrowed for a billed API.
    expect(mock).not.toHaveBeenCalled();
  });
});

describe("web_risk_check with the key configured", () => {
  it("asks for every list, with the key in a header rather than the URL", async () => {
    vi.stubEnv("GOOGLE_CLOUD_API_KEY", "test-key");
    const mock = answerLookups();

    await run({ url: "https://example.com/blog/post" });

    const [asked] = requestsOf(mock);
    expect(asked?.searchParams.get("uri")).toBe("https://example.com/");
    expect(asked?.searchParams.getAll("threatTypes")).toEqual([
      "MALWARE",
      "SOCIAL_ENGINEERING",
      "UNWANTED_SOFTWARE",
      "SOCIAL_ENGINEERING_EXTENDED_COVERAGE",
    ]);
    expect(asked?.url).not.toContain("test-key");
    expect(asked?.headers["x-goog-api-key"]).toBe("test-key");
  });

  it("looks up the homepage first, then each extra URL once", async () => {
    vi.stubEnv("GOOGLE_CLOUD_API_KEY", "test-key");
    const mock = answerLookups();

    await run({
      url: "https://example.com/pricing",
      urls: ["https://example.com", "https://example.com/login", "https://cdn.example.net/app.js"],
    });

    expect(lookedUp(mock)).toEqual([
      "https://example.com/",
      "https://example.com/login",
      "https://cdn.example.net/app.js",
    ]);
  });

  it("reports a clean site as not flagged, and says what that does not mean", async () => {
    vi.stubEnv("GOOGLE_CLOUD_API_KEY", "test-key");
    answerLookups();

    const result = await run({ url: "https://example.com/" });
    const text = textOf(result);

    expect(result.isError).toBeUndefined();
    expect(text).toContain("Verdict: none of the 1 URL is on Google's lists.");
    expect(text).toContain("=== NOT FLAGGED (1) ===");
    expect(text).toContain("not on Google's lists at the moment of lookup");
    expect(text).toContain("Security Issues report has no API");
    expect(text).toContain("non-commercial use only");
    expect(text).not.toMatch(/NaN|undefined|Infinity|\[object Object\]/);
  });

  it("reports a flagged URL with its lists and expiry", async () => {
    vi.stubEnv("GOOGLE_CLOUD_API_KEY", "test-key");
    answerLookups({ "https://example.com/download": MALWARE_MATCH });

    const text = textOf(await run({ url: "https://example.com/", urls: ["https://example.com/download"] }));

    expect(text).toContain("Verdict: 1 of 2 URLs are on Google's lists.");
    expect(text).toContain("=== FLAGGED (1) ===");
    expect(text).toContain("  https://example.com/download\n    On: malware");
    expect(text).toContain("holds until 2026-09-24T15:01:23.045123456Z");
    expect(text).toContain("=== NOT FLAGGED (1) ===\n\n  https://example.com/");
  });

  it("says when a URL is only on the lower-confidence extended list", async () => {
    vi.stubEnv("GOOGLE_CLOUD_API_KEY", "test-key");
    answerLookups({
      "https://example.com/": JSON.stringify({
        threat: { threatTypes: ["SOCIAL_ENGINEERING_EXTENDED_COVERAGE"], expireTime: "2026-09-24T15:00:00Z" },
      }),
    });

    const text = textOf(await run({ url: "https://example.com/" }));

    expect(text).toContain("Only on the extended-coverage list");
    expect(text).toContain("false positive");
  });

  it("fails the whole call when one lookup is refused, rather than reporting the rest", async () => {
    vi.stubEnv("GOOGLE_CLOUD_API_KEY", "test-key");
    answerLookups({
      "https://example.com/b": {
        status: 403,
        body: JSON.stringify({ error: { code: 403, message: "Billing account disabled for this project" } }),
      },
    });

    const result = await run({ url: "https://example.com/", urls: ["https://example.com/a", "https://example.com/b"] });

    expect(result.isError).toBe(true);
    const text = textOf(result);
    expect(text).toContain("Google's Web Risk API returned HTTP 403");
    expect(text).not.toContain("Billing account disabled");
    expect(text).not.toContain("NOT FLAGGED");
  });

  it("refuses more than ten URLs", async () => {
    vi.stubEnv("GOOGLE_CLOUD_API_KEY", "test-key");
    const mock = answerLookups();
    const urls = Array.from({ length: 10 }, (_, i) => `https://example.com/p${i}`);

    const result = await run({ url: "https://example.com/", urls });

    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("at most 10 URLs");
    expect(mock).not.toHaveBeenCalled();
  });
});

describe("reading a verdict", () => {
  it("treats the documented empty object as not flagged", () => {
    expect(readVerdict("https://a.com/", {})).toEqual({ url: "https://a.com/", flagged: false });
  });

  it("keeps a match whose list it does not recognise as a match", () => {
    const verdict = readVerdict("https://a.com/", { threat: { threatTypes: ["SOMETHING_NEW"] } });
    expect(verdict).toEqual({ url: "https://a.com/", flagged: true, threatTypes: [], expireTime: null });
  });
});
