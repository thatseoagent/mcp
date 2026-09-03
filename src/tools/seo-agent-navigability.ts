import { z } from "zod";
import { type ToolMetadata, type InferSchema } from "xmcp";
import { auditAgentNavigability } from "../lib/analyzers/agent-navigability";
import {
  checksToFix,
  renderCheckSection,
  renderCoverage,
} from "../lib/render-scored-checks";
import { defineCachedTool } from "../lib/define-tool";
import { domainFromUrl, refreshable } from "../lib/with-cache";
import { toolFailure } from "../lib/tool-failure";
import { toolText } from "../lib/tool-result";

export const schema = {
  ...refreshable,
  url: z.string().url().describe("The URL to audit for the HTTP behaviour an agent depends on"),
};

export const metadata: ToolMetadata = {
  name: "seo_agent_navigability",
  description:
    "Audit the HTTP behaviour an agent depends on when it reads one URL: whether a " +
    "missing path returns a real 404, whether redirects resolve, what content types " +
    "are offered, and whether the markup can be read without running JavaScript. " +
    "Every finding ships with the request that produced it. Needs no credentials and " +
    "no database.",
  annotations: {
    title: "Audit agent navigability",
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: true,
  },
};

/** Completes the sentence "Could not …" for every failure this Tool can return. */
const FAILURE_CONTEXT = "audit agent navigability for this URL";

export default defineCachedTool(FAILURE_CONTEXT, { toolName: "seo_agent_navigability", domainOf: domainFromUrl }, async ({ url }: InferSchema<typeof schema>) => {
  const result = await auditAgentNavigability(url);

  if (!result.success) {
    return toolFailure(result.error, FAILURE_CONTEXT);
  }

  const data = result.data;
  const lines: string[] = [];

  lines.push("=== AGENT NAVIGABILITY (HTTP behaviour) ===");
  lines.push(
    "Every check below is an assertion about an HTTP response, not a claim about ranking or citation.",
  );
  lines.push("Each one states the request that produced it, so any finding can be re-run.");
  lines.push("");

  lines.push(`URL: ${data.url}`);
  if (data.finalUrl !== data.url) lines.push(`Landed on: ${data.finalUrl}`);
  lines.push(`Score: ${data.score}/${data.max}`);

  lines.push(...renderCoverage(data));

  lines.push(...renderCheckSection("CHECKS", data.checks));

  const failing = checksToFix(data.checks);
  lines.push("");
  lines.push("=== WHAT TO FIX ===");
  if (failing.length === 0) {
    lines.push("Nothing: every check that could run on this URL passed in full.");
  } else {
    for (const check of failing) lines.push(`- ${check.name}: ${check.detail}`);
  }

  return toolText(lines.join("\n"));
});
