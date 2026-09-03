import { describe, it, expect, afterEach, beforeEach } from "vitest";
import { CRAWLER_USER_AGENT, PAGE_AUDIT_USER_AGENT } from "@/lib/bot-identity";
import {
  RobotsDisallowedError,
  assertRobotsAllowed,
  isAllowedByRobots,
} from "@/lib/robots-gate";
import { serve } from "../helpers/serve";
import { resetAllSingleFlightCaches } from "@/lib/single-flight";

const originalFetch = globalThis.fetch;

beforeEach(() => {
  resetAllSingleFlightCaches();
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("robots gate", () => {
  it("refuses a path the site disallows for our product token", async () => {
    serve({
      "example.com/robots.txt": { body: "User-agent: ThatSEOAgentBot\nDisallow: /private/\n" },
    });

    await expect(assertRobotsAllowed("https://example.com/private/page")).rejects.toBeInstanceOf(
      RobotsDisallowedError,
    );
  });

  it("binds page audits, not only the crawler", async () => {
    // The bug this gate exists to close: one product token, two user-agent
    // variants, and a `Disallow` that used to bind only one of them.
    serve({ "example.com/robots.txt": { body: "User-agent: ThatSEOAgentBot\nDisallow: /\n" } });

    expect(await isAllowedByRobots("https://example.com/x", CRAWLER_USER_AGENT)).toBe(false);
    expect(await isAllowedByRobots("https://example.com/x", PAGE_AUDIT_USER_AGENT)).toBe(false);
  });

  it("allows what the site allows", async () => {
    serve({ "example.com/robots.txt": { body: "User-agent: *\nDisallow: /private/\n" } });

    expect(await isAllowedByRobots("https://example.com/public")).toBe(true);
  });

  it("never gates robots.txt on its own contents", async () => {
    serve({ "example.com/robots.txt": { body: "User-agent: *\nDisallow: /\n" } });

    expect(await isAllowedByRobots("https://example.com/robots.txt")).toBe(true);
  });

  it("crawls a site whose robots.txt cannot be read, as every crawler does", async () => {
    serve({ "example.com/robots.txt": { status: 503, body: "" } });

    expect(await isAllowedByRobots("https://example.com/x")).toBe(true);
  });

  it("reads robots.txt once per origin however many URLs are checked", async () => {
    serve({ "example.com/robots.txt": { body: "User-agent: *\nDisallow: /private/\n" } });

    await isAllowedByRobots("https://example.com/a");
    await isAllowedByRobots("https://example.com/b");
    await isAllowedByRobots("https://example.com/c");

    expect(globalThis.fetch).toHaveBeenCalledTimes(1);
  });
});
