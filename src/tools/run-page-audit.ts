import { z } from "zod";
import { type ToolMetadata, type InferSchema } from "xmcp";
import { defineCachedTool } from "../lib/define-tool";
import { refreshable } from "../lib/with-cache";
import { toolText } from "../lib/tool-result";
import { persistenceStatus } from "../lib/db/runtime";
import { NoDatabaseError, registerSite } from "../lib/sites";
import { normaliseAuditUrl, savePageAudit } from "../lib/page-audits";
import { analyzeOnPageSeo } from "../lib/analyzers/onpage-seo";
import { analyzeSecurityHeaders } from "../lib/analyzers/security-analyzer";

export const schema = {
  ...refreshable,
  url: z.string().url().describe("The page to audit, e.g. https://example.com/pricing"),
};

export const metadata: ToolMetadata = {
  name: "run_page_audit",
  description:
    "Audit one page and keep the result, so a later run can be compared against it. " +
    "Use this before and after changing a page: the second run shows what moved. For " +
    "a one-off look with nothing stored, seo_analyze_page is the same analysis without " +
    "the database. Needs the database; without one this Tool says so.",
  annotations: {
    title: "Audit a page and keep the result",
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: false,
    openWorldHint: true,
  },
};

/** Completes the sentence "Could not …" for every failure this Tool can return. */
const FAILURE_CONTEXT = "audit this page and store the result";

/** The Site a URL belongs to, which is what the audit is filed under. */
function siteOf(url: string): string {
  return new URL(url).hostname.replace(/^www\./, "");
}

export async function handler({ url }: InferSchema<typeof schema>) {
  const status = persistenceStatus();
  if (!status.available) {
    // Storing the result is the whole difference between this Tool and
    // `seo_analyze_page`. Producing one that is not stored would be that Tool
    // wearing this one's name.
    throw new NoDatabaseError(status.reason ?? "persistence is unavailable");
  }

  const normalised = normaliseAuditUrl(url);
  const site = registerSite(siteOf(normalised));

  // Throws rather than returning a Result when the page cannot be read, so
  // nothing is stored for a page we never saw. That is deliberate: a row saying
  // "we failed once" would be compared against by the next run as though it
  // described the page.
  const page = await analyzeOnPageSeo(normalised);

  const h1 = page.headings.h1 ?? [];
  const lines: string[] = ["=== PAGE AUDIT ==="];
  lines.push(`URL: ${normalised}`);
  lines.push(`Site: ${site.domain}`);
  lines.push("");
  lines.push(`Title: ${page.meta.title || "(none)"}`);
  lines.push(`Meta description: ${page.meta.description || "(none)"}`);
  lines.push(`Canonical: ${page.meta.canonical || "(none)"}`);
  lines.push(`Word count: ${page.content.wordCount}`);
  lines.push(`H1: ${h1.length === 0 ? "(none)" : h1.join(" | ")}`);
  lines.push(`Internal links: ${page.content.internalLinks}`);
  lines.push(`Images without alt text: ${page.images.withoutAlt.length} of ${page.images.total}`);

  const security = await analyzeSecurityHeaders(normalised);
  lines.push("");
  lines.push(
    security.success
      ? `Security headers: ${security.data.grade} (${security.data.score}/${security.data.maxScore})`
      : "Security headers: could not be read on this run.",
  );

  if (page.issues.length > 0) {
    lines.push("");
    lines.push(`=== ISSUES (${page.issues.length}) ===`);
    for (const issue of page.issues) lines.push(`  ${issue}`);
  }

  const report = lines.join("\n");
  const { previous } = savePageAudit(site.id, normalised, report);

  const output = [report, "", "=== AGAINST THE LAST AUDIT ==="];
  if (!previous?.contextJson) {
    output.push("This is the first audit stored for this page, so there is nothing to compare");
    output.push("against. Run it again after making a change and this section will show what");
    output.push("moved. get_page_audits lists everything stored for this Site.");
  } else {
    output.push(`Previous audit: ${previous.updatedAt.toISOString().slice(0, 10)}`);
    const changes = describeChanges(previous.contextJson, report);
    if (changes.length === 0) {
      output.push("Nothing measured here changed since then.");
    } else {
      output.push(...changes);
    }
  }

  return toolText(output.join("\n"));
}

/**
 * What differs between two stored audits, line by line.
 *
 * A line-level comparison rather than a stored structure, and that is a real
 * trade-off: it cannot say "the title got four characters longer", only that the
 * title line changed. What it buys is that the comparison never goes stale
 * against the report — a structured diff would need every new field added to it,
 * and the field somebody forgets is the one that silently stops being compared.
 *
 * Only the labelled facts are compared. Headings and counts of issues move for
 * reasons that are not changes to the page.
 */
function describeChanges(before: string, after: string): string[] {
  const labelled = (text: string) =>
    new Map(
      text
        .split("\n")
        .filter((line) => /^[A-Z][^=]*: /.test(line))
        .map((line) => {
          const at = line.indexOf(": ");
          return [line.slice(0, at), line.slice(at + 2)] as const;
        }),
    );

  const was = labelled(before);
  const is = labelled(after);
  const changes: string[] = [];

  for (const [label, value] of is) {
    const previous = was.get(label);
    if (previous === undefined || previous === value) continue;
    changes.push(`  ${label}: was "${previous}", now "${value}"`);
  }

  return changes;
}

export default defineCachedTool(
  FAILURE_CONTEXT,
  {
    toolName: "run_page_audit",
    domainOf: (args) => (args.url ? siteOf(args.url) : null),
    // Short. This Tool writes a record, and a cached answer would be a run the
    // Operator asked for that stored nothing — while telling them it had.
    ttlMs: 60_000,
  },
  handler,
);
