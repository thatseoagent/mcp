import { describe, it, expect, afterEach } from "vitest";
import { auditAgentDiscovery, type AgentDiscoveryResult } from "@/lib/analyzers/agent-discovery";
import { tally } from "@/lib/analyzers/scored-checks";
import { unwrap } from "@/lib/type-guards";
import { serve, restoreFetch, type FetchMock, type Route } from "../../helpers/serve";

/**
 * The discovery tier, through its own interface.
 *
 * `tests/tools/seo-agent-discovery.test.ts` is 5 cases and 90 lines against a
 * 970-line analyzer, and every one of them reads rendered text — so what it can
 * assert is what the Tool prints, one route table at a time. This file asserts
 * the `DiscoveryCheck` records instead: a `status`, a `points`, a denominator.
 *
 * That is the same gap `agent-navigability` had, and in that tier it was hiding a
 * breach of ADR-0006 rule 8 in every single check. The two remaining tiers keep
 * their shape for the reason ADR-0006's Consequences section gives, so a test
 * here still stubs `fetch` — but `serve()` makes that a route table, and the
 * assertions land on the reading rather than on the paragraph about it.
 */

const PAGE = "https://example.com/page";
const at = (path: string) => `https://example.com${path}`;

/**
 * A path, not the root. `serve()` falls back to substring matching, and
 * `https://example.com/` is a substring of every artifact URL this tier probes.
 */
const page = { headers: { "content-type": "text/html" }, body: "<html><body>copy</body></html>" };

const read = async (url = PAGE): Promise<AgentDiscoveryResult> => unwrap(await auditAgentDiscovery(url));

const check = (result: AgentDiscoveryResult, name: RegExp) => {
  const found = result.checks.find((c) => name.test(c.name));
  if (!found) throw new Error(`no check matching ${name} in ${result.checks.map((c) => c.name).join(", ")}`);
  return found;
};

const askedFor = (mock: FetchMock): string[] =>
  mock.mock.calls.map(([input]) => (typeof input === "string" ? input : String(input)));

afterEach(restoreFetch);

describe("the shape of a reading", () => {
  it("derives every total from the checks, in one walk", async () => {
    serve({ [PAGE]: page });

    const result = await read();
    const walked = tally(result.checks);

    expect(result.quality).toEqual({ score: walked.score, max: walked.max });
    expect(result.notApplicable).toBe(walked.notApplicable);
    expect(result.notEvaluated).toBe(walked.notEvaluated);
  });

  it("ships a reproducing request with every check", async () => {
    serve({ [PAGE]: page });

    for (const c of (await read()).checks) {
      // The one exception says so in the same field: no endpoint was advertised,
      // so no request was made and `curl ''` would be worse than a sentence.
      expect(c.request, c.name).toMatch(/^curl |^n\/a — /);
    }
  });

  it("adds nothing to a site that publishes none of the artifacts", async () => {
    serve({ [PAGE]: page });

    const result = await read();

    // The floor is +0, which is exactly what a site would have had if this tier
    // did not exist. Absence is never a penalty.
    expect(result.bonus).toBe(0);
    expect(result.maxBonus).toBe(5);
    expect(result.quality.max).toBe(0);
  });

  it("calls an absent artifact absent, not failed", async () => {
    serve({ [PAGE]: page });

    for (const c of (await read()).checks) {
      expect(c.passed, c.name).not.toBe(false);
    }
    expect((await read()).notApplicable).toBeGreaterThan(0);
  });
});

describe("rule 7 — read-only and unauthenticated", () => {
  it("asks for everything with a plain GET and no credentials", async () => {
    const mock = serve({ [PAGE]: page });

    await read();

    expect(mock.mock.calls.length).toBeGreaterThan(5);
    for (const [, init] of mock.mock.calls) {
      const headers = new Headers((init as RequestInit | undefined)?.headers ?? {});
      expect((init as RequestInit | undefined)?.method ?? "GET").toBe("GET");
      expect(headers.get("authorization")).toBeNull();
      expect(headers.get("cookie")).toBeNull();
    }
  });
});

