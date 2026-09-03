import { describe, it, expect, afterEach } from "vitest";
import { auditAgentApiSurface, type AgentApiSurfaceResult } from "@/lib/analyzers/agent-api-surface";
import { PROBE_PATH } from "@/lib/analyzers/agent-probe";
import { tally } from "@/lib/analyzers/scored-checks";
import { unwrap } from "@/lib/type-guards";
import { serve, restoreFetch, type FetchMock, type Route } from "../../helpers/serve";

/**
 * The API-surface tier, through its own interface.
 *
 * Same gap as its two siblings: 5 cases against 985 lines, all of them reading
 * rendered text. `auditAgentApiSurface` returns `ApiSurfaceCheck` records, so the
 * three-state distinctions this tier is built out of — `not-applicable` for a
 * site with no API, `not-evaluated` for a spec we found and could not read, a
 * fraction for one we could — are assertable directly rather than through the
 * paragraph that describes them.
 *
 * ADR-0006 is the axis. Rules 6, 7 and 8 each get a case here, because every one
 * of them is enforced in this file and none of them was pinned.
 */

const PAGE = "https://example.com/page";
const page: Route = { headers: { "content-type": "text/html" }, body: "<html><body>copy</body></html>" };

/** The smallest document that is recognisably an OpenAPI spec. */
function spec(over: Record<string, unknown> = {}): Route {
  return {
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      openapi: "3.1.0",
      info: { title: "Example", version: "1.0.0" },
      servers: [{ url: "https://example.com/api/v1" }],
      paths: {
        "/things": {
          get: {
            operationId: "listThings",
            description: "List the things.",
            responses: { "200": { description: "OK", content: { "application/json": { schema: { type: "array", items: { type: "string" } } } } } },
          },
        },
      },
      ...over,
    }),
  };
}

const read = async (url = PAGE): Promise<AgentApiSurfaceResult> => unwrap(await auditAgentApiSurface(url));

const check = (result: AgentApiSurfaceResult, name: RegExp) => {
  const found = result.checks.find((c) => name.test(c.name));
  if (!found) throw new Error(`no check matching ${name} in ${result.checks.map((c) => c.name).join(", ")}`);
  return found;
};

const askedFor = (mock: FetchMock): string[] =>
  mock.mock.calls.map(([input]) => (typeof input === "string" ? input : String(input)));

afterEach(restoreFetch);

describe("the shape of a reading", () => {
  it("derives every total from the checks, in one walk", async () => {
    serve({ [PAGE]: page, "https://example.com/openapi.json": spec() });

    const result = await read();
    const walked = tally(result.checks);

    expect(result.score).toBe(walked.score);
    expect(result.max).toBe(walked.max);
    expect(result.notApplicable).toBe(walked.notApplicable);
    expect(result.notEvaluated).toBe(walked.notEvaluated);
  });

  it("ships a reproducing request with every check", async () => {
    serve({ [PAGE]: page, "https://example.com/openapi.json": spec() });

    for (const c of (await read()).checks) {
      expect(c.request, c.name).toMatch(/^curl /);
    }
  });

  it("accounts for every point its checks declare", async () => {
    serve({ [PAGE]: page, "https://example.com/openapi.json": spec() });

    const result = await read();
    const declared = result.checks.reduce((sum, c) => sum + c.points, 0);

    expect(result.max + result.notApplicable + result.notEvaluated).toBe(declared);
  });
});

describe("a site with no API is not a site with a failing API", () => {
  it("scores nothing at all rather than zero", async () => {
    serve({ [PAGE]: page });

    const result = await read();

    expect(result.specUrl).toBeNull();
    expect(result.max).toBe(0);
    expect(result.score).toBe(0);
    expect(result.notApplicable).toBeGreaterThan(0);
    for (const c of result.checks) {
      expect(c.passed, c.name).not.toBe(false);
    }
  });

  it("prices having an API at nothing, and says where it looked", async () => {
    serve({ [PAGE]: page });

    const discovery = check(await read(), /API description discovered/);

    // ADR-0006: "publishes an OpenAPI spec" is a property of having an API at
    // all, so it is informational and worth nothing. The gate belongs in the
    // other checks' `not-applicable`.
    expect(discovery.points).toBe(0);
    expect(discovery.status).toBe("not-applicable");
    expect(discovery.detail).toContain("/openapi.json");
  });
});

