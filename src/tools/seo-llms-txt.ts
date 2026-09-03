import { z } from "zod";
import { type ToolMetadata, type InferSchema } from "xmcp";
import { readWellKnown } from "../lib/well-known";
import { notScored } from "../lib/analyzers/scored-checks";
import { auditDeclaredLinks, parseLinks } from "../lib/llms-txt-links";
import { scoreLlmsTxt } from "../lib/analyzers/llms-txt-analyzer";
import { renderCoverage } from "../lib/render-scored-checks";
import {
  buildGeneratedTemplate,
  checkLlmsFullTxt,
  LLMS_TXT_TEMPLATE,
  readSiteForGeneration,
} from "../lib/llms-txt-generator";
import { defineCachedTool } from "../lib/define-tool";
import { domainFromUrl, refreshable } from "../lib/with-cache";
import { InvalidInputError } from "../lib/invalid-input-error";
import { toolText } from "../lib/tool-result";

export const schema = {
  ...refreshable,
  url: z.string().describe("Homepage URL (e.g. https://example.com)"),
  generate: z
    .boolean()
    .optional()
    .describe(
      "Set to true to generate a ready-to-use llms.txt based on real site data " +
        "(reads the homepage title and description and the sitemap). " +
        "Automatically triggered when the file is missing or scores below 40% of the points that could be asked of it " +
        "— the maximum is not always 100, because a check that could not run leaves both sides of the score. " +
        "Pass generate=true when the file exists but you want a fresh improved template.",
    ),
};

export const metadata: ToolMetadata = {
  name: "seo_llms_txt",
  description:
    "Read and score a site's /llms.txt, and generate one from the site's own pages. " +
    "Checks the title, the description, the declared links — including whether those " +
    "links actually reach real content — and the Optional section. A file that could " +
    "not be read is reported as unread, never as absent. Needs no credentials and no " +
    "database.",
  annotations: {
    title: "Audit llms.txt",
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: true,
  },
};

/** Completes the sentence "Could not …" for every failure this Tool can return. */
const FAILURE_CONTEXT = "audit the llms.txt for this site";

/** The one Tool worth running next, named exactly as it is registered. */
const ROBOTS_TIP =
  "Tip: run seo_robots_validator to verify AI bots (GPTBot, ClaudeBot, PerplexityBot) are not blocked.";

/**
 * What the site says about the sitemap it was generated from.
 *
 * Two counts, not one: `urlsFound` says whether the site could be enumerated at
 * all, `pages.length` how many of those were read. A reader with only the second
 * cannot tell an empty sitemap from a cap being hit.
 */
function provenance(site: {
  urlsFound: number;
  pages: ReadonlyArray<{ title?: string; description?: string }>;
}): string {
  if (site.urlsFound === 0) {
    return "(Could not read the sitemap — add your key page URLs by hand.)";
  }
  return (
    `(${site.urlsFound} URLs in your sitemap; ${site.pages.length} read. ` +
    `${site.pages.filter((p) => p.title).length} contributed their own title and ` +
    `${site.pages.filter((p) => p.description).length} their own meta description — ` +
    `a link with no description is a page missing one, which is worth fixing at the source.)`
  );
}