describe("rule 8 — a question we did not ask costs nothing", () => {
  /** robots.txt that shuts our crawler out of everything but the page itself. */
  const shutOut = {
    "example.com/robots.txt": {
      body: ["User-agent: *", "Disallow: /.well-known/", "Disallow: /auth.md", "Disallow: /pricing.md", "Disallow: /llms.txt"].join("\n"),
    },
    [PAGE]: page,
  };

  it("says the site refused, not that the site is innocent", async () => {
    serve(shutOut);

    const result = await read();
    const refused = result.checks.filter((c) => c.status === "not-evaluated");

    expect(refused.length).toBeGreaterThan(4);
    for (const c of refused) {
      // ADR-0006 rule 8, third bullet: `notScored`'s sentence claims innocence
      // on the page's behalf and says "try again", and the cause here is the
      // page's own robots.txt.
      expect(c.detail, c.name).not.toContain("not a finding about the page");
      expect(c.detail, c.name).toContain("robots.txt disallows");
    }
  });

  it("charges nothing for any of it", async () => {
    serve(shutOut);

    const result = await read();

    expect(result.quality).toEqual({ score: 0, max: 0 });
    expect(result.bonus).toBe(0);
  });

  it("does not report an artifact absent when it never looked", async () => {
    serve(shutOut);

    const result = await read();
    const discoverable = check(result, /can be found without being told/);

    // The sentence is the whole check: "No MCP server advertised at
    // /.well-known/mcp/server-card.json" is a claim about the site, and this run
    // never fetched that path. ADR-0006: an agent-readiness check is an assertion
    // about a document a server served.
    expect(discoverable.status).toBe("not-evaluated");
    expect(discoverable.detail).not.toContain("No MCP server advertised");
  });
});

describe("rule 6 — same-site is eTLD+1", () => {
  const OFF_SITE = "https://tenant.auth0.test";

  const pointsElsewhere = {
    [PAGE]: page,
    [at("/.well-known/oauth-protected-resource")]: {
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        resource: "https://example.com/mcp",
        authorization_servers: [OFF_SITE],
        scopes_supported: ["read"],
        bearer_methods_supported: ["header"],
      }),
    },
  };

  it("does not fetch a third party on a document's say-so", async () => {
    const mock = serve(pointsElsewhere);

    await read();

    expect(askedFor(mock).some((url) => url.includes("auth0.test"))).toBe(false);
  });

  it("names the third party in the finding rather than in the request", async () => {
    serve(pointsElsewhere);

    const result = await read();
    const server = check(result, /authorization-server metadata/);
    const chain = check(result, /walked end to end/);

    expect(server.status).toBe("not-evaluated");
    expect(server.detail).toContain("auth0.test");
    // The hop is a fact about the site, and everything before it did resolve —
    // so the chain names the step it stopped at rather than failing the site for
    // a document we chose not to read.
    expect(chain.status).toBe("not-evaluated");
    expect(chain.detail).toContain("auth0.test");
    expect(chain.detail).toContain("protected-resource metadata");
  });
});

describe("what it fetches, and what it does not", () => {
  it("reads llms.txt only when nothing else advertises the server", async () => {
    const withoutCard = serve({ [PAGE]: page });
    await read();
    expect(askedFor(withoutCard)).toContain(at("/llms.txt"));

    restoreFetch();

    const withCard = serve({
      [PAGE]: page,
      [at("/.well-known/mcp/server-card.json")]: {
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: "Example", description: "d", version: "1", serverUrl: "https://example.com/mcp", tools: [{ name: "t" }] }),
      },
    });
    await read();

    // The common case costs one request fewer, which is the documented reason
    // this tier does not split its gathering from its judging.
    expect(askedFor(withCard)).not.toContain(at("/llms.txt"));
  });

  it("looks for protected-resource metadata under the server's own path (RFC 9728)", async () => {
    const mock = serve({
      [PAGE]: page,
      [at("/.well-known/mcp/server-card.json")]: {
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: "Example", description: "d", version: "1", serverUrl: "https://example.com/mcp", tools: [{ name: "t" }] }),
      },
    });

    await read();

    // Probing only the root reported "Not published" about most real MCP servers.
    expect(askedFor(mock)).toContain(at("/.well-known/oauth-protected-resource/mcp"));
  });
});

