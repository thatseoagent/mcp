/**
 * Content quality and readability analyzer.
 * Analyzes text content for readability scores, heading structure, link density, and quality signals.
 */

import { load, type CheerioAPI } from "cheerio";
import { fetchHtml, validateUrl } from "../http-client";
import {
  analyzeText,
  calculateFleschReadingEase,
  calculateFleschKincaidGrade,
  interpretFleschScore,
  calculateLexicalDensity,
} from "../text-analyzer";
import { type Result, success, failure } from "../type-guards";
import { readableDocument, type ReadableDocument } from "../visible-text";
import { annotate, HEADING_ACCESSIBILITY, type CheckSource } from "./check-source";

/**
 * Readability scoring is ours. Google publishes no target and has said plainly
 * that it does not measure writing this way; the score earns its place by being
 * useful to an author, not by being a ranking signal.
 */
const READABILITY_HEURISTIC: CheckSource = {
  kind: "heuristic",
  rationale:
    "Flesch scores are a writing aid, not a Google signal; Google asks for content that serves its audience",
};

export interface HeadingNode {
  level: number;
  text: string;
  children: HeadingNode[];
}

export interface HeadingHierarchyIssue {
  type: "skipped_level" | "multiple_h1" | "no_h1";
  message: string;
}

export interface ContentAnalysisResult {
  url: string;
  wordCount: number;
  sentenceCount: number;
  paragraphCount: number;
  avgWordsPerSentence: number;
  readability: {
    fleschReadingEase: number;
    fleschKincaidGrade: number;
    interpretation: string;
  };
  headingStructure: {
    hierarchy: HeadingHierarchyIssue[];
    outline: HeadingNode[];
    counts: Record<string, number>;
  };
  linkAnalysis: {
    internalLinks: number;
    externalLinks: number;
    nofollowLinks: number;
    totalLinks: number;
    linksPerThousandWords: number;
  };
  contentQuality: {
    uniqueWords: number;
    totalWords: number;
    lexicalDensity: number;
  };
  issues: string[];
}

/**
 * Analyze content quality and readability of a webpage.
 * Returns Result type for explicit error handling.
 */
export async function analyzeContent(
  url: string
): Promise<Result<ContentAnalysisResult>> {
  try {
    validateUrl(url);

  const html = await fetchHtml(url);
  const $ = load(html);
  const parsedUrl = new URL(url);

  // Semantic-container scoping used to dodge the inlined script payload only by
  // accident — a single inline script inside <main> put it back (issue #291).
  const readable = readableDocument($);
  const bodyText = readable.mainContent();
  const textAnalysis = analyzeText(bodyText);

  // Calculate readability
  const fleschReadingEase = calculateFleschReadingEase(bodyText);
  const fleschKincaidGrade = calculateFleschKincaidGrade(bodyText);

  // Analyze headings
  const headingStructure = analyzeHeadingStructure(readable);

  // Analyze links
  const linkAnalysis = analyzeLinkStructure($, parsedUrl);

  // Content quality metrics
  const lexicalDensity = calculateLexicalDensity(bodyText);
  const uniqueWords = Math.round(lexicalDensity * textAnalysis.wordCount);

  // Detect issues
  const issues = detectContentIssues({
    wordCount: textAnalysis.wordCount,
    headingStructure,
    linkAnalysis,
    readability: { fleschReadingEase, fleschKincaidGrade },
    lexicalDensity,
  });

  return success({
    url,
    wordCount: textAnalysis.wordCount,
    sentenceCount: textAnalysis.sentenceCount,
    paragraphCount: readable.paragraphs().length,
    avgWordsPerSentence: textAnalysis.avgWordsPerSentence,
    readability: {
      fleschReadingEase,
      fleschKincaidGrade,
      interpretation: interpretFleschScore(fleschReadingEase),
    },
    headingStructure,
    linkAnalysis: {
      ...linkAnalysis,
      linksPerThousandWords:
        textAnalysis.wordCount > 0
          ? Math.round((linkAnalysis.totalLinks / textAnalysis.wordCount) * 1000)
          : 0,
    },
    contentQuality: {
      uniqueWords,
      totalWords: textAnalysis.wordCount,
      lexicalDensity,
    },
    issues,
  });
  } catch (error) {
    const err = error instanceof Error ? error : new Error(String(error));
    return failure(err);
  }
}

/**
 * Analyze heading hierarchy and build outline tree.
 */
function analyzeHeadingStructure(readable: ReadableDocument): {
  hierarchy: HeadingHierarchyIssue[];
  outline: HeadingNode[];
  counts: Record<string, number>;
} {
  const hierarchy: HeadingHierarchyIssue[] = [];
  const headings: { level: number; text: string }[] = [];
  const counts: Record<string, number> = {};

  // Extract all headings
  for (const level of [1, 2, 3, 4, 5, 6]) {
    const tag = `h${level}`;
    for (const text of readable.texts(tag)) {
      headings.push({ level, text });
      counts[tag] = (counts[tag] || 0) + 1;
    }
  }

  // Check for H1 issues
  const h1Count = counts["h1"] || 0;
  if (h1Count === 0) {
    hierarchy.push({
      type: "no_h1",
      message: "Missing H1 heading",
    });
  } else if (h1Count > 1) {
    hierarchy.push({
      type: "multiple_h1",
      message: `Multiple H1 headings found (${h1Count})`,
    });
  }

  // Check for skipped levels
  let previousLevel = 0;
  for (const heading of headings) {
    if (previousLevel > 0 && heading.level > previousLevel + 1) {
      hierarchy.push({
        type: "skipped_level",
        message: `Skipped heading level: jumped from H${previousLevel} to H${heading.level}`,
      });
    }
    previousLevel = heading.level;
  }

  // Build outline tree
  const outline = buildHeadingTree(headings);

  return { hierarchy, outline, counts };
}