describe("a spec we found and could not read", () => {
  const yaml: Route = {
    headers: { "content-type": "text/yaml" },
    body: "openapi: 3.1.0\ninfo:\n  title: Example\n",
  };

  it("is not evaluated, never not-applicable and never a zero", async () => {
    serve({ [PAGE]: page, "https://example.com/openapi.yaml": yaml });

    const result = await read();
    const typed = check(result, /typed response schema/);

    // Hand-rolling this gate made a YAML spec produce 25 points of "does not
    // apply" for two questions we simply never got to ask.
    expect(typed.status).toBe("not-evaluated");
    expect(typed.detail).toContain("YAML");
    expect(result.max).toBe(0);
    expect(result.notEvaluated).toBeGreaterThan(40);
  });

  it("still reports that the site has one", async () => {
    serve({ [PAGE]: page, "https://example.com/openapi.yaml": yaml });

    const discovery = check(await read(), /API description discovered/);

    expect(discovery.passed).toBe(true);
    expect(discovery.detail).toContain("not read");
  });
});

describe("fractions, not verdicts", () => {
  const threeOperations = spec({
    paths: {
      "/a": { get: { operationId: "a", description: "A", responses: { "200": { description: "OK", content: { "application/json": { schema: { type: "object", properties: { id: { type: "string" } } } } } } } } },
      "/b": { get: { operationId: "b", description: "B", responses: { "200": { description: "OK" } } } },
      "/c": { get: { operationId: "c", description: "C", responses: { "200": { description: "OK" } } } },
    },
  });

  it("reports the count and names the operations it counted", async () => {
    serve({ [PAGE]: page, "https://example.com/openapi.json": threeOperations });

    const typed = check(await read(), /typed response schema/);

    expect(typed.detail).toContain("1/3 typed response schemas");
    expect(typed.detail).toContain("GET /b");
    expect(typed.passed).toBe(false);
  });

  it("earns the check's weight in proportion, not all or nothing", async () => {
    serve({ [PAGE]: page, "https://example.com/openapi.json": threeOperations });

    // 20 points, one of three operations typed.
    expect(check(await read(), /typed response schema/).earned).toBe(7);
  });

  it("has nothing to count when a spec declares no operations", async () => {
    serve({ [PAGE]: page, "https://example.com/openapi.json": spec({ paths: {} }) });

    const typed = check(await read(), /typed response schema/);

    expect(typed.status).toBe("not-applicable");
    expect(typed.detail).toContain("no operations");
  });
});

describe("rule 6 — same-site is eTLD+1", () => {
  it("does not probe a server the spec points at a third party", async () => {
    const mock = serve({
      [PAGE]: page,
      "https://example.com/openapi.json": spec({ servers: [{ url: "https://api.vendor.test/v1" }] }),
    });

    const result = await read();
    const errors = check(result, /Errors come back as parseable JSON/);

    expect(askedFor(mock).some((url) => url.includes("vendor.test"))).toBe(false);
    expect(errors.status).toBe("not-evaluated");
    expect(errors.detail).toContain("vendor.test");
  });

  it("does probe a subdomain, which is the case refusing one would break", async () => {
    const mock = serve({
      [PAGE]: page,
      "https://example.com/openapi.json": spec({ servers: [{ url: "https://api.example.com/v1" }] }),
      [`https://api.example.com/v1${PROBE_PATH}`]: {
        status: 404,
        headers: { "content-type": "application/problem+json" },
        body: JSON.stringify({ type: "about:blank", title: "Not Found", detail: "No such path." }),
      },
    });

    const result = await read();

    expect(result.apiBase).toBe("https://api.example.com/v1");
    expect(askedFor(mock)).toContain(`https://api.example.com/v1${PROBE_PATH}`);
    expect(check(result, /Errors come back as parseable JSON/).passed).toBe(true);
  });
});

describe("rule 7 — read-only and unauthenticated", () => {
  it("asks for everything with a plain GET and no credentials", async () => {
    const mock = serve({ [PAGE]: page, "https://example.com/openapi.json": spec() });

    await read();

    expect(mock.mock.calls.length).toBeGreaterThan(5);
    for (const [, init] of mock.mock.calls) {
      const headers = new Headers((init as RequestInit | undefined)?.headers ?? {});
      expect((init as RequestInit | undefined)?.method ?? "GET").toBe("GET");
      expect(headers.get("authorization")).toBeNull();
      expect(headers.get("cookie")).toBeNull();
    }
  });

  it("sees an error without causing one, at a path it announces", async () => {
    const mock = serve({ [PAGE]: page, "https://example.com/openapi.json": spec() });

    await read();

    // Self-describing on purpose: an operator reading their access log meets an
    // explanation rather than a mystery, and a reader can re-run the exact
    // request the finding is about.
    expect(askedFor(mock)).toContain(`https://example.com/api/v1${PROBE_PATH}`);
    expect(PROBE_PATH).toContain("thatseoagent");
  });
});