describe("the bonus denominator", () => {
  it("stays the full artifact set when most of them could not be read", async () => {
    // The airbnb.com shape: bot protection refused eight of eleven documents and
    // one good artifact came out at +2.5 of 5, because the denominator had
    // quietly shrunk to what we managed to read.
    serve({
      "example.com/robots.txt": {
        body: ["User-agent: *", "Disallow: /.well-known/", "Disallow: /auth.md", "Disallow: /llms.txt"].join("\n"),
      },
      [PAGE]: page,
      [at("/pricing.md")]: {
        headers: { "content-type": "text/markdown" },
        body: `# Pricing\n\n${"Every plan includes the whole product; the tiers differ only in seats. ".repeat(5)}`,
      },
    });

    const result = await read();

    expect(check(result, /pricing\.md/).passed).toBe(true);
    expect(result.bonus).toBeGreaterThan(0);
    expect(result.bonus).toBeLessThan(1);
  });
});

describe("a site that publishes the chain, correctly", () => {
  const CARD = {
    name: "Example",
    description: "The example server.",
    version: "1.0.0",
    serverUrl: "https://example.com/mcp",
    tools: [{ name: "search" }, { name: "fetch" }],
  };

  const wellFormed: Record<string, Route> = {
    [PAGE]: page,
    [at("/.well-known/mcp/server-card.json")]: {
      headers: { "content-type": "application/json" },
      body: JSON.stringify(CARD),
    },
    [at("/mcp")]: {
      status: 401,
      headers: {
        "content-type": "application/json",
        "www-authenticate": `Bearer resource_metadata="${at("/.well-known/oauth-protected-resource/mcp")}"`,
      },
      body: JSON.stringify({ error: "invalid_token" }),
    },
    [at("/.well-known/oauth-protected-resource/mcp")]: {
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        resource: at("/mcp"),
        authorization_servers: ["https://example.com"],
        scopes_supported: ["read"],
        bearer_methods_supported: ["header"],
      }),
    },
    [at("/.well-known/oauth-authorization-server")]: {
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        issuer: "https://example.com",
        authorization_endpoint: at("/oauth/authorize"),
        token_endpoint: at("/oauth/token"),
        registration_endpoint: at("/oauth/register"),
        code_challenge_methods_supported: ["S256"],
      }),
    },
    [at("/auth.md")]: {
      headers: { "content-type": "text/markdown" },
      body: [
        "# Auth",
        "## Discover",
        "Start at /.well-known/oauth-protected-resource.",
        "## Pick a method",
        "## Register a client",
        "## Claim",
        "## Use the credential",
        "## Errors",
        "## Revocation",
        "Every section here exists so an agent has somewhere to go next rather than a guess.",
      ].join("\n\n"),
    },
  };

  it("walks the auth chain end to end", async () => {
    serve(wellFormed);

    const chain = check(await read(), /walked end to end/);

    // The check #389 says matters most: "each file can be individually valid and
    // the path still broken". Every case above this one is a way for it to
    // break, and none of them proved it can close.
    expect(chain.passed).toBe(true);
    expect(chain.detail).toContain("protected-resource metadata");
    expect(chain.detail).toContain("authorization-server metadata");
  });

  it("credits a protected endpoint that names its own resource metadata", async () => {
    serve(wellFormed);

    const endpoint = check(await read(), /MCP endpoint/);

    // 401 is a pass here: a protected server answering a structured refusal is
    // doing the right thing, and the `resource_metadata` parameter is RFC 9728
    // §5.1 handing an agent the next document instead of leaving it to guess.
    expect(endpoint.passed).toBe(true);
    expect(endpoint.detail).toContain("protected");
  });

  it("adds a real bonus for it", async () => {
    serve(wellFormed);

    const result = await read();

    expect(result.quality.score).toBeGreaterThan(50);
    expect(result.bonus).toBeGreaterThan(2);
    expect(result.bonus).toBeLessThanOrEqual(result.maxBonus);
  });

  it("distinguishes a malformed artifact from an absent one", async () => {
    serve({ ...wellFormed, [at("/.well-known/mcp/server-card.json")]: { body: "not json at all" } });

    const card = check(await read(), /server card/);

    // Zero earned, full points still on the table. A document that answered 200
    // and is not the document it claims to be is the class of defect this tier
    // was written for — and it is the one a checker that asserts reachability
    // would have called fine.
    expect(card.earned).toBe(0);
    expect(card.points).toBe(10);
    expect(card.status).toBeUndefined();
  });
});