/**
 * Build a hierarchical tree structure from flat heading list.
 */
function buildHeadingTree(
  headings: { level: number; text: string }[]
): HeadingNode[] {
  const root: HeadingNode[] = [];
  const stack: HeadingNode[] = [];

  for (const heading of headings) {
    const node: HeadingNode = {
      level: heading.level,
      text: heading.text,
      children: [],
    };

    // Find parent (most recent heading with lower level)
    while (stack.length > 0 && stack[stack.length - 1].level >= heading.level) {
      stack.pop();
    }

    if (stack.length === 0) {
      root.push(node);
    } else {
      stack[stack.length - 1].children.push(node);
    }

    stack.push(node);
  }

  return root;
}

/**
 * Analyze link structure and density.
 */
function analyzeLinkStructure(
  $: CheerioAPI,
  parsedUrl: URL
): {
  internalLinks: number;
  externalLinks: number;
  nofollowLinks: number;
  totalLinks: number;
} {
  let internalLinks = 0;
  let externalLinks = 0;
  let nofollowLinks = 0;

  $("a[href]").each((_, el) => {
    const $el = $(el);
    const href = $el.attr("href");
    const rel = $el.attr("rel") || "";

    if (!href) return;

    // Check for nofollow
    if (rel.includes("nofollow")) {
      nofollowLinks++;
    }

    // Determine internal vs external
    try {
      const linkUrl = new URL(href, parsedUrl.href);
      if (linkUrl.hostname === parsedUrl.hostname) {
        internalLinks++;
      } else {
        externalLinks++;
      }
    } catch {
      // Relative URL or invalid - count as internal
      internalLinks++;
    }
  });

  return {
    internalLinks,
    externalLinks,
    nofollowLinks,
    totalLinks: internalLinks + externalLinks,
  };
}

/**
 * Detect content quality issues.
 */
function detectContentIssues(data: {
  wordCount: number;
  headingStructure: {
    hierarchy: HeadingHierarchyIssue[];
    outline: HeadingNode[];
    counts: Record<string, number>;
  };
  linkAnalysis: {
    internalLinks: number;
    externalLinks: number;
    totalLinks: number;
  };
  readability: {
    fleschReadingEase: number;
    fleschKincaidGrade: number;
  };
  lexicalDensity: number;
}): string[] {
  const issues: string[] = [];

  // No word-count floor. Google: "The length of the content alone doesn't matter
  // for ranking purposes." This file used to raise two findings from one number —
  // below 300 and below 600 — neither of which Google publishes, and both of
  // which fired on pages that were exactly as long as they needed to be. The
  // count remains in `metrics` where a reader can judge it in context.

  // Readability. Ours, and labelled as ours: Google says nothing about Flesch
  // scores. It is still useful to know a page reads at postgraduate level when
  // it is meant for a general audience.
  if (data.readability.fleschReadingEase < 30) {
    issues.push(
      annotate(
        `Very difficult to read (Flesch score: ${data.readability.fleschReadingEase}). Consider simplifying sentences.`,
        READABILITY_HEURISTIC
      )
    );
  } else if (data.readability.fleschKincaidGrade > 12) {
    issues.push(
      annotate(
        `High reading grade level (${data.readability.fleschKincaidGrade}). May be too complex for general audience.`,
        READABILITY_HEURISTIC
      )
    );
  }

  // Heading hierarchy. A missing H1 is a page with no stated subject. Order and
  // count are accessibility findings, and carry that label so nobody reads them
  // as Google's rules.
  for (const issue of data.headingStructure.hierarchy) {
    issues.push(
      issue.type === "no_h1"
        ? issue.message
        : annotate(issue.message, HEADING_ACCESSIBILITY)
    );
  }

  // Link density. Google does ask that pages be reachable by crawlable links, so
  // a page with no outgoing links at all is worth naming.
  if (data.linkAnalysis.totalLinks === 0) {
    issues.push("No links found (internal linking helps Google discover other pages)");
  } else if (data.linkAnalysis.internalLinks === 0) {
    issues.push("No internal links found (add internal links to improve site structure)");
  }

  // Lexical density (vocabulary richness)
  if (data.lexicalDensity < 0.3) {
    issues.push(
      annotate(
        `Low vocabulary diversity (${Math.round(data.lexicalDensity * 100)}% unique words). Content may be repetitive.`,
        {
          kind: "heuristic",
          rationale:
            "repetition can indicate keyword stuffing, which Google's spam policies do cover, but the ratio itself is our measure",
        }
      )
    );
  }

  return issues;
}

// ── Section types (co-located with the module that produces them) ──────────────

export type ContentSection = {
  metrics: {
    wordCount: number;
    sentenceCount: number;
    paragraphCount: number;
    avgWordsPerSentence: number;
  };
  readability: {
    fleschReadingEase: number;
    fleschKincaidGrade: number;
    label: string;
  };
  headings: {
    h1: number;
    h2: number;
    h3: number;
    h4: number;
    hierarchyValid: boolean;
  };
  links: {
    total: number;
    internal: number;
    external: number;
    nofollow: number;
    perThousandWords: number;
  };
  quality: { uniqueWords: number; lexicalDensity: number };
  issues: string[];
  tips: string[];
  geoSignals: {
    citationDensity: number;
    qaHeadings: number;
    hasSummarySection: boolean;
    hasListicle: boolean;
  };
};
