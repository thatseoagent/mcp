import { z } from "zod";
import { type ToolMetadata, type InferSchema } from "xmcp";
import { auditAgentApiSurface } from "../lib/analyzers/agent-api-surface";
import {
  checksToFix,
  renderCheckSection,
  renderCoverage,
} from "../lib/render-scored-checks";
import { defineCachedTool } from "../lib/define-tool";
import { domainFromUrl, refreshable } from "../lib/with-cache";
import { unwrap } from "../lib/type-guards";
import { toolText } from "../lib/tool-result";

export const schema = {
  ...refreshable,
  url: z.string().url().describe("A URL on the site whose API surface should be audited"),
};

export const metadata: ToolMetadata = {
  name: "seo_agent_api_surface",
  description:
    "Audit the API a site offers an agent: find its OpenAPI or MCP description, check " +
    "the document is complete and reachable, and probe the base it declares. Read-only " +
    "GETs only — nothing authenticates and nothing writes. A site with no API " +
    "description is reported as out of scope, not as failing. Needs no credentials and " +
    "no database.",
  annotations: {
    title: "Audit agent API surface",
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: true,
  },
};

/** Completes the sentence "Could not …" for every failure this Tool can return. */
const FAILURE_CONTEXT = "audit the API surface for this URL";

export default defineCachedTool(FAILURE_CONTEXT, { toolName: "seo_agent_api_surface", domainOf: domainFromUrl }, async ({ url }: InferSchema<typeof schema>) => {
  const data = unwrap(await auditAgentApiSurface(url));
  const lines: string[] = [];

  lines.push("=== AGENT API SURFACE ===");
  lines.push(
    "Every check below is an assertion about a served document or an HTTP response, not a claim about ranking or citation.",
  );
  lines.push("All probes are read-only GETs. Nothing here authenticates, and nothing here writes.");
  lines.push("");

  lines.push(`URL: ${data.url}`);

  if (!data.specUrl) {
    // Said first and said plainly, because it is the whole result for most
    // sites: no API description means this tier has nothing to measure, and a
    // score of 0 would be a verdict on a site that never entered the contest.
    lines.push("API description: none found.");
    lines.push("");
    lines.push(
      "Nothing in this tier is scored. A site with no API is not a site with a failing API — see the discovery line below for where we looked.",
    );
  } else {
    lines.push(`API description: ${data.specUrl}`);
    if (data.apiBase) lines.push(`API base probed: ${data.apiBase}`);
    lines.push(`Score: ${data.score}/${data.max}`);
  }

  lines.push(...renderCoverage(data));

  lines.push(...renderCheckSection("CHECKS", data.checks));

  const failing = checksToFix(data.checks);
  lines.push("");
  lines.push("=== WHAT TO FIX ===");
  if (failing.length === 0) {
    lines.push(
      data.specUrl
        ? "Nothing: every check that could run on this spec passed in full."
        : "Nothing to fix here: this tier only applies to a site that publishes an API description.",
    );
  } else {
    for (const check of failing) lines.push(`- ${check.name}: ${check.detail}`);
  }

  return toolText(lines.join("\n"));
});
