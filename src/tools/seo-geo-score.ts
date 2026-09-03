import { readOptionalConfig } from "../lib/required-config";
import { z } from "zod";
import { type ToolMetadata, type InferSchema } from "xmcp";
import {
  scoreStructuredData,
  scoreFreshness,
  scoreContentStructure,
  scoreAiCrawlerAccess,
  scoreAuthorEeat,
  scoreTechnical,
  scoreContentCitability,
  scoreCitationSignals,
  scoreFreshnessSignals,
  scoreQueryOptimization,
  buildRecommendations,
  applyListicleCheck,
  computeGeoScore,
  describeCheck,
  type GeoCategory,
} from "../lib/analyzers/geo-analyzer";
import { readContentAge } from "../lib/analyzers/content-age";
import { notScored } from "../lib/analyzers/scored-checks";
import { publishingEntity } from "../lib/analyzers/publishing-entity";
import { readPage } from "../lib/analyzers/parsed-page";
import { getSchemaTypes } from "../lib/analyzers/json-ld-graph";
import { checkTechnicalRequirements } from "../lib/analyzers/technical-requirements";
import { fetchAuditablePage, refusalText } from "../lib/page-reachability";
import { readWellKnown, answered, textOrEmpty, type WellKnownRead } from "../lib/well-known";
import { lookupKnowledgeGraph, type KnowledgeGraphMatch } from "../lib/knowledge-graph";
import { renderVerdict } from "../lib/render-check";
import { renderCoverage } from "../lib/render-scored-checks";
import { defineCachedTool } from "../lib/define-tool";
import { domainFromUrl, refreshable } from "../lib/with-cache";
import { toolError, toolText } from "../lib/tool-result";

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
 * How many child sitemaps an index is followed into. Bounded because a large site
 * can list hundreds, and the freshness check is worth one extra round trip, not
 * fifty.
 */
const MAX_CHILD_SITEMAPS = 5;

/**
 * The sitemap XML that actually contains `pageUrl`.
 *
 * `/sitemap.xml` is frequently a `<sitemapindex>` rather than a list of pages, and
 * the per-URL `<lastmod>` values live in the children. Reading the index directly
 * yields the index's own dates, which belong to the child sitemaps and not to any
 * page. Follows the index far enough to find the page and returns that child's XML;
 * falls back to whatever was fetched when there is no index or no match, so the
 * caller can still tell "not listed" from "no sitemap at all".
 */
