import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

/**
 * The server as an MCP client actually meets it: a real process, spoken to over
 * HTTP, with nothing configured beyond the key ADR-0004 makes mandatory.
 *
 * This is the only test that exercises the built artifact rather than the source,
 * and it is what makes "starts on a clean machine" a claim rather than a hope.
 * Nothing is configured: the server needs no environment beyond Node.
 *
 * Requires `pnpm build` first; run via `pnpm test:e2e`.
 */

const DIST = path.resolve(__dirname, "../../dist/http.js");
/**
 * The launcher, not the bundle, because that is what `pnpm start` and the
 * published `bin` run. Starting the bundle directly would skip the port guard
 * this server depends on to be reachable at all.
 */
const LAUNCHER = path.resolve(__dirname, "../../scripts/start.mjs");
import { MCP_URL, HTTP_HOST, HTTP_PORT } from "../../src/lib/server-address";

let server: ChildProcess;
let stderr = "";
let id = 0;

async function rpc(method: string, params: unknown = {}) {
  const headers: Record<string, string> = {
    "content-type": "application/json",
    accept: "application/json, text/event-stream",
  };

  const response = await fetch(MCP_URL, {
    method: "POST",
    headers,
    body: JSON.stringify({ jsonrpc: "2.0", id: ++id, method, params }),
  });

  const text = await response.text();
  if (!response.ok) return { status: response.status, body: text };

  // Streamable HTTP answers as SSE (`event: message` / `data: {…}`) rather than
  // a plain JSON body, so the frame has to be unwrapped. Both shapes are handled
  // because which one arrives is the server's choice, not ours.
  const data = text
    .split("\n")
    .filter((line) => line.startsWith("data:"))
    .pop()
    ?.slice("data:".length);

  try {
    return { status: response.status, ...JSON.parse(data ?? text) };
  } catch (error) {
    // Surfacing the body beats `undefined is not an object` three lines later in
    // whichever assertion happened to read `.result` first.
    throw new Error(`${method}: could not parse response (${response.status}): ${text.slice(0, 400)}`);
  }
}

beforeAll(async () => {
  if (!existsSync(DIST)) throw new Error(`Build first: ${DIST} does not exist`);

  server = spawn(process.execPath, [LAUNCHER], {
    // Deliberately bare, and load-bearing rather than tidy. Nothing is
    // configured — no `PAGESPEED_API_KEY`, no credentials of any kind — which is
    // what makes the listing assertion below a real test of ADR-0003: every Tool
    // has to appear whether or not it is currently usable.
    // `TSA_DB_PATH=off` rather than unset, and it is the point of this file
    // rather than tidiness: unset would create a database under `db/`, and the
    // claim being tested is that the whole credential-free surface works with
    // *no* persistence at all. It also keeps the suite from leaving a file
    // behind. `tests/e2e/persistence.test.ts` covers the other direction.
    env: {
      PATH: process.env.PATH ?? "",
      HOME: process.env.HOME ?? "",
      TSA_DB_PATH: "off",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });

  // Kept so a startup failure can be reported instead of surfacing as a timeout
  // with nothing to read.
  server.stderr?.on("data", (chunk: Buffer) => {
    stderr += chunk.toString();
  });

  const deadline = Date.now() + 20_000;
  let somethingAnswered = false;

  for (;;) {
    if (server.exitCode !== null) {
      throw new Error(`server exited with ${server.exitCode} before listening:\n${stderr}`);
    }
    if (Date.now() > deadline) {
      // Two different failures, and saying which one saves the next reader the
      // twenty minutes this cost the first time.
      throw new Error(
        somethingAnswered
          ? `port ${HTTP_PORT} is held by something that is not this server. ` +
            `Note that xmcp does not fail on a busy port — it increments — so this ` +
            `server may be running fine on ${HTTP_PORT + 1}.\n${stderr}`
          : `nothing is listening on port ${HTTP_PORT} after 20s:\n${stderr}`,
      );
    }

    // A real handshake rather than a bare probe, because "something is listening"
    // is not the question. The port is compiled in and xmcp quietly moves to the
    // next one when it is taken, so an unrelated application can end up holding
    // the URL every later assertion talks to.
    try {
      const res: any = await rpc("initialize", {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "readiness", version: "0" },
      });
      somethingAnswered = true;
      if (res?.result?.serverInfo?.name === "thatseoagent-mcp") return;
    } catch (error) {
      // A parse failure means something answered and it was not MCP, which is
      // still "somebody else has the port" — distinct from connection refused.
      if (error instanceof Error && error.message.includes("could not parse")) {
        somethingAnswered = true;
      }
    }
    await new Promise((r) => setTimeout(r, 150));
  }
}, 30_000);

