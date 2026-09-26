import { readOptionalConfig } from "../lib/required-config";
import { z } from "zod";
import { type ToolMetadata, type InferSchema } from "xmcp";
import {
  describeCheck,
  KNOWLEDGE_GRAPH_POINTS,
  scoreGeo,
} from "../lib/analyzers/geo-analyzer";
import { readContentAge } from "../lib/analyzers/content-age";
import { publishingEntity } from "../lib/analyzers/publishing-entity";
import { readPage } from "../lib/analyzers/parsed-page";
import { checkTechnicalRequirements } from "../lib/analyzers/technical-requirements";
import { fetchAuditablePage, refusalText } from "../lib/page-reachability";
import { readWellKnown, textOrEmpty, type WellKnownRead } from "../lib/well-known";
import { findSitemaps, listingFor, readSitemaps, type SitemapListing } from "../lib/site-sitemap";
import { lookupKnowledgeGraph, type KnowledgeGraphMatch } from "../lib/knowledge-graph";
import { renderVerdict } from "../lib/render-check";
import { renderCoverage } from "../lib/render-scored-checks";
import { defineCachedTool } from "../lib/define-tool";
import { domainFromUrl, refreshable } from "../lib/with-cache";
import { toolError, toolText } from "../lib/tool-result";
import { hostKey } from "../lib/url-match";

export const schema = {
  ...refreshable,
  url: z
    .string()
    .url()
    .describe("The URL to analyze for GEO (Generative Engine Optimization) signals"),
};

export const metadata: ToolMetadata = {
  name: "seo_geo_score",
  description:
    "Score a page on the signals that correlate with being cited by AI answer " +
    "engines: structured data, freshness, content structure, AI crawler access, " +
    "authorship, technical health, citability and query coverage. A directional " +
    "reading of signals we can see, not a measurement of how any AI system behaves. " +
    "Needs no credentials and no database; one further check, whether Google holds a " +
    "Knowledge Graph entity for the brand, runs only where GOOGLE_KG_API_KEY is set " +
    "and is left out of the score entirely where it is not.",
  annotations: {
    title: "Score GEO signals",
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: true,
  },
};

/** Completes the sentence "Could not …" for every failure this Tool can return. */
const FAILURE_CONTEXT = "compute the GEO score for this URL";

/** The score is always reported out of this, whatever was applicable. */
const MAX_SCORE = 100;

/**
 * How many sitemap files the freshness check opens: an index and five of its
 * children, as when this Tool followed the index itself. Bounded because a large
 * site can list hundreds, and the freshness check is worth a few extra round
 * trips, not fifty. A page past the cap comes back "not all of them were
 * searched", never "not listed".
 */
const SITEMAP_FILES = 6;

/**
 * What the site's sitemaps say about this page.
 *
 * Through the one sitemap reader, so the sitemaps robots.txt declares are read
 * and `/sitemap.xml` is guessed at only when it declares none, an index is
 * followed into its children and gzip is inflated. The answer reaches the analyzer interpreted: listed or
 * not, with its `<lastmod>`, or "no sitemap", or why we do not know.
 */
async function sitemapListing(origin: string, pageUrl: string): Promise<SitemapListing> {
  const read = await readSitemaps(await findSitemaps(origin), { maxFiles: SITEMAP_FILES });
  return listingFor(read, pageUrl);
}