async function fetchSitemapContaining(origin: string, pageUrl: string): Promise<WellKnownRead> {
  const root = await readWellKnown(origin, "/sitemap.xml");
  // `absent` and `unavailable` both travel out untouched: the caller has to be able
  // to say "there is no sitemap" separately from "we could not read one".
  if (root.outcome !== "found" || !root.text.includes("<sitemapindex")) return root;

  const allChildLocs = [
    ...root.text.matchAll(/<sitemap\b[\s\S]*?<loc>\s*([\s\S]*?)\s*<\/loc>/gi),
  ].map((match) => match[1]);
  const childLocs = allChildLocs.slice(0, MAX_CHILD_SITEMAPS);

  // The URL parse is guarded and counted rather than left to throw out of the
  // `.map`, where it escaped this function entirely.
  const children = await Promise.allSettled(
    childLocs.map(async (loc) => {
      const child = new URL(loc);
      return readWellKnown(child.origin, child.pathname + child.search);
    }),
  );

  const bodies: string[] = [];
  // Every child we did not get to read, for any reason: a rejection, a 5xx, a
  // timeout, a malformed `<loc>`. `absent` is not one of them — a child sitemap
  // that 404s is an answer, and it says the page is not in that one.
  let unread = children.filter((child) => child.status === "rejected").length;
  for (const child of children) {
    if (child.status !== "fulfilled") continue;
    // `answered()` before `textOrEmpty`, which is the rule `well-known.ts` states
    // in as many words: an `unavailable` child yields `""`, and an empty string is
    // indistinguishable from a child that listed nothing.
    if (!answered(child.value)) {
      unread++;
      continue;
    }
    const text = textOrEmpty(child.value);
    if (text) bodies.push(text);
  }
  // A truncated index is the same kind of ignorance as a child that would not load:
  // there are sitemaps we did not look in.
  const truncated = childLocs.length < allChildLocs.length;

  // A positive is conclusive. If the page is listed in a child we actually read,
  // nothing we failed to read can change that — the same asymmetry
  // `site-trust-pages` is built on.
  const containing = bodies.find((body) => body.includes(pageUrl));
  if (containing) return { outcome: "found", text: containing, status: root.status };

  // A negative is not. Saying "not listed" here means asserting the page is absent
  // from sitemaps we never opened, and downstream that is a scored failure worth 5
  // points.
  if (unread > 0 || truncated) {
    return {
      outcome: "unavailable",
      reason: truncated
        ? `the sitemap index lists more than ${MAX_CHILD_SITEMAPS} sitemaps, so not all of them were searched`
        : `${unread} of the ${childLocs.length} sitemaps in the index could not be read`,
      status: root.status,
    };
  }

  // Every child read, none contains the page. Now "not listed" is a finding. The
  // concatenation still travels so a `<lastmod>` lookup has something to search;
  // falling back to the index when the children are all empty is deliberate, since
  // its dates belong to the children.
  return {
    outcome: "found",
    text: bodies.length ? bodies.join("\n") : root.text,
    status: root.status,
  };
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
  const hostGuess = parsedUrl.hostname.replace(/^www\./, "").split(".")[0];
  const publisher = publishingEntity(schemas, html);
  const brandName = publisher?.name ?? hostGuess;

  const [robotsResult, sitemapResult, kgResult, llmsTxtResult] = await Promise.allSettled([
    readWellKnown(origin, "/robots.txt"),
    fetchSitemapContaining(origin, url),
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
  const sitemapRead =
    sitemapResult.status === "fulfilled" ? sitemapResult.value : unforeseen("sitemap");
  // The record, not just `found`: the reason it carries is the difference between
  // "retry now" and "this deployment has no key".
  const kgLookup: KnowledgeGraphMatch =
    kgResult.status === "fulfilled"
      ? kgResult.value
      : { found: null, reason: "the Knowledge Graph lookup did not complete" };
  const inKg = kgLookup.found;
  // llms.txt is the exception, and legitimately: its check is worth 0 points and
  // says so, so there is no score for a failed read to distort.
  const llmsTxtExists =
    llmsTxtResult.status === "fulfilled" && llmsTxtResult.value.outcome === "found";

  const schemaTypes = getSchemaTypes(schemas);
  // One Page Identity for the whole run. Also covers localized homepages: a
  // classifier matching only a bare "/" scored /es and /index.html as generic
  // pages and marked them down for having no author or date.
  const identity = doc.identity;
  const pageType = identity.kind;

  // Read once, next to the Page Kind it is composed with. Scores nothing: it
  // decides how loudly an age-sensitive finding is reported, not what the page
  // earned. See `content-age.ts`.
  const contentAge = readContentAge(schemas, html, pageType);

  const structuredData = scoreStructuredData(schemas, schemaTypes, pageType);
  const freshness = scoreFreshness(schemas, sitemapRead, pageType, url);
  const contentStructure = scoreContentStructure(html);
  const aiAccess = scoreAiCrawlerAccess(robotsRead, html, llmsTxtExists);
  const authorEeat = scoreAuthorEeat(html, schemas, pageType);
  const technical = scoreTechnical(html, httpStatus);
  const citability = scoreContentCitability(html, pageType);
  const citationSignals = scoreCitationSignals(html, pageType);
  const freshnessSignals = scoreFreshnessSignals(html, responseHeaders, pageType);
  const queryOptimization = scoreQueryOptimization(html, schemas, pageType);
  // The listicle check belongs to content structure and is applied to it.
  applyListicleCheck(contentStructure, html, pageType);

  const categories: GeoCategory[] = [
    structuredData,
    freshness,
    contentStructure,
    aiAccess,
    authorEeat,
    technical,
    citability,
    citationSignals,
    freshnessSignals,
    queryOptimization,
  ];

  // Checks that do not apply to this page kind, and checks we could not evaluate,
  // leave both the earned total and the achievable maximum — so the grade reflects
  // only what this page could actually be scored on.
  const kgEnabled = Boolean(readOptionalConfig("GOOGLE_KG_API_KEY"));
  const { score, grade, earned, applicableMax, naPoints, unevaluatedPoints } = computeGeoScore(
    categories,
    {
      // Three cases, not two. No key configured is our deployment and not the
      // site's business, so the check is not asked at all and its ceiling is 0. A
      // key but no answer is transitory, so the 5 points leave both sides and are
      // reported as unevaluated rather than scored as a miss: telling a brand with
      // a Knowledge Panel to strengthen its entity signals because the API 503'd is
      // exactly the failure to avoid.
      kgApplicable: kgEnabled && inKg !== null ? 5 : 0,
      kgEarned: inKg === true ? 5 : 0,
      kgUnevaluated: kgEnabled && inKg === null ? 5 : 0,
    },
  );

  const recommendations = buildRecommendations(categories);

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

  if (kgEnabled) {
    lines.push(
      `Knowledge Graph: ${
        inKg === null
          ? `? not run — ${notScored(
              kgLookup.reason ?? "the Knowledge Graph API did not answer on this run",
            )} (0 pts, excluded)`
          : inKg
            ? `✓ "${brandName}" found (+5 pts)`
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