afterAll(() => server?.kill());

describe("the built HTTP server", () => {
  it("does not answer a cross-origin request", async () => {
    // The server has no authentication, so this is its only defence. Loopback is
    // reachable from a browser, and xmcp's default `origin: "*"` would let any
    // page the Operator visits drive their Tools from JavaScript.
    const response = await fetch(MCP_URL, {
      method: "OPTIONS",
      headers: {
        origin: "https://evil.example",
        "access-control-request-method": "POST",
        "access-control-request-headers": "content-type",
      },
    });

    expect(response.headers.get("access-control-allow-origin")).toBeNull();
  });

  it("completes an MCP handshake", async () => {
    const res: any = await rpc("initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "acceptance-test", version: "0" },
    });

    expect(res.error).toBeUndefined();
    // Not `toBeTruthy()`: the scaffold's placeholder "xmcp server" satisfied that
    // and shipped as the server's identity.
    expect(res.result.serverInfo.name).toBe("thatseoagent-mcp");
  });

  it("serves its own page at the root, not xmcp's", async () => {
    // Not part of the MCP protocol — a client only ever talks to `/mcp`. This is
    // for the person who pasted the URL into a browser after `pnpm start`.
    const response = await fetch(`http://${HTTP_HOST}:${HTTP_PORT}/`);
    const html = await response.text();

    expect(response.status).toBe(200);
    expect(html).toContain("That SEO Agent");
    // The warm-paper ground and the one lamp, carried from the design system.
    expect(html).toContain("#F8F5F1");
    expect(html).toContain("#C4331A");
    // And the endpoint a reader needs, which is the point of the page.
    expect(html).toContain(MCP_URL);
    expect(html).not.toContain("xmcp");
  });

  it("delivers its instructions in the handshake", async () => {
    // An agent handed 55 Tools picks the ones whose names match the request.
    // These are what it reads before its first call.
    const res: any = await rpc("initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "acceptance-test", version: "0" },
    });

    expect(res.result.instructions).toBeTruthy();
    expect(res.result.instructions).toContain("run_site_audit");
    expect(res.result.instructions).toContain("A check that");
  });

  it("offers its orchestration prompts", async () => {
    const res: any = await rpc("prompts/list");
    const names = res.result.prompts.map((prompt: { name: string }) => prompt.name).sort();

    expect(names).toEqual(["audit_site", "find_quick_wins", "track_progress"]);
  });

  it("renders a prompt with the domain filled in", async () => {
    const res: any = await rpc("prompts/get", {
      name: "find_quick_wins",
      arguments: { domain: "example.com" },
    });

    const text = JSON.stringify(res.result.messages);
    expect(text).toContain("example.com");
    expect(text).toContain("gsc_detect_quick_wins");
  });

  it("serves the playbooks as resources", async () => {
    const res: any = await rpc("resources/list");
    const names = res.result.resources.map((resource: { name: string }) => resource.name).sort();

    expect(names).toEqual(["geo-optimization", "quick-wins", "site-audit"]);
  });

  it("reads a playbook back", async () => {
    const listed: any = await rpc("resources/list");
    const uri = listed.result.resources.find(
      (resource: { name: string }) => resource.name === "site-audit",
    ).uri;

    const res: any = await rpc("resources/read", { uri });

    expect(res.result.contents[0].text).toContain("Reading Search Console numbers");
  });

  it("lists every Tool the server ships", async () => {
    const res: any = await rpc("tools/list");
    const names = res.result.tools.map((t: { name: string }) => t.name);

    expect(names.sort()).toEqual([
      "ai_visibility_score",
      "crawl_site",
      "entity_mentions",
      "ga4_ai_traffic",
      "ga4_check_compatibility",
      "ga4_custom_definitions",
      "ga4_get_realtime",
      "ga4_key_events",
      "ga4_list_properties",
      "ga4_metadata",
      "ga4_pivot_report",
      "ga4_run_report",
      "get_page_audits",
      "gsc_branded_split",
      "gsc_bulk_url_inspection",
      "gsc_country_opportunity",
      "gsc_crawl_freshness",
      "gsc_detect_anomalies",
      "gsc_detect_cannibalization",
      "gsc_detect_featured_snippets",
      "gsc_detect_lost_queries",
      "gsc_detect_quick_wins",
      "gsc_detect_trends",
      "gsc_device_gap",
      "gsc_discover_performance",
      "gsc_get_sitemap",
      "gsc_index_coverage_analysis",
      "gsc_inspect_url",
      "gsc_list_properties",
      "gsc_list_sitemaps",
      "gsc_page_query_map",
      "gsc_rich_results",
      "gsc_search_analytics",
      "gsc_search_appearance",
      "gsc_serp_features_gap",
      "gsc_sites_health_check",
      "pagespeed_insights",
      "run_page_audit",
      "run_site_audit",
      "seo_agent_api_surface",
      "seo_agent_discovery",
      "seo_agent_navigability",
      "seo_analyze_page",
      "seo_content_analysis",
      "seo_crawlability_audit",
      "seo_eeat_score",
      "seo_geo_score",
      "seo_hreflang_validator",
      "seo_llms_txt",
      "seo_metric_trend",
      "seo_robots_validator",
      "seo_schema_detection",
      "seo_schema_generator",
      "seo_security_headers",
      "sync_gsc_properties",
    ]);
  });

  it("lists a Tool that is not configured, rather than hiding it", async () => {
    // ADR-0003: "Tools stay registered in `tools/list` regardless, because many
    // MCP clients cache that list and a tool that vanishes gives the agent
    // nothing to explain to the user; an error message does." This server is
    // running with nothing configured, so `pagespeed_insights` cannot work — and
    // it is listed anyway. The assertion above pins the full list, which is what
    // stops the listing from silently shrinking; this one names the Tool the
    // rule was written for.
    const res: any = await rpc("tools/list");
    const names = res.result.tools.map((t: { name: string }) => t.name);

    expect(names).toContain("pagespeed_insights");
  });

  it("lists a Google Tool with nobody logged in, and refuses with the login command", async () => {
    // The same ADR-0003 shape as `pagespeed_insights`, from the other kind of
    // configuration: this server has no Google tokens and no OAuth client.
    const listed: any = await rpc("tools/list");
    expect(listed.result.tools.map((t: { name: string }) => t.name)).toContain(
      "gsc_list_properties",
    );

    const res: any = await rpc("tools/call", {
      name: "gsc_list_properties",
      arguments: {},
    });

    expect(res.error).toBeUndefined();
    expect(res.result.isError).toBe(true);
    const text = res.result.content.map((c: { text: string }) => c.text).join("\n");
    // Without an OAuth client it cannot even reach the login; the refusal names
    // the variable to set. Either sentence is a correct answer here, and both
    // name something the Operator can act on.
    expect(text).toMatch(/GOOGLE_CLIENT_ID|thatseoagent-mcp-login/);
  });

  it("tells the Operator what to configure instead of failing the transport", async () => {
    const res: any = await rpc("tools/call", {
      name: "pagespeed_insights",
      arguments: { url: "https://www.wikipedia.org/" },
    });

    // A JSON-RPC error is the failure mode being ruled out: the agent cannot
    // relay one, so the Operator would be told nothing at all.
    expect(res.error).toBeUndefined();
    expect(res.result.isError).toBe(true);

    const text = res.result.content.map((c: { text: string }) => c.text).join("\n");
    expect(text).toContain("PAGESPEED_API_KEY");
    expect(text).toContain("https://console.cloud.google.com/apis/credentials");
  });

  it("crawls a real domain, honouring its robots.txt and pacing itself", async () => {
    // One page, because the point is that a crawl runs end to end against a real
    // site with nothing configured — not that we walk somebody else's server
    // fifty pages deep on every test run.
    const res: any = await rpc("tools/call", {
      name: "crawl_site",
      arguments: { url: "https://www.wikipedia.org/", maxPages: 1 },
    });

    expect(res.error).toBeUndefined();
    expect(res.result.isError).toBeFalsy();
    const text = res.result.content.map((c: { text: string }) => c.text).join("\n");
    expect(text).toContain("=== PAGE CRAWL REPORT ===");
    expect(text).toContain("=== NOT EVALUATED ===");
  }, 60_000);

  it("validates the robots.txt of a real domain", async () => {
    const res: any = await rpc("tools/call", {
      name: "seo_robots_validator",
      arguments: { url: "https://www.wikipedia.org/" },
    });

    expect(res.error).toBeUndefined();
    expect(res.result.isError).toBeFalsy();
    const text = res.result.content.map((c: { text: string }) => c.text).join("\n");
    expect(text).toContain("=== SUMMARY ===");
    expect(text).toContain("Exists: Yes");
  });

  // Every Tool that reads a page, against one real URL, with nothing configured.
  // The assertion is deliberately shallow — that the Tool ran and answered — because
  // what each one reports about a live page is not ours to pin and changes without
  // us. What this establishes is the claim the issue makes: no credentials, no
  // database, real network.
  const READS_A_PAGE = [
    ["seo_analyze_page", "=== META ==="],
    ["seo_content_analysis", "=== CONTENT METRICS ==="],
    ["seo_schema_detection", "=== SUMMARY ==="],
    ["seo_eeat_score", "=== E-E-A-T SCORE ==="],
    ["seo_geo_score", "=== GEO SCORE ==="],
    ["ai_visibility_score", "=== AI VISIBILITY SCORE"],
    ["entity_mentions", "=== ENTITY MENTIONS AUDIT ==="],
    ["seo_crawlability_audit", "=== CRAWLABILITY AUDIT ==="],
    ["seo_security_headers", "=== SECURITY SCORE ==="],
    ["seo_hreflang_validator", "=== HREFLANG VALIDATION ==="],
    ["seo_agent_discovery", "=== AGENT DISCOVERY ARTIFACTS ==="],
    ["seo_agent_navigability", "=== AGENT NAVIGABILITY"],
    ["seo_agent_api_surface", "=== AGENT API SURFACE ==="],
    ["seo_llms_txt", "=== LLMs.txt AUDIT ==="],
  ] as const;

  for (const [name, heading] of READS_A_PAGE) {
    it(`runs ${name} against a real URL with nothing configured`, async () => {
      const res: any = await rpc("tools/call", {
        name,
        arguments: { url: "https://www.wikipedia.org/" },
      });

      expect(res.error).toBeUndefined();
      expect(res.result.isError).toBeFalsy();
      const text = res.result.content.map((c: { text: string }) => c.text).join("\n");
      expect(text).toContain(heading);
    }, 30_000);
  }

  it("generates schema markup without reading anything at all", async () => {
    const res: any = await rpc("tools/call", {
      name: "seo_schema_generator",
      arguments: { type: "Organization", data: { name: "Acme Ltd", url: "https://acme.example" } },
    });

    expect(res.error).toBeUndefined();
    expect(res.result.isError).toBeFalsy();
    const text = res.result.content.map((c: { text: string }) => c.text).join("\n");
    expect(text).toContain('"name": "Acme Ltd"');
  });

  it("refuses a private address instead of fetching it", async () => {
    const res: any = await rpc("tools/call", {
      name: "seo_robots_validator",
      arguments: { url: "http://169.254.169.254/" },
    });

    const text = res.result.content.map((c: { text: string }) => c.text).join("\n");
    expect(text).toContain("private/reserved address");
  });
});