export default defineCachedTool(FAILURE_CONTEXT, { toolName: "seo_geo_score", domainOf: domainFromUrl }, async ({ url }: InferSchema<typeof schema>) => {
  const parsedUrl = new URL(url);
  const origin = parsedUrl.origin;

  // The Reachability Gate runs alone and first. Everything below reads the page,
  // so scoring before knowing the page exists produced a full report about a 404:
  // 24 findings, 23 of them consequences of there being no page.
  const page = await fetchAuditablePage(url);
  if (!page.ok) {
    return toolError(
      refusalText(
        "=== GEO SCORE ===",
        url,
        page,
        "No GEO checks were run. Every one of them measures the page's content,\n" +
          "so scoring an unreadable URL would describe an error page, not the site.",
      ),
    );
  }

  const html = page.html;
  // A Parsed Page, and this file still imports no cheerio: every field is lazy, so
  // it depends on `readPage` rather than on a parser, and the parse happens once
  // when something downstream actually needs the tree. ADR-0022 in the retired
  // repo; the reasoning travels with `parsed-page.ts`.
  const doc = readPage(url, html);
  const schemas = doc.schemas;
  // The brand is read above the lookup rather than below it. It used to be the
  // bare hostname, TLD and all, so the Knowledge Graph was searched for "bbva.es"
  // while the page's own `Organization.name` sat unparsed twenty lines down.
  const hostGuess = (hostKey(parsedUrl.hostname) ?? parsedUrl.hostname).split(".")[0];
  const publisher = publishingEntity(schemas, html);
  const brandName = publisher?.name ?? hostGuess;

  const [robotsResult, sitemapResult, kgResult, llmsTxtResult] = await Promise.allSettled([
    readWellKnown(origin, "/robots.txt"),
    sitemapListing(origin, url),
    lookupKnowledgeGraph(brandName),
    readWellKnown(origin, "/llms.txt", { method: "HEAD", timeout: 6_000 }),
  ]);

  const responseHeaders = page.headers;
  const httpStatus = page.status;
  // A rejection is "we did not find out", never "the answer is no". These helpers
  // absorb their own failures, so a rejection here means something unforeseen threw
  // — and mapping that to `""` or `false` is the outermost layer of the mistake
  // this whole shape exists to prevent.
  const unforeseen = (what: string): WellKnownRead => ({
    outcome: "unavailable",
    reason: `the ${what} read did not complete`,
    status: 0,
  });

  const robotsRead =
    robotsResult.status === "fulfilled" ? robotsResult.value : unforeseen("robots.txt");
  // The one foreseen rejection: the sitemap reader lets our own crawl budget
  // through rather than calling it a file the site failed to serve. Here it is a
  // read that did not complete, like any other.
  const sitemap: SitemapListing =
    sitemapResult.status === "fulfilled"
      ? sitemapResult.value
      : { outcome: "unread", reason: "the sitemap read did not complete" };
  // The record, not just `found`: the reason it carries is the difference between
  // "retry now" and "this deployment has no key".
  const kgLookup: KnowledgeGraphMatch =
    kgResult.status === "fulfilled"
      ? kgResult.value
      : { found: null, reason: "the Knowledge Graph lookup did not complete" };
  // llms.txt is the exception, and legitimately: its check is worth 0 points and
  // says so, so there is no score for a failed read to distort.
  const llmsTxtExists =
    llmsTxtResult.status === "fulfilled" && llmsTxtResult.value.outcome === "found";

  // One Page Identity for the whole run. Also covers localized homepages: a
  // classifier matching only a bare "/" scored /es and /index.html as generic
  // pages and marked them down for having no author or date.
  const pageType = doc.identity.kind;

  // Read once, next to the Page Kind it is composed with. Scores nothing: it
  // decides how loudly an age-sensitive finding is reported, not what the page
  // earned. See `content-age.ts`.
  const contentAge = readContentAge(schemas, html, pageType);

  // One call. This was ten `score*` calls, a mutation of a category built two
  // lines earlier, a ten-element array, three hand-written expressions for the
  // Knowledge Graph points and a `computeGeoScore` — twelve steps a handler had
  // to sequence correctly. Which categories exist and in what order is the
  // analyzer's decision, the way `scoreEeat` already had it.
  //
  // Checks that do not apply to this page kind, and checks we could not evaluate,
  // leave both the earned total and the achievable maximum, so the grade reflects
  // only what this page could actually be scored on.
  const {
    score,
    grade,
    earned,
    applicableMax,
    naPoints,
    unevaluatedPoints,
    categories,
    recommendations,
    knowledgeGraph,
  } = scoreGeo({
    page: doc,
    html,
    httpStatus,
    responseHeaders,
    robotsRead,
    sitemap,
    llmsTxtExists,
    knowledgeGraph: {
      lookup: kgLookup,
      keyConfigured: Boolean(readOptionalConfig("GOOGLE_KG_API_KEY")),
    },
  });

  // Google's three technical requirements, evaluated once and reported first. They
  // are prerequisites, not improvements: the GEO score still runs, because a 500
  // today does not make the analysis wrong, only premature — but a reader told
  // "GEO 62 / Moderate" who finds the blocker thirty checks down has been told the
  // wrong thing first.
  const requirements = checkTechnicalRequirements({
    httpStatus,
    // `textOrEmpty` here keeps the retired behaviour exactly, and that is a limit
    // on this port rather than an endorsement: `googlebotAllowed` reads an empty
    // string as "no robots.txt, so nothing is disallowed", which is right for a 404
    // and a claim we did not establish for a 5xx. It is a gate rather than a scored
    // check, so it neither moves a number nor blocks an audit.
    robotsTxt: textOrEmpty(robotsRead),
    page: doc,
    url,
    responseHeaders,
  });

  const lines: string[] = [];
  if (!requirements.met) {
    lines.push("=== BEFORE ANYTHING ELSE ===");
    lines.push(requirements.blocker!);
    for (const requirement of requirements.requirements) {
      lines.push(`  ${requirement.met ? "✓" : "✗"} ${requirement.label} — ${requirement.detail}`);
    }
    lines.push("");
  }

  lines.push("Note: GEO (Generative Engine Optimization) is an emerging concept without");
  lines.push("official scoring guidelines from Google, Bing, or other AI engines. This score");
  lines.push("is a heuristic based on observed factors that correlate with AI citation patterns.");
  lines.push("Treat as directional guidance, not a validated metric.\n");

  lines.push("=== GEO SCORE ===");
  lines.push(`Grade: ${grade}`);
  lines.push(`Score: ${score} / ${MAX_SCORE} (${score}%)`);
  lines.push(`Applicable: ${earned} / ${applicableMax} raw points earned`);
  // Both sentences come from `renderCoverage` now. They were written out here, and
  // in `ai-visibility-score`, and in `seo-llms-txt`, and by the two agent tiers via
  // the shared renderer — five surfaces, four wordings for two facts. The only
  // difference that carried meaning was the page type, which is the detail clause.
  lines.push(
    ...renderCoverage(
      { notApplicable: naPoints, notEvaluated: unevaluatedPoints },
      {
        subject: "this page",
        notApplicableDetail: `They were N/A for '${pageType}' pages, so this score is not comparable to a run on a different page type.`,
      },
    ),
  );
  lines.push(`Page Type: ${pageType}`);
  // Said out loud because it changes how the findings below should be read.
  lines.push(`Content Age: ${contentAge.tier} — ${contentAge.evidence}`);

  // `null` means no key configured, so there is no check to report. The points
  // come from the check rather than from a literal: `+5 pts` here was the fourth
  // place the number 5 was written.
  if (knowledgeGraph) {
    lines.push(
      `Knowledge Graph: ${
        knowledgeGraph.status === "not-evaluated"
          ? `? not run — ${knowledgeGraph.detail} (0 pts, excluded)`
          : knowledgeGraph.passed
            ? `✓ "${brandName}" found (+${KNOWLEDGE_GRAPH_POINTS} pts)`
            : `✗ "${brandName}" not found (0 pts)`
      }`,
    );
  }

  lines.push("\n=== CATEGORY BREAKDOWN ===");
  for (const category of categories) {
    lines.push(`\n${category.name}: ${category.score} / ${category.maxScore}`);
    for (const check of category.checks) {
      const { mark, words } = renderVerdict(check);
      lines.push(`  ${mark} ${describeCheck(check)} (${words ?? `${check.points} pts`})`);
      if (check.detail) lines.push(`     ${check.detail}`);
    }
  }

  lines.push("\n=== RECOMMENDATIONS ===");
  for (const recommendation of recommendations) {
    lines.push(recommendation);
  }

  return toolText(lines.join("\n"));
});