export default defineCachedTool(
  FAILURE_CONTEXT,
  { toolName: "seo_llms_txt", domainOf: domainFromUrl },
  async ({ url, generate }: InferSchema<typeof schema>) => {
    const lines: string[] = [];

    // A bare hostname is accepted on purpose — `example.com` is how anyone talks
    // about a site — which is why the schema says `z.string()` where every
    // sibling Tool says `.url()`. The scheme is supplied here, and what cannot be
    // read as a URL even then is thrown rather than rendered: `tool-failure.ts`
    // asks that every failure path route through the one seam, and a handler
    // that builds its own error result has quietly opted out of it.
    let origin: string;
    try {
      origin = new URL(url.startsWith("http") ? url : `https://${url}`).origin;
    } catch {
      throw new InvalidInputError("Invalid URL format");
    }

    const llmsTxtUrl = `${origin}/llms.txt`;

    lines.push("=== LLMs.txt AUDIT ===");
    lines.push("");
    lines.push(`URL checked: ${llmsTxtUrl}`);

    // `readWellKnown` rather than a private `safeFetch`: this Tool kept its own
    // fetch and its own `catch {}`, so a 5xx, a DNS failure, an SSRF refusal and
    // a robots refusal all arrived at the same place as a 404.
    const [read, fullTxtRead] = await Promise.all([
      readWellKnown(origin, "/llms.txt", { timeout: 10_000 }),
      checkLlmsFullTxt(origin),
    ]);

    // The footnote, and it has three forms. Silence is the right third form: an
    // optional extended file we could not check is not worth a line of advice.
    const fullTxtNote =
      fullTxtRead.outcome === "found"
        ? "Note: /llms-full.txt also detected — an extended version is present."
        : fullTxtRead.outcome === "absent"
          ? "Note: /llms-full.txt not found — consider a verbose version with full page content (optional, advanced)."
          : `Note: ${notScored(`/llms-full.txt could not be checked on this run (${fullTxtRead.reason})`)}`;

    // ── No answer ──────────────────────────────────────────────────────────
    //
    // Everything below this block — the verdict, the 0/100, the generated
    // template — is advice derived from a conclusion, so none of it can outlive
    // the conclusion. A site that 5xx'd is not a site without an llms.txt, and
    // telling it to create one is a confident lie.
    if (read.outcome === "unavailable") {
      lines.push("");
      lines.push("Status: NOT ESTABLISHED");
      lines.push("");
      lines.push(notScored(`we could not read ${llmsTxtUrl} on this run`, "retry to find out"));
      lines.push("");
      lines.push(`Reason: ${read.reason}`);
      if (read.status > 0) lines.push(`HTTP status: ${read.status}`);
      lines.push("");
      lines.push("No score: there is nothing to score until the file is read.");
      lines.push(
        "Re-run this check; if it keeps failing, the file may be behind auth, a WAF or a CDN rule.",
      );
      lines.push("");
      lines.push(fullTxtNote);

      return toolText(lines.join("\n"));
    }

    const content: string | null = read.outcome === "found" ? read.text : null;
    const statusCode: number = read.status;

    // `!content` still catches a 200 serving an empty body, which reaches the
    // "does not exist" branch. That is its own question and deliberately not
    // answered differently here.
    if (!content) {
      lines.push("");
      lines.push("Status: NOT FOUND");
      lines.push("");
      lines.push("Your site does not have a /llms.txt file.");
      lines.push(
        "This is an emerging standard that tells AI engines (ChatGPT, Perplexity, Claude, and others)",
      );
      lines.push("which content is citable and how to understand your site.");
      lines.push("");
      lines.push("=== HOW TO CREATE llms.txt ===");
      lines.push("");
      lines.push("Create a plain text file at the root of your site: /llms.txt");
      lines.push("");

      const site = await readSiteForGeneration(origin);

      lines.push("=== GENERATED llms.txt (ready to use) ===");
      lines.push("");
      lines.push("Copy the content below and save it as /llms.txt at your site root:");
      lines.push("");
      lines.push("```");
      lines.push(buildGeneratedTemplate(origin, site.title, site.description, site.pages));
      lines.push("```");
      lines.push("");
      lines.push(provenance(site));

      lines.push("");
      lines.push("=== COMPLETENESS SCORE ===");
      lines.push("Score: 0/100 — the file does not exist.");
      lines.push("");
      lines.push("Impact: AI engines cannot efficiently identify your citable content.");

      lines.push("");
      lines.push(fullTxtNote);
      lines.push("");
      lines.push(ROBOTS_TIP);

      return toolText(lines.join("\n"));
    }

    lines.push(`Status: FOUND (HTTP ${statusCode})`);
    lines.push("");

    // ── Read it ──────────────────────────────────────────────────────────────

    // One parse for both counts, and for the decision below. Deriving the
    // relative count by subtracting a de-duplicated absolute count from a raw
    // line count made a file that repeats a URL report a relative link it does
    // not have.
    const links = parseLinks(content);

    // The one check that needs the network, resolved here because the analyzer is
    // pure — the same split as `EeatInput.trustPages` and `GeoInput.robotsRead`.
    const linkAudit =
      links.absolute.length > 0 ? await auditDeclaredLinks(links.absolute, origin) : null;

    const { totals, score, max, percent, grade, found, issues, notes, linkCoverage } =
      scoreLlmsTxt({ content, links, linkAudit });

    // ── Output ───────────────────────────────────────────────────────────────

    lines.push("=== VALIDATION RESULTS ===");
    lines.push("");

    if (found.length > 0) {
      lines.push("Found:");
      for (const f of found) lines.push(`  ✓ ${f}`);
      lines.push("");
    }

    if (issues.length > 0) {
      lines.push("Issues:");
      for (const issue of issues) lines.push(`  ✗ ${issue}`);
      lines.push("");
    }

    if (notes.length > 0) {
      // Their own heading, because a "?" under "Issues" is read as a defect.
      // These are questions we failed to ask, not answers about the file.
      lines.push("Not measured:");
      for (const note of notes) lines.push(`  ? ${note}`);
      lines.push("");
    }

    lines.push("=== COMPLETENESS SCORE ===");
    lines.push(`Score: ${score}/${max}`);
    // The two states `tally` keeps apart stay apart, and `renderCoverage` is what
    // keeps them apart for every scored surface: a file with no links takes
    // `not-applicable` — structural, the same answer every run — and telling that
    // reader "a retry may change the score" blames our network for their file.
    lines.push(...renderCoverage(totals, { subject: "this file" }));
    if (linkCoverage) lines.push(`Links: ${linkCoverage}.`);

    lines.push(`Grade: ${grade}`);
    lines.push("");

    if (score < max) {
      lines.push("=== RECOMMENDATIONS ===");
      for (const issue of issues) lines.push(`- ${issue}`);
      lines.push("");
      lines.push("Reference format:");
      lines.push(LLMS_TXT_TEMPLATE);
      if (percent >= 40 && !generate) {
        lines.push("");
        lines.push("Tip: call this Tool with generate=true for a ready-to-use improved template.");
      }
    }

    if (percent < 40 || generate === true) {
      const site = await readSiteForGeneration(origin);

      lines.push("");
      lines.push("=== GENERATED llms.txt (improved template) ===");
      lines.push("");
      if (percent < 40 && generate !== true) {
        lines.push("The score is low, so here is a template built from your real site data:");
        lines.push("");
      }
      lines.push("```");
      lines.push(buildGeneratedTemplate(origin, site.title, site.description, site.pages));
      lines.push("```");
      lines.push("");
      lines.push(provenance(site));
    }

    lines.push("");
    lines.push(fullTxtNote);
    lines.push("");
    lines.push(ROBOTS_TIP);

    // Preview
    const preview = content.length > 500 ? content.slice(0, 500) + "\n... (truncated)" : content;
    lines.push("");
    lines.push("=== FILE PREVIEW ===");
    lines.push(preview);

    return toolText(lines.join("\n"));
  },
);
