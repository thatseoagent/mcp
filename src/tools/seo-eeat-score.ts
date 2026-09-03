import { z } from "zod";
import { type ToolMetadata, type InferSchema } from "xmcp";
import {
  scoreEeat,
  type EeatCategoryScore,
  type EeatIndicator,
} from "../lib/analyzers/eeat-analyzer";
import { readPage } from "../lib/analyzers/parsed-page";
import { fetchHtml, validateUrl } from "../lib/http-client";
import { resolveTrustPages, showsTrustPage } from "../lib/site-trust-pages";
import { renderVerdict } from "../lib/render-check";
import { renderCoverage } from "../lib/render-scored-checks";
import { defineCachedTool } from "../lib/define-tool";
import { domainFromUrl, refreshable } from "../lib/with-cache";
import { toolText } from "../lib/tool-result";

export const schema = {
  ...refreshable,
  url: z.string().url().describe("The URL to analyze for E-E-A-T signals"),
};

export const metadata: ToolMetadata = {
  name: "seo_eeat_score",
  description:
    "Score a page against the on-page signals of Experience, Expertise, " +
    "Authoritativeness and Trustworthiness: authorship, credentials, dates, " +
    "citations, and whether the site publishes privacy, about and contact pages. " +
    "A directional checklist of what is visible in HTML, not a rating of what " +
    "Google sees. Needs no credentials and no database.",
  annotations: {
    title: "Score E-E-A-T signals",
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: true,
  },
};

/** Completes the sentence "Could not …" for every failure this Tool can return. */
const FAILURE_CONTEXT = "score E-E-A-T for this URL";

/**
 * One line per indicator, with the third state told apart from a failure.
 *
 * A not-applicable indicator used to render `✗ Author bio / credentials (0/10 pts)`
 * on a product page, which reads as a defect the reader should go and fix. It is
 * not: the page owes nothing there, so it shows `–` and `n/a`, and the detail says
 * which page kind and why.
 *
 * `passed: found` is only the tiebreak for a 0-point informational indicator.
 * `renderVerdict` takes the mark from `earned` against `points`, because `found`
 * and `earned` disagree on every partial-credit indicator here and the cross won.
 */
function renderIndicator(indicator: EeatIndicator): string {
  const { mark, words } = renderVerdict({
    status: indicator.status,
    passed: indicator.found,
    earned: indicator.earned,
    points: indicator.points,
  });
  return `${mark} ${indicator.signal} (${words ?? `${indicator.earned}/${indicator.points} pts`})`;
}

/** A scored category, rendered with its indicators and their details. */
function renderCategory(lines: string[], heading: string, category: EeatCategoryScore): void {
  lines.push(`\n${heading}: ${category.score} / ${category.maxScore}`);
  for (const indicator of category.indicators) {
    lines.push(`  ${renderIndicator(indicator)}`);
    if (indicator.details) lines.push(`     ${indicator.details}`);
  }
}

export default defineCachedTool(FAILURE_CONTEXT, { toolName: "seo_eeat_score", domainOf: domainFromUrl }, async ({ url }: InferSchema<typeof schema>) => {
  // The I/O lives here, which is what a Tool is for. It used to sit inside the
  // analyzer, so an Analyzer — pure, stateless and network-free by CONTEXT.md —
  // fetched twice: the page, and then the site home for the trust-page questions.
  validateUrl(url);
  const html = await fetchHtml(url);

  // One read of the document, shared by the trust-page check here and every
  // scorer inside `scoreEeat`.
  const page = readPage(url, html);

  // A link on this page settles it; only its absence sends us to the home. See
  // `site-trust-pages.ts` for why the evidence is asymmetric.
  const trustPages = await resolveTrustPages(url, {
    privacy: showsTrustPage(page, "privacy"),
    about: showsTrustPage(page, "about"),
    contact: showsTrustPage(page, "contact"),
  });

  const data = scoreEeat({ page, trustPages });
  const lines: string[] = [];

  lines.push("Note: This score uses on-page signals as proxies for E-E-A-T. Google's actual");
  lines.push("E-E-A-T evaluation involves many factors not visible in HTML (domain authority,");
  lines.push("author reputation, external mentions, content accuracy). Use as a directional");
  lines.push("checklist, not a definitive rating.\n");

  lines.push("=== E-E-A-T SCORE ===");
  lines.push(`Grade: ${data.grade}`);
  lines.push(`Score: ${data.score} / ${data.maxScore} (${Math.round(data.percentage)}%)`);
  // The denominator here moves. Three trustworthiness indicators ask a question
  // about the SITE, and a home page that 5xx'd takes 15 of the 100 points out of
  // both sides — so this line used to read `Score: 61 / 85 (72%)` with nothing
  // saying where the other 15 went, and a reader comparing two runs could not
  // tell a page that improved from a run that asked fewer questions. ADR-0003.
  lines.push(...renderCoverage(data, { subject: "this page" }));

  lines.push("\n=== CATEGORY BREAKDOWN ===");
  renderCategory(lines, "EXPERIENCE", data.signals.experience);
  renderCategory(lines, "EXPERTISE", data.signals.expertise);
  renderCategory(lines, "AUTHORITATIVENESS", data.signals.authoritativeness);
  renderCategory(lines, "TRUSTWORTHINESS", data.signals.trustworthiness);

  lines.push("\n=== RECOMMENDATIONS ===");
  for (const recommendation of data.recommendations) {
    lines.push(recommendation);
  }

  return toolText(lines.join("\n"));
});
