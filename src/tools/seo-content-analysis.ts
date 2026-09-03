import { z } from "zod";
import { type ToolMetadata, type InferSchema } from "xmcp";
import { analyzeContent, type HeadingNode } from "../lib/analyzers/content-analyzer";
import { fetchHtml } from "../lib/http-client";
import { defineCachedTool } from "../lib/define-tool";
import { domainFromUrl, refreshable } from "../lib/with-cache";
import { toolError, toolText } from "../lib/tool-result";
import { toolFailure } from "../lib/tool-failure";

export const schema = {
  ...refreshable,
  url: z.string().url().describe("The URL to analyze for content quality"),
};

export const metadata: ToolMetadata = {
  name: "seo_content_analysis",
  description:
    "Measure a page's content: word and sentence counts, readability, heading " +
    "structure and outline, link mix, vocabulary, and the GEO signals answer " +
    "engines read — statistics, question-phrased headings, a summary section, " +
    "listicle formatting. Needs no credentials and no database. Returns an error " +
    "naming the status if the page cannot be read.",
  annotations: {
    title: "Analyze content quality",
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: true,
  },
};

/** Completes the sentence "Could not …" for every failure this Tool can return. */
const FAILURE_CONTEXT = "analyze the content of this URL";

/** How deep the rendered outline goes before it stops being an outline. */
const MAX_OUTLINE_DEPTH = 3;

// ── GEO signals ───────────────────────────────────────────────────────────────

type GeoSignals = {
  citationDensity: number;
  qaHeadings: number;
  hasSummarySection: boolean;
  hasListicle: boolean;
};

/**
 * The page's markup, for the GEO signals below.
 *
 * Goes through the shared fetcher rather than opening its own request: this
 * handler runs `analyzeContent(url)` and this in one `Promise.all`, and they were
 * two fetchers with two User-Agents, so one call fetched the same page twice.
 *
 * A failure here is `null`, not `""`. The rest of the analysis stands — the
 * content analyzer read the page — so the Tool does not fail; but zeros in the GEO
 * block are indistinguishable from a page carrying none of these signals, and
 * printing "Citation density: 0" about markup nobody read is the partial result
 * presented as a whole one that ADR-0003 exists to stop. `null` makes the section
 * say it did not run.
 */
async function fetchHtmlRaw(url: string): Promise<string | null> {
  try {
    return await fetchHtml(url);
  } catch {
    return null;
  }
}

