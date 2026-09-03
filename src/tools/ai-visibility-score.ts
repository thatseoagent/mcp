/**
 * AI Visibility Score — The Stack (4 layers, 3 mechanisms)
 *
 * Based on the AI Visibility Framework (88+ sources, direct platform testing):
 *   L1: Entity Establishment — does AI resolve you as a real entity? (scored, 40 pts)
 *   L2: Entity Depth       — what does AI know about you from training? (informational)
 *   L3: Category Citation  — does AI recommend you for category queries? (manual guide)
 *   L4: Informational Citation — does AI cite your content as a source? (scored, 58 pts)
 *
 * L2 is informational: training data is opaque, so we surface proxy signals only.
 * L3 generates the editorial sources to go and get listed on.
 *
 * The scoring is pure and lives in `lib/analyzers/ai-visibility-analyzer`. This
 * file does the I/O and renders.
 */
import { z } from "zod";
import { type ToolMetadata, type InferSchema } from "xmcp";
import {
  scoreL1,
  scoreL4,
  analyzeL2,
  buildTopActions,
  checkContentFreshness,
  toGrade,
  detectVertical,
  buildL3Guide,
  type EntityLookup,
} from "../lib/analyzers/ai-visibility-analyzer";
import { qualifier, type CheckSource } from "../lib/analyzers/check-source";
import { parseRobots } from "../lib/analyzers/robots-ruleset";
import { publishingEntity } from "../lib/analyzers/publishing-entity";
import { readPage } from "../lib/analyzers/parsed-page";
import { fetchAuditablePage, refusalText } from "../lib/page-reachability";
import { readWellKnown, answered, textOrEmpty } from "../lib/well-known";
import { lookupWikidata } from "../lib/wikidata-check";
import { lookupKnowledgeGraph } from "../lib/knowledge-graph";
import { resolveTrustPages, showsTrustPage } from "../lib/site-trust-pages";
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
    .describe("URL to analyze for AI visibility signals (The Stack: L1, L2, L3, L4)"),
};

export const metadata: ToolMetadata = {
  name: "ai_visibility_score",
  description:
    "Score how findable a site is to AI answer engines across four layers: whether " +
    "it resolves as an entity (Wikidata, Knowledge Graph, schema), what a model " +
    "would know about it, which editorial sources cover its category, and whether " +
    "its content is structured to be cited. A directional reading of signals we can " +
    "see, not a measurement of how any AI system behaves. Needs no credentials.",
  annotations: {
    title: "Score AI visibility",
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: true,
  },
};

/** Completes the sentence "Could not …" for every failure this Tool can return. */
const FAILURE_CONTEXT = "score AI visibility for this URL";

/** The AI crawlers whose access this Tool reports on. */
const AI_CRAWLERS = ["GPTBot", "PerplexityBot", "ClaudeBot", "Google-Extended"];

/**
 * The whole record, not just `found`.
 *
 * Narrowing this to a bare `boolean | null` throws the reason away, so the
 * analyzer prints a generic "could not be reached on this run" where the lookup
 * had "Wikidata search API returned HTTP 503" — the one detail that tells a reader
 * whether to retry now or later.
 */
async function checkWikidata(brandName: string, language: string | null): Promise<EntityLookup> {
  const { found, reason } = await lookupWikidata(brandName, language);
  return { found, reason };
}

async function checkLlmsTxt(baseUrl: string): Promise<boolean> {
  return (await readWellKnown(baseUrl, "/llms.txt")).outcome === "found";
}

/**
 * `unavailable` carries its reason, and is not the same as `ok` with nothing
 * blocked. See `ScoreStatus` in `scored-checks.ts` for why the word "unknown" is
 * deliberately not reused.
 */
type AiBotAccessResult =
  | { status: "ok" | "blocked"; blocked: string[] }
  | { status: "unavailable"; blocked: string[]; reason: string };

/**
 * Which AI crawlers this site shuts out.
 *
 * Through `parseRobots`, which knows what a robots.txt group is. A blank-line
 * record parser is not: a file with no blank line between its blocks collapses
 * into one record, so an `Allow: /` for `*` cancels a `Disallow: /` for GPTBot and
 * nothing is reported as blocked. It also matches agent names case-insensitively,
 * where a hand-rolled reader missed `User-agent: gptbot`.
 */