describe("rule 8 — a question we did not ask costs nothing", () => {
  it("says the site refused, rather than claiming innocence for it", async () => {
    serve({
      "example.com/robots.txt": { body: "User-agent: *\nDisallow: /api/" },
      [PAGE]: page,
      "https://example.com/openapi.json": spec(),
    });

    const result = await read();
    const errors = check(result, /Errors come back as parseable JSON/);
    const budget = check(result, /remaining budget/);

    for (const c of [errors, budget]) {
      expect(c.status, c.name).toBe("not-evaluated");
      expect(c.detail, c.name).toContain("robots.txt disallows");
      expect(c.detail, c.name).not.toContain("not a finding about the page");
    }
  });

  it("leaves the points on the table rather than charging for them", async () => {
    serve({
      "example.com/robots.txt": { body: "User-agent: *\nDisallow: /api/" },
      [PAGE]: page,
      "https://example.com/openapi.json": spec(),
    });

    const result = await read();

    // 15 for the error shape and 10 for the budget, out of neither side.
    expect(result.notEvaluated).toBe(25);
    // The five spec checks still have their denominator: the spec was readable,
    // it is the two response-shape questions we did not get to ask.
    expect(result.max).toBe(60);
  });
});

describe("the header list is ours, which is why it needs watching", () => {
  const probeRoute = (headers: Record<string, string>): Record<string, Route> => ({
    [PAGE]: page,
    "https://example.com/openapi.json": spec(),
    [`https://example.com/api/v1${PROBE_PATH}`]: {
      status: 404,
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify({ code: "not_found", message: "No such path." }),
    },
  });

  it("credits the de-facto X-RateLimit family as well as the draft", async () => {
    serve(probeRoute({ "x-ratelimit-remaining": "99" }));

    expect(check(await read(), /remaining budget/).passed).toBe(true);
  });

  it("does not credit Retry-After, which states no remaining budget", async () => {
    serve(probeRoute({ "retry-after": "30" }));

    // A 404 carrying `Retry-After` used to pass a check about a header it does
    // not have.
    expect(check(await read(), /remaining budget/).passed).toBe(false);
  });
});

describe("GraphQL is detected and not priced", () => {
  it("is absent rather than failed when nothing answers", async () => {
    serve({ [PAGE]: page });

    const graphql = check(await read(), /GraphQL/);

    // A red cross beside a line that says "its absence is not a defect"
    // contradicts itself in the same row.
    expect(graphql.points).toBe(0);
    expect(graphql.status).toBe("not-applicable");
    expect(graphql.passed).toBeUndefined();
  });

  it("reads a 405 as evidence of an endpoint, which is what one says to a bare GET", async () => {
    serve({ [PAGE]: page, "https://example.com/graphql": { status: 405, body: "Method Not Allowed" } });

    const graphql = check(await read(), /GraphQL/);

    expect(graphql.passed).toBe(true);
    expect(graphql.earned ?? 0).toBe(0);
  });

  it("does not read a login redirect as an endpoint", async () => {
    serve({
      [PAGE]: page,
      "https://example.com/graphql": { status: 302, headers: { location: "/login?next=/graphql" } },
      "https://example.com/login?next=/graphql": { status: 200, body: "sign in" },
    });

    // `/graphql` redirecting to `/login` answers 200, and reading that as a live
    // endpoint is how a site was reported to have GraphQL it does not serve.
    expect(check(await read(), /GraphQL/).status).toBe("not-applicable");
  });
});

describe("versioning is something a caller can address", () => {
  it("passes a versioned server URL", async () => {
    serve({ [PAGE]: page, "https://example.com/openapi.json": spec() });

    expect(check(await read(), /version an agent can pin to/).passed).toBe(true);
  });

  it("does not pass on a protocol-version header the caller cannot use", async () => {
    serve({
      [PAGE]: page,
      "https://example.com/openapi.json": spec({
        servers: [{ url: "https://example.com/api" }],
        paths: {
          "/things": {
            get: {
              operationId: "listThings",
              description: "List.",
              parameters: [{ name: "MCP-Protocol-Version", in: "header", schema: { type: "string" } }],
              responses: { "200": { description: "OK", content: { "application/json": { schema: { type: "array" } } } } },
            },
          },
        },
      }),
    });

    // A check its author passes by accident is worse than one it fails.
    expect(check(await read(), /version an agent can pin to/).passed).toBe(false);
  });
});