function computeGeoSignals(html: string): GeoSignals {
  const bodyMatch = html.match(/<body[^>]*>([\s\S]*?)<\/body>/i)?.[1] ?? html;
  const textContent = bodyMatch
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  // Citation density: how often the copy states a figure an answer engine can quote.
  const statsPattern = /(\d+\.?\d*\s*%|\$\d[\d,]*|\d+\s+out\s+of\s+\d+|\d+x\s)/gi;
  const citationDensity = (textContent.match(statsPattern) ?? []).length;

  const qaHeadingPattern = /<h[2-3][^>]*>([^<]+)<\/h[2-3]>/gi;
  const questionWordRe = /^\s*(?:what|how|why|when|where|who|which|can|does|is|are|should|will)\b/i;
  const endsWithQuestionRe = /\?\s*$/;
  let qaHeadings = 0;
  let heading: RegExpExecArray | null;
  while ((heading = qaHeadingPattern.exec(html)) !== null) {
    const text = heading[1].replace(/<[^>]+>/g, "").trim();
    if (questionWordRe.test(text) || endsWithQuestionRe.test(text)) qaHeadings++;
  }

  const hasSummarySection =
    /(?:class|id)=["'][^"']*(?:tldr|summary|takeaway|overview)[^"']*["']/i.test(html);

  // A listicle is a numbered heading, an ordered list of at least three items, or
  // a table of at least three rows.
  const numberedHeadingRe =
    /<h[1-6][^>]*>[^<]*(?:\b\d+\s+(?:best|top|ways|tips|tools|reasons|steps|things|examples|ideas)\b|top\s+\d+\b)[^<]*<\/h[1-6]>/gi;
  const hasNumberedHeading = numberedHeadingRe.test(html);

  const olPattern = /<ol[^>]*>([\s\S]*?)<\/ol>/gi;
  let hasOlWithItems = false;
  let list: RegExpExecArray | null;
  while ((list = olPattern.exec(html)) !== null) {
    if ((list[1].match(/<li[^>]*>/gi) ?? []).length >= 3) {
      hasOlWithItems = true;
      break;
    }
  }

  const tablePattern = /<table[^>]*>([\s\S]*?)<\/table>/gi;
  let hasComparisonTable = false;
  let table: RegExpExecArray | null;
  while ((table = tablePattern.exec(html)) !== null) {
    if ((table[1].match(/<tr[^>]*>/gi) ?? []).length >= 3) {
      hasComparisonTable = true;
      break;
    }
  }

  return {
    citationDensity,
    qaHeadings,
    hasSummarySection,
    hasListicle: hasNumberedHeading || hasOlWithItems || hasComparisonTable,
  };
}

/** Render the outline tree, stopping at {@link MAX_OUTLINE_DEPTH}. */
function formatHeadingOutline(nodes: HeadingNode[], lines: string[], depth: number): void {
  if (depth >= MAX_OUTLINE_DEPTH) return;

  for (const node of nodes) {
    lines.push(`${"  ".repeat(depth)}H${node.level}: ${node.text}`);
    if (node.children.length > 0) formatHeadingOutline(node.children, lines, depth + 1);
  }
}

export default defineCachedTool(FAILURE_CONTEXT, { toolName: "seo_content_analysis", domainOf: domainFromUrl }, async ({ url }: InferSchema<typeof schema>) => {
  const [result, rawHtml] = await Promise.all([analyzeContent(url), fetchHtmlRaw(url)]);

  // The analyzer does not throw; it returns a failed Result. Routing that branch
  // through the same seam as a `catch` is the point of `tool-failure`.
  if (!result.success) {
    return toolFailure(result.error, FAILURE_CONTEXT);
  }

  const data = result.data;

  // ── A page with nothing in it is not a measurement ─────────────────────────
  //
  // No words and no headings of any level leaves this Tool nothing to analyze,
  // and reporting zeros for it is not a low score — it is a measurement we did
  // not take. The cause is usually that the copy is rendered by JavaScript and
  // the HTML we fetch is an empty shell; it has also been our own parser bug
  // deleting React's streamed containers. Either way the zeros must not be
  // reported as content, because "536 words, then 0" reads as content that was
  // deleted rather than as a page we failed to read.
  const noHeadings = Object.keys(data.headingStructure.counts).length === 0;
  if (data.wordCount === 0 && noHeadings) {
    // Written here rather than through `describeToolFailure`, and the distinction
    // is what that seam is for: it answers "the failure was unexpected" for causes
    // not visible from here. This cause is visible, explainable and actionable.
    return toolError(
      "Could not analyze the content of this URL: the page returned no text and no " +
        "headings, so there was nothing to measure. This usually means the content is " +
        "rendered by JavaScript and the raw HTML we fetch is an empty shell. " +
        "Server-side rendering or prerendering would make the text visible to us, and " +
        "to any crawler that does not run scripts.",
    );
  }

  const lines: string[] = [];

  lines.push("=== CONTENT METRICS ===");
  lines.push(`Word count: ${data.wordCount}`);
  lines.push(`Sentence count: ${data.sentenceCount}`);
  lines.push(`Paragraph count: ${data.paragraphCount}`);
  lines.push(`Avg words per sentence: ${data.avgWordsPerSentence.toFixed(1)}`);

  lines.push("\n=== READABILITY ===");
  lines.push(
    `Flesch Reading Ease: ${data.readability.fleschReadingEase} (${data.readability.interpretation})`,
  );
  lines.push(`Flesch-Kincaid Grade: ${data.readability.fleschKincaidGrade} (US grade level)`);

  lines.push("\n=== HEADING STRUCTURE ===");
  if (Object.keys(data.headingStructure.counts).length === 0) {
    lines.push("No headings found");
  } else {
    lines.push("Heading counts:");
    for (const [tag, count] of Object.entries(data.headingStructure.counts)) {
      lines.push(`  ${tag.toUpperCase()}: ${count}`);
    }

    if (data.headingStructure.hierarchy.length > 0) {
      lines.push("\nHierarchy issues:");
      for (const issue of data.headingStructure.hierarchy) {
        lines.push(`  - ${issue.message}`);
      }
    } else {
      lines.push("\nHierarchy: ✓ Valid");
    }

    if (data.headingStructure.outline.length > 0) {
      lines.push("\nContent outline:");
      formatHeadingOutline(data.headingStructure.outline, lines, 0);
    }
  }

  lines.push("\n=== LINK ANALYSIS ===");
  lines.push(`Total links: ${data.linkAnalysis.totalLinks}`);
  lines.push(`Internal links: ${data.linkAnalysis.internalLinks}`);
  lines.push(`External links: ${data.linkAnalysis.externalLinks}`);
  lines.push(`Nofollow links: ${data.linkAnalysis.nofollowLinks}`);
  lines.push(`Links per 1,000 words: ${data.linkAnalysis.linksPerThousandWords}`);

  lines.push("\n=== CONTENT QUALITY ===");
  lines.push(`Total words: ${data.contentQuality.totalWords}`);
  lines.push(`Unique words: ${data.contentQuality.uniqueWords}`);
  lines.push(`Lexical density: ${(data.contentQuality.lexicalDensity * 100).toFixed(1)}%`);

  lines.push("\n=== ISSUES & RECOMMENDATIONS ===");
  if (data.issues.length === 0) {
    lines.push("No major content issues detected.");
  } else {
    for (const issue of data.issues) {
      lines.push(`- ${issue}`);
    }
  }

  lines.push("\n=== OPTIMIZATION TIPS ===");
  // No length tip. Google: "the length of the content alone doesn't matter for
  // ranking purposes." That one survived the conformance pass in the retired
  // codebase only because it sat in a handler rather than in an analyzer.
  if (data.linkAnalysis.internalLinks < 3) {
    lines.push("- Add more internal links to related content on your site");
  }
  if (data.readability.fleschReadingEase < 60) {
    lines.push("- Simplify sentences to improve readability (aim for 60+ Flesch score)");
  }
  const h2Count = data.headingStructure.counts["h2"] ?? 0;
  if (h2Count < 3) {
    lines.push("- Add more H2 subheadings to break up content (improves scannability)");
  }
  if (data.contentQuality.lexicalDensity < 0.4) {
    lines.push("- Use more varied vocabulary to avoid repetition");
  }

  lines.push("\n=== GEO SIGNALS ===");
  if (rawHtml === null) {
    lines.push(
      "Not read on this run: the page's markup could not be fetched a second time, so " +
        "these four signals were not measured. Everything above was read from the page.",
    );
  } else {
    const geoSignals = computeGeoSignals(rawHtml);
    lines.push(`Citation density: ${geoSignals.citationDensity} statistical pattern(s) found`);
    lines.push(`Q&A headings: ${geoSignals.qaHeadings} question-phrased heading(s)`);
    lines.push(`Summary section: ${geoSignals.hasSummarySection ? "present" : "absent"}`);
    lines.push(`Listicle formatting: ${geoSignals.hasListicle ? "present" : "absent"}`);
  }

  return toolText(lines.join("\n"));
});