async function checkAiBotAccess(baseUrl: string): Promise<AiBotAccessResult> {
  const read = await readWellKnown(baseUrl, "/robots.txt");
  if (!answered(read)) {
    return {
      status: "unavailable",
      blocked: [],
      reason: read.outcome === "unavailable" ? read.reason : "",
    };
  }

  // `absent` yields an empty string and `parseRobots` yields no rules, so every bot
  // comes back allowed — the correct answer, reached for the correct reason rather
  // than by an HTML error page happening to parse to nothing.
  const ruleset = parseRobots(textOrEmpty(read));
  const blocked = AI_CRAWLERS.filter((bot) => ruleset.blocksEntirely(bot));

  return { blocked, status: blocked.length === 0 ? "ok" : "blocked" };
}

/**
 * A check as the reader should see it: the finding, then whose it is.
 *
 * Marks nothing when the source is Google's, because Google's rules are the
 * baseline the report exists to deliver — see `check-source.ts`.
 */
function describe(check: { name: string; source?: CheckSource }): string {
  const attribution = check.source ? qualifier(check.source) : undefined;
  return attribution ? `${check.name} — ${attribution}` : check.name;
}

export default defineCachedTool(FAILURE_CONTEXT, { toolName: "ai_visibility_score", domainOf: domainFromUrl }, async ({ url }: InferSchema<typeof schema>) => {
  const parsedUrl = new URL(url);
  const hostname = parsedUrl.hostname.replace(/^www\./, "");
  const hostGuess = hostname.split(".")[0];
  const displayBrand = hostGuess.charAt(0).toUpperCase() + hostGuess.slice(1);

  // The Reachability Gate first: every L1–L4 check below reads the page, so an
  // unreadable URL would be scored as a site with no entity signals rather than as
  // a URL that does not exist.
  const page = await fetchAuditablePage(url);
  if (!page.ok) {
    return toolError(
      refusalText(
        "=== AI VISIBILITY SCORE ===",
        url,
        page,
        "No L1–L4 check was run. Every one of them reads the page, so an unreadable\n" +
          "URL would be scored as a site with no entity signals rather than as a URL\n" +
          "that does not exist.",
      ),
    );
  }

  const html = page.html;
  // One read for the whole run. This used to parse for the trust-page check while
  // `identifyPage`, `analyzeL2` and `scoreL4` each parsed again: four reads of one
  // document.
  const doc = readPage(url, html);
  const schemas = doc.schemas;

  // The brand the PAGE declares, before either lookup fires. It used to be computed
  // further down and used only for a header, so both external searches went out
  // carrying the hostname's first label — "Bbva" for bbva.es — and then reported
  // "no Wikidata entity" about a brand that has one.
  //
  // The hostname guess stays at this call site deliberately: it is not a name the
  // page declares, and `publishingEntity` returning it would leave its `source`
  // unable to tell a declaration from an assumption of ours.
  const entity = publishingEntity(schemas, html);
  const orgBrandName = entity?.name ?? displayBrand;

  // Wikidata searches one language at a time, and asked in English only an item
  // that exists in Spanish is invisible. The page says which language to ask in.
  const language = doc.language;

  const [wikidataResult, kgResult, llmsTxtResult, aiBotResult] = await Promise.allSettled([
    checkWikidata(orgBrandName, language),
    lookupKnowledgeGraph(orgBrandName),
    checkLlmsTxt(url),
    checkAiBotAccess(url),
  ]);

  // A rejected settlement is `null`, never `false`. These four helpers already
  // absorb their own failures, so a rejection here means something unforeseen threw
  // — which is still "we did not find out".
  const unforeseen = (what: string): EntityLookup => ({
    found: null,
    reason: `the ${what} lookup did not complete`,
  });
  const wikidataFound: EntityLookup =
    wikidataResult.status === "fulfilled" ? wikidataResult.value : unforeseen("Wikidata");
  const kgFound: EntityLookup =
    kgResult.status === "fulfilled" ? kgResult.value : unforeseen("Knowledge Graph");
  // llms.txt is the exception, and legitimately: the check is worth 0 points and
  // says so, so there is no score for its absence to distort.
  const llmsTxtPresent = llmsTxtResult.status === "fulfilled" ? llmsTxtResult.value : false;
  const aiBotAccess: AiBotAccessResult =
    aiBotResult.status === "fulfilled"
      ? aiBotResult.value
      : { status: "unavailable", blocked: [], reason: "the robots.txt check did not complete" };

  const vertical = detectVertical(html, schemas);
  const freshness = checkContentFreshness(html, schemas);
  // Derived here rather than inside `scoreL4`, so the analyzer stays pure and the
  // identity is established once.
  const pageKind = doc.identity.kind;

  // The about signal asks about the site, not this page. Resolved here because the
  // answer can cost a request and the analyzer is pure.
  const trustPages = await resolveTrustPages(url, { about: showsTrustPage(doc, "about") });

  const l1 = scoreL1(schemas, html, wikidataFound, kgFound, vertical, llmsTxtPresent);
  const l2 = analyzeL2(doc, schemas, trustPages.about);
  const l3 = buildL3Guide(vertical);
  const l4 = scoreL4(doc, aiBotAccess, freshness, pageKind);

  const totalScore = l1.score + l4.score;
  // Derived, not a fixed 100. With unevaluated checks leaving both sides of the
  // fraction, a fixed denominator charges the site for every lookup that did not
  // answer.
  const totalMax = l1.max + l4.max;
  const notEvaluated = l1.notEvaluated + l4.notEvaluated;
  const notApplicable = l1.notApplicable + l4.notApplicable;
  const grade = toGrade(totalScore, totalMax);
  const l1Grade = toGrade(l1.score, l1.max);
  const l4Grade = toGrade(l4.score, l4.max);
  const topActions = buildTopActions(l1, l4, l2, vertical);

  const lines: string[] = [];
  lines.push("Note: AI Visibility scoring is a heuristic based on observed correlation data");
  lines.push("from 88+ research sources and direct platform testing (ChatGPT/Gemini/Perplexity).");
  lines.push("Treat as directional guidance, not a validated metric.\n");

  lines.push("=== AI VISIBILITY SCORE — The Stack ===");
  lines.push(`Score: ${totalScore}/${totalMax} — ${grade}`);
  // Said out loud, because it is the one qualifier that makes this run
  // incomparable to the last one: nothing about the site changed, we just failed to
  // look. A score that hides it is a number that lies by omission. The sentence
  // itself comes from `renderCoverage`, which is where every scored surface's
  // version of it lives now.
  lines.push(...renderCoverage({ notApplicable, notEvaluated }, { subject: "this page" }));
  lines.push(
    `Vertical: ${vertical}  |  Brand: ${orgBrandName}` +
      `${entity ? "" : " (assumed from the domain — the page declares no Organization or Person)"}\n`,
  );

  lines.push(`── L1 Entity Establishment: ${l1.score}/${l1.max} (${l1Grade}) ──`);
  lines.push("Does AI resolve you as a real entity? (knowledge graph layer)");
  for (const check of l1.checks) {
    const { mark, words } = renderVerdict(check);
    lines.push(`  ${mark} ${describe(check)} (${words ?? `${check.points}pts`})`);
    if (!check.passed || check.status) lines.push(`     → ${check.detail}`);
  }

  lines.push("\n── L2 Entity Depth: Informational ──");
  lines.push(
    "What does AI know about you from training? (no automated score — training data is opaque)",
  );
  for (const signal of l2.signals) {
    lines.push(`  ${signal.found ? "✓" : "✗"} ${describe(signal)}`);
    if (!signal.found) lines.push(`     → ${signal.detail}`);
  }
  lines.push(`  Summary: ${l2.summary}`);

  lines.push("\n── L3 Category Citation: Manual Check Required ──");
  lines.push(`  Vertical: ${vertical}`);
  lines.push("  Key editorial sources AI retrieves for this vertical:");
  lines.push(`    ${l3.editorialSources.join(" | ")}`);
  lines.push(
    "  Get listed on these sources. Third-party editorial placements are the only " +
      "lever at this layer.",
  );

  lines.push(`\n── L4 Informational Citation: ${l4.score}/${l4.max} (${l4Grade}) ──`);
  lines.push("Does AI cite your content as a source? (content structure layer)");
  for (const check of l4.checks) {
    const { mark, words } = renderVerdict(check);
    lines.push(`  ${mark} ${describe(check)} (${words ?? `${check.points}pts`})`);
    if (!check.passed || check.status) lines.push(`     → ${check.detail}`);
  }

  lines.push("\n=== TOP ACTIONS (prioritized by layer impact) ===");
  topActions.forEach((action, index) => lines.push(`${index + 1}. ${action}`));

  return toolText(lines.join("\n"));
});
