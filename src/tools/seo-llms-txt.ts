import { z } from "zod";
import { type ToolMetadata, type InferSchema } from "xmcp";
import { readWellKnown } from "../lib/well-known";
import { notScored, tally, type Scorable } from "../lib/analyzers/scored-checks";
import { auditDeclaredLinks, coverageOf, parseLinks } from "../lib/llms-txt-links";
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

    // ── Parse and validate ───────────────────────────────────────────────────

    const fileLines = content.split(/\r?\n/);
    const issues: string[] = [];
    const found: string[] = [];
    /**
     * Sentences about what we could not measure, kept out of `issues`.
     *
     * `issues` drives the recommendations, so a `notScored(...)` string in it
     * printed "Fix: Not scored: … This is not a finding about the page" and
     * marked a correct file invalid because one link timed out. That is the
     * unanswerable-read-as-answered inversion in reverse, and `scored-checks.ts`
     * exists to keep the two apart.
     */
    const notes: string[] = [];

    /**
     * The four questions, plus the one this file used to skip.
     *
     * `tally` rather than a hand-maintained `score += 20`, because the fifth
     * check can come back unanswered — a probe that timed out is not a dead link
     * — and a check that did not run has to leave the maximum as well as the
     * score.
     */
    const checks: Scorable[] = [];

    // 1. Title (# heading)
    const titleLine = fileLines.find((l) => /^#\s+\S/.test(l));
    checks.push({ points: 20, passed: Boolean(titleLine) });
    if (titleLine) {
      found.push(`Title: ${titleLine.replace(/^#\s+/, "").trim()}`);
    } else {
      issues.push("Missing title line (should start with '# Site Name')");
    }

    // 2. Description (> blockquote)
    const descLine = fileLines.find((l) => /^>\s+\S/.test(l));
    checks.push({ points: 20, passed: Boolean(descLine) });
    if (descLine) {
      found.push(`Description: ${descLine.replace(/^>\s+/, "").trim()}`);
    } else {
      issues.push("Missing description line (should start with '> Brief description')");
    }

    // 3. Content links.
    // One parse for both counts. Deriving the relative count by subtracting a
    // de-duplicated absolute count from a raw line count made a file that repeats
    // a URL report a relative link it does not have.
    const parsedLinks = parseLinks(content);
    const absoluteUrls = parsedLinks.absolute;
    const relativeLinks = parsedLinks.relative;

    if (absoluteUrls.length >= 3) {
      checks.push({ points: 20, passed: true });
      found.push(`Content links: ${absoluteUrls.length} absolute URLs declared`);
    } else if (absoluteUrls.length > 0) {
      checks.push({ points: 20, earned: 8 });
      issues.push(`Only ${absoluteUrls.length} absolute link(s) found — recommend at least 3`);
    } else {
      checks.push({ points: 20, passed: false });
      issues.push("No content links found — add links to your key pages with absolute URLs");
    }

    if (relativeLinks > 0) {
      issues.push(
        `${relativeLinks} relative URL(s) found — use absolute URLs (https://...) for AI parsers`,
      );
    }

    // 4. Do those links go anywhere?
    //
    // Counting links and reporting the count is an endorsement of a file whose
    // links may all 404, and llms.txt is a navigation index: an agent that
    // follows a dead link reads the dead end as the site's, not the URL's.
    const linkAudit =
      absoluteUrls.length > 0 ? await auditDeclaredLinks(absoluteUrls, origin) : null;
    let linkCoverage: string | null = null;
    const allBlockedByRobots =
      linkAudit !== null &&
      linkAudit.unreachable.length > 0 &&
      linkAudit.unreachable.every((probe) => probe.blockedByRobots === true);

    if (!linkAudit || linkAudit.probed === 0) {
      // Nothing declared to probe. Not a failure and not a pass: the check above
      // already reported that there are no links, and charging twice for one
      // absence is a double count.
      checks.push({ points: 20, status: "not-applicable" });
    } else {
      const answered = linkAudit.probed - linkAudit.unreachable.length;
      linkCoverage = coverageOf(linkAudit);

      if (answered === 0) {
        checks.push({ points: 20, status: "not-evaluated" });
        notes.push(
          notScored(
            `none of the ${linkAudit.probed} link(s) sampled could be reached on this run`,
            allBlockedByRobots
              ? "allow those paths in robots.txt if you want them measured — we do not fetch what you disallow"
              : "retry, or check that the URLs are reachable from outside your network",
          ),
        );
      } else {
        checks.push({ points: 20, earned: Math.round((20 * linkAudit.resolves) / answered) });
        if (linkAudit.broken.length === 0) {
          // The coverage sentence is printed once, beside the score. Repeating it
          // here read as two different facts about the same probe.
          found.push(
            `Links resolve: ${linkAudit.resolves}/${answered} sampled links reach real content`,
          );
        } else {
          issues.push(
            `${linkAudit.broken.length} of ${answered} sampled link(s) do not reach real content: ` +
              linkAudit.broken.map((probe) => `${probe.url} — ${probe.reason}`).join("; "),
          );
        }
        if (linkAudit.unreachable.length > 0) {
          notes.push(
            notScored(
              `${linkAudit.unreachable.length} sampled link(s) could not be reached on this run (${linkAudit.unreachable
                .map((probe) => `${probe.url}: ${probe.reason}`)
                .join("; ")})`,
              allBlockedByRobots
                ? "allow those paths in robots.txt if you want them measured"
                : "retry to find out",
            ),
          );
        }
        // The shell comparison needs the homepage. Without it every 200 looks
        // like real content, which is precisely the check this replaced — so the
        // reader is told the strongest half of the check did not run.
        if (!linkAudit.shellCheckRan && linkAudit.resolves > 0) {
          notes.push(
            notScored(
              "the homepage could not be read, so a link answering 200 with the app shell would not have been caught on this run",
              "retry to find out",
            ),
          );
        }
      }
    }

    // 5. Optional section
    const hasOptional = /^##\s+Optional/im.test(content);
    checks.push({ points: 20, passed: hasOptional });
    if (hasOptional) {
      found.push("Optional section: present (legal/privacy pages)");
    } else {
      issues.push("No '## Optional' section — consider adding privacy policy and terms links");
    }

    const totals = tally(checks);
    const score = totals.score;
    // The denominator moves when a check could not run, and it has to: scoring a
    // file out of 100 when we only asked 80 points' worth of questions is the
    // number that lies by omission.
    const max = totals.max;

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
    // The two states `tally` keeps apart have to stay apart here. A file with no
    // links takes `not-applicable` — structural, the same answer every run — and
    // telling that reader "a retry may change the score" blames our network for
    // their file. Only `notEvaluated` earns that sentence.
    if (totals.notEvaluated > 0) {
      lines.push(
        `Coverage: ${totals.notEvaluated} points could not be evaluated on this run and are excluded from both sides — a retry may change the score without the file changing.`,
      );
    }
    if (totals.notApplicable > 0) {
      lines.push(
        `Not applicable: ${totals.notApplicable} points do not apply to this file and are excluded from both sides — not a gap.`,
      );
    }
    if (linkCoverage) lines.push(`Links: ${linkCoverage}.`);

    // Graded against what could actually be asked, not against a fixed 100. A
    // file whose links we failed to reach is scored out of 80, and holding it to
    // the 100-point bands would cost it a grade for our network trouble.
    const percent = max === 0 ? 0 : (score / max) * 100;
    const grade =
      percent >= 90
        ? "Excellent"
        : percent >= 70
          ? "Good"
          : percent >= 40
            ? "Needs Improvement"
            : "Poor";

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
