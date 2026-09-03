import { z } from "zod";
import { type ToolMetadata, type InferSchema } from "xmcp";
import { defineCachedTool } from "../lib/define-tool";
import { refreshable } from "../lib/with-cache";
import { toolText } from "../lib/tool-result";
import { persistenceStatus } from "../lib/db/runtime";
import { findSite, NoDatabaseError } from "../lib/sites";
import { findPageAudit, listPageAudits } from "../lib/page-audits";
import { InvalidInputError } from "../lib/invalid-input-error";

export const schema = {
  ...refreshable,
  domain: z.string().describe("The Site whose page audits to read, e.g. `example.com`."),
  url: z
    .string()
    .url()
    .optional()
    .describe("One page's stored audit, in full. Omit to list every page audited for this Site."),
};

export const metadata: ToolMetadata = {
  name: "get_page_audits",
  description:
    "Read back the page audits stored for a Site: which pages have been audited and " +
    "when, or one page's audit in full. Only shows what run_page_audit has stored. " +
    "Needs the database; without one this Tool says so.",
  annotations: {
    title: "Read stored page audits",
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
};

/** Completes the sentence "Could not …" for every failure this Tool can return. */
const FAILURE_CONTEXT = "read the stored page audits for this Site";

export async function handler({ domain, url }: InferSchema<typeof schema>) {
  const status = persistenceStatus();
  if (!status.available) {
    throw new NoDatabaseError(status.reason ?? "persistence is unavailable");
  }

  const site = findSite(domain);
  if (!site) {
    // Not registered is a different thing from having no audits, and the fix
    // differs: one is a Tool call away, the other is that nothing has been run.
    throw new InvalidInputError(
      `${domain} is not a registered Site, so there are no page audits for it. ` +
        `run_page_audit on any of its pages registers it and stores the first one.`,
    );
  }

  const lines: string[] = ["=== STORED PAGE AUDITS ==="];
  lines.push(`Site: ${site.domain}`);

  if (url) {
    const audit = findPageAudit(site.id, url);
    if (!audit?.contextJson) {
      lines.push("");
      lines.push(`No audit is stored for ${url}.`);
      lines.push("");
      lines.push("run_page_audit on it to store one. Note that a URL differing only by its");
      lines.push("query string is a different page here, so check the address if you expected");
      lines.push("one — the list below shows exactly what is stored.");
      const stored = listPageAudits(site.id);
      for (const entry of stored) lines.push(`  ${entry.url}`);
      return toolText(lines.join("\n"));
    }

    lines.push(`First audited: ${audit.createdAt.toISOString().slice(0, 10)}`);
    lines.push(`Last audited: ${audit.updatedAt.toISOString().slice(0, 10)}`);
    lines.push("");
    lines.push(audit.contextJson);
    lines.push("");
    lines.push("=== NOTE ===");
    lines.push("This is the audit as it was stored, not a fresh read of the page. Run");
    lines.push("run_page_audit again to see what the page looks like now and what moved.");
    return toolText(lines.join("\n"));
  }

  const audits = listPageAudits(site.id);
  if (audits.length === 0) {
    lines.push("");
    lines.push("No page audits stored for this Site yet.");
    lines.push("");
    lines.push("run_page_audit stores one per page. It is worth running before and after a");
    lines.push("change: the second run reports what moved.");
    return toolText(lines.join("\n"));
  }

  lines.push(`Pages audited: ${audits.length}`);
  lines.push("");
  lines.push("Most recently audited first:");
  for (const audit of audits) {
    // Both dates, because they answer different questions: how long this page
    // has been tracked, and how stale the stored audit is.
    lines.push(
      `  ${audit.url} — last ${audit.updatedAt.toISOString().slice(0, 10)}, ` +
        `first ${audit.createdAt.toISOString().slice(0, 10)}`,
    );
  }

  lines.push("");
  lines.push("Pass `url` to read any of these in full.");

  return toolText(lines.join("\n"));
}

export default defineCachedTool(
  FAILURE_CONTEXT,
  { toolName: "get_page_audits", domainOf: (args) => args.domain ?? null, ttlMs: 60_000 },
  handler,
);
