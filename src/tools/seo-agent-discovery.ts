import { z } from "zod";
import { type ToolMetadata, type InferSchema } from "xmcp";
import { auditAgentDiscovery } from "../lib/analyzers/agent-discovery";
import { checksToFix, renderCheckSection } from "../lib/render-scored-checks";
import { defineCachedTool } from "../lib/define-tool";
import { domainFromUrl, refreshable } from "../lib/with-cache";
import { unwrap } from "../lib/type-guards";
import { toolText } from "../lib/tool-result";

export const schema = {
  ...refreshable,
  url: z
    .string()
    .url()
    .describe("A URL on the site whose agent-discovery artifacts should be audited"),
};

export const metadata: ToolMetadata = {
  name: "seo_agent_discovery",
  description:
    "Audit the artifacts an agent looks for before it reads a site: llms.txt, an " +
    "OpenAPI or MCP description, and the well-known documents that point at them. " +
    "Validates each payload's structure rather than its status code. Only ever adds " +
    "to a score: publishing none of them is reported as n/a, not as a failure. Needs " +
    "no credentials and no database.",
  annotations: {
    title: "Audit agent-discovery artifacts",
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: true,
  },
};

/** Completes the sentence "Could not …" for every failure this Tool can return. */
const FAILURE_CONTEXT = "audit the agent-discovery artifacts for this URL";

export default defineCachedTool(FAILURE_CONTEXT, { toolName: "seo_agent_discovery", domainOf: domainFromUrl }, async ({ url }: InferSchema<typeof schema>) => {
  const data = unwrap(await auditAgentDiscovery(url));
  const lines: string[] = [];

  lines.push("=== AGENT DISCOVERY ARTIFACTS ===");
  lines.push(
    "Every check validates the payload, not the status: these documents answer 200 while being structurally incomplete, which is the defect they exist to catch.",
  );
  // Said before the number, because it is the frame the number has to be read in.
  lines.push(
    "This tier only ever ADDS. Publishing none of these artifacts costs nothing at all — absence is reported as n/a, never as a failure.",
  );
  lines.push("");

  lines.push(`URL: ${data.url}`);
  lines.push(
    `Bonus earned: +${data.bonus.toFixed(1)} of a possible +${data.maxBonus.toFixed(1)} — the +${data.maxBonus} scale is ours, not a published standard, and it only ever adds.`,
  );
  if (data.quality.max > 0) {
    lines.push(
      `Of what you do publish: ${data.quality.score}/${data.quality.max} structural points — this is the number to act on, because it is only about artifacts you have already chosen to ship.`,
    );
  } else {
    lines.push(
      "You publish none of these artifacts, so there is nothing to be right or wrong about.",
    );
  }
  if (data.notEvaluated > 0) {
    // Precisely which number they leave, because they do not leave the bonus:
    // the bonus denominator is the full set of artifacts on purpose, so an
    // unreadable document earns nothing exactly as an absent one does.
    lines.push(
      `Coverage: ${data.notEvaluated} pts could not be read on this run. They are out of the quality fraction on both sides; in the bonus they simply earn nothing, the same as an artifact you have not published. A retry may change both without the site changing.`,
    );
  }

  // "ARTIFACTS", not "CHECKS": this tier reports on documents a site chose to
  // publish, and the heading is the frame the whole section is read in.
  lines.push(...renderCheckSection("ARTIFACTS", data.checks));

  const failing = checksToFix(data.checks);
  lines.push("");
  lines.push("=== WHAT TO FIX ===");
  if (failing.length === 0) {
    lines.push(
      data.quality.max > 0
        ? "Nothing: every artifact you publish is structurally complete."
        : "Nothing to fix. Publishing any of these artifacts would add to the bonus; not publishing them costs nothing.",
    );
  } else {
    // Only artifacts the site already publishes can appear here, by construction:
    // an absent one is n/a and n/a checks are filtered out above.
    for (const check of failing) lines.push(`- ${check.name}: ${check.detail}`);
  }

  return toolText(lines.join("\n"));
});
