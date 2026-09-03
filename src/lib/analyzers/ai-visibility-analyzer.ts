/**
 * AI Visibility Analyzer — pure scoring functions extracted from ai-visibility-tools.ts.
 *
 * All functions here are pure (no I/O). They accept already-fetched data and
 * return deterministic results, making them straightforward to unit-test.
 */

import { readOptionalConfig } from "../required-config";
import { hasLocalizedLink } from "../localized-page-detection";
import type { TrustPageFinding } from "../site-trust-pages";
import { tally, notScored, type Scorable } from "./scored-checks";
import { findNodeInAll } from "./json-ld-graph";
import { isUndatedPage, type PageKind } from "./page-identity";
import type { ParsedPage } from "./parsed-page";
import { patternsFor, SUPPORTED_LANGUAGES } from "./answer-patterns";
import { RESEARCH, CITABILITY_HEURISTIC, FRESHNESS_HEURISTIC, ROBOTS_FACT, STATIC_HTML_HEURISTIC, type CheckSource } from "./check-source";

// ── Section types (co-located with the module that produces them) ──────────────

/**
 * A **Scorable** under this file's field names: `name` where the shared type
 * says `label`, and `detail` required rather than optional. `points` is the
 * ceiling and `earned` the partial award, exactly as the shared type defines
 * them — the two were previously kept in step by hand, in sixteen places.
 */
/**
  * Extends `Scorable`, which is what lets a check here say it could not be
  * evaluated. Before #337 this type declared its own `points`/`earned`/`passed`
  * and had no way to express "did not run" at all — `status: "not-evaluated"` was
  * a compile error, and the only outcomes available to a check whose input made
  * the question unanswerable were a false pass or an unearned penalty.
  */
export interface AiVisibilityCheck extends Scorable {
  name: string;
  /**
   * Where this check gets its authority. See `check-source.ts`.
   *
   * Internal to the analyzer: `ai-visibility-tools` maps it to a `provenance`
   * string before the section is stored. A `research` source carries a study name
   * and sometimes a finding sentence, and persisting all of that on 21 checks of
   * every audit would put the audit trail in the database instead of a qualifier.
   */
  source?: CheckSource;
  /** Required here, unlike on `Scorable`: every check in this module has an answer. */
  passed: boolean;
  /** Required here: the renderer prints it for every check. */
  detail: string;
}

export type AiVisibilityL2Signal = {
  name: string;
  found: boolean;
  detail: string;
  source?: CheckSource;
};

/**
 * A check as it is stored and read back, with the source resolved to the one
 * string a reader needs.
 *
 * Declared rather than left implicit. `forStorage()` in `ai-visibility-tools`
 * produces this shape, and without a name for it the `provenance` field was
 * written into every stored audit while appearing in no type — so nothing reading
 * a Site Context could see that the attribution was there.
 */
export type StoredAiVisibilityCheck = Omit<AiVisibilityCheck, "source"> & {
  /** Whose finding this is, absent when it is Google's. */
  provenance?: string;
};

export type StoredAiVisibilityL2Signal = Omit<AiVisibilityL2Signal, "source"> & {
  provenance?: string;
};

/**
 * L2 as this module produces it, before storage resolves the sources.
 *
 * Separate from `AiVisibilitySection["l2"]` because the two genuinely differ now:
 * the analyzer hands back `source` objects and the section carries the resolved
 * string. `analyzeL2` used to be typed as the section shape, which was true while
 * they were the same object and became a lie the moment they were not.
 */
export type AiVisibilityL2 = {
  signals: AiVisibilityL2Signal[];
  summary: string;
};

export type AiVisibilitySection = {
  score: number;
  /**
   * The points this page could actually have earned.
   *
   * Derived from `l1.max + l4.max`, never stated. It was a literal 100 in two places
   * — `toGrade(totalScore, 100)` and the report's "N of 100" — while the checks
   * totalled 91, or 96 with a Knowledge Graph key. So a flawless site read 91/100,
   * every band was ~9% stricter than it looked, and the reachable maximum moved with
   * our deployment configuration while the printed denominator did not (#338).
   *
   * It matters more now than it did: a check that could not be evaluated leaves both
   * sides of the fraction, so against a fixed 100 a Wikidata timeout would cost the
   * site a grade band for our network trouble.
   *
   * Optional because audits written before this exist and are still valid; readers
   * fall back to 100, which is what those rows were scored against.
   */
  maxScore?: number;
  grade: "Strong" | "Moderate" | "Weak" | "Not Established";
  vertical: string;
  l1: {
    score: number;
    max: number;
    grade: string;
    checks: StoredAiVisibilityCheck[];
  };
  l2: {
    signals: StoredAiVisibilityL2Signal[];
    summary: string;
  };
  l3: {
    vertical: string;
    editorialSources: string[];
  };
  l4: {
    score: number;
    max: number;
    grade: string;
    checks: StoredAiVisibilityCheck[];
  };
  topActions: string[];
};

// ── Types ──────────────────────────────────────────────────────────────────────

export type Vertical = "saas" | "local" | "healthcare" | "finance" | "agency" | "ecommerce" | "legal" | "education" | "generic";

// ── Private helpers ────────────────────────────────────────────────────────────


function extractOutboundLinks(html: string): string[] {
  // Limit to first 80KB to keep parsing fast on large pages
  const chunk = html.slice(0, 80_000);
  const links: string[] = [];
  const re = /href=["'](https?:\/\/[^"']{4,200})["']/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(chunk)) !== null) links.push(m[1]);
  return links;
}

/**
 * Heuristic proxy for "named-entity density" — the share of mid-sentence
 * capitalized tokens (a stand-in for specific tools/brands/people/places).
 * The first token of each sentence is skipped so ordinary sentence-initial
 * capitalization isn't counted. This is a rough proxy, not NLP NER: cited text
 * runs ~20.6% entity density vs ~5–8% in normal prose (K. Indig / Gauge).
 */
export function entityDensity(cleanText: string): number {
  const sentences = cleanText.split(/[.!?]+/);
  let proper = 0;
  let total = 0;
  for (const s of sentences) {
    const toks = s.trim().split(/\s+/).filter(Boolean);
    total += toks.length;
    for (let i = 1; i < toks.length; i++) {
      // Unicode, not ASCII: `Ángel`, `México` and `Öhlins` are proper nouns, and
      // `/^[A-Z][a-zA-Z]/` did not think so (#342).
      if (/^\p{Lu}\p{L}/u.test(toks[i])) proper++;
    }
  }
  return total > 0 ? proper / total : 0;
}

const KNOWN_DIRECTORIES = [
  "crunchbase.com", "linkedin.com", "g2.com", "capterra.com", "getapp.com",
  "clutch.co", "trustpilot.com", "yelp.com", "tripadvisor.com", "healthgrades.com",
  "zocdoc.com", "goodfirms.co", "producthunt.com", "bbb.org", "yellowpages.com",
  "avvo.com", "martindale.com", "findlaw.com", "nerdwallet.com", "bankrate.com",
  "upcity.com", "softwareadvice.com", "f6s.com", "angel.co", "glassdoor.com",
];

const VERTICAL_PRIORITY_DIRS: Record<Vertical, string[]> = {
  saas:       ["g2.com", "capterra.com", "producthunt.com", "getapp.com", "softwareadvice.com"],
  local:      ["yelp.com", "tripadvisor.com", "bbb.org", "yellowpages.com", "google.com/maps"],
  healthcare: ["healthgrades.com", "zocdoc.com", "vitals.com", "ratemds.com", "webmd.com"],
  finance:    ["nerdwallet.com", "bankrate.com", "trustpilot.com", "investopedia.com"],
  agency:     ["clutch.co", "goodfirms.co", "g2.com", "upcity.com", "designrush.com"],
  ecommerce:  ["trustpilot.com", "bbb.org", "google.com/shopping", "shopper.com"],
  legal:      ["avvo.com", "martindale.com", "findlaw.com", "justia.com", "lawyers.com"],
  education:  ["coursera.org", "g2.com", "trustpilot.com", "classcentral.com"],
  generic:    ["crunchbase.com", "trustpilot.com", "bbb.org", "linkedin.com"],
};

function detectDirectoryPresence(html: string, sameAsUrls: string[]): string[] {
  const allLinks = [...sameAsUrls, ...extractOutboundLinks(html)].map((u) => u.toLowerCase());
  return KNOWN_DIRECTORIES.filter((dir) => allLinks.some((u) => u.includes(dir)));
}

// ── Exported pure functions ────────────────────────────────────────────────────

export function detectVertical(html: string, schemas: readonly unknown[]): Vertical {
  const text = html.slice(0, 40_000).toLowerCase();
  const schemaTypes = schemas
    .map((s) => String((s as Record<string, unknown>)?.["@type"] ?? ""))
    .join(" ")
    .toLowerCase();

  if (/localbusiness|restaurant|hotel|cafe|salon|barbershop|plumber|electrician|dentist/i.test(schemaTypes)) return "local";
  if (/medicalorganization|physician|hospital|medicalclinic/i.test(schemaTypes)) return "healthcare";
  if (/softwareapplication|webapplication|mobileapplication|webapi/i.test(schemaTypes)) return "saas";
  if (/legalservice|attorney|lawfirm/i.test(schemaTypes)) return "legal";

  // Keyword sets cover English + Spanish so localized sites aren't all bucketed as
  // "generic" (#287). Order matters: more specific verticals are checked first.
  if (/\b(attorney|lawyer|law firm|legal services|practice areas|litigation|abogado|abogados|bufete|despacho de abogados|servicios legales|litigio)\b/.test(text)) return "legal";
  if (/\b(doctor|clinic|medical center|healthcare|patient portal|telehealth|appointment booking|medico|médico|clinica|clínica|centro medico|centro médico|telemedicina|paciente|cita medica|cita médica)\b/.test(text)) return "healthcare";
  // Finance keywords must be unambiguous: bare "portfolio" (of sites/projects/design)
  // and "invest" ("invest in your team…") are too generic and mis-fire on SaaS/agency
  // copy (#287). Require the finance-specific senses instead.
  if (/\b(mortgage|insurance|loan|financial advisor|wealth management|brokerage|investment portfolio|portfolio management|mutual fund|retirement account|stock trading|hipoteca|seguros|prestamo|préstamo|asesor financiero|gestion de patrimonio|gestión de patrimonio|corretaje|fondo de inversion|fondo de inversión|cartera de inversion|cartera de inversión)\b/.test(text)) return "finance";
  if (/\b(marketing agency|seo agency|design agency|creative agency|web agency|digital agency|we help brands|agencia de marketing|agencia seo|agencia de diseño|agencia de diseno|agencia creativa|agencia digital|agencia web|agencia de publicidad|ayudamos a marcas)\b/.test(text)) return "agency";
  if (/\b(add to cart|checkout|free shipping|shop now|product page|our store|buy online|agregar al carrito|añadir al carrito|anadir al carrito|carrito de compra|finalizar compra|envio gratis|envío gratis|comprar ahora|nuestra tienda|comprar en linea|comprar en línea|comprar online|tienda online)\b/.test(text)) return "ecommerce";
  if (/\b(enroll|curriculum|certification|online course|learning platform|student portal|instructor|inscribete|inscríbete|matricula|matrícula|plan de estudios|certificacion|certificación|curso online|curso en linea|curso en línea|plataforma de aprendizaje|portal del estudiante|profesor)\b/.test(text)) return "education";
  if (/\b(near me|serving [a-z]|open hours|get directions|call us today|local business|cerca de mi|cerca de ti|horario de apertura|como llegar|cómo llegar|llamanos hoy|llámanos|negocio local)\b/.test(text)) return "local";
  if (/\b(software|saas|platform|dashboard|free trial|api docs|integration|pricing per seat|plataforma|prueba gratis|prueba gratuita|panel de control|integracion|integración|documentacion de api|documentación de api|precio por usuario)\b/.test(text)) return "saas";

  return "generic";
}

export function checkContentFreshness(
  html: string,
  schemas: readonly unknown[],
  now: number = Date.now(),
): "fresh" | "aging" | "stale" | "unknown" {
  // Try JSON-LD dateModified / datePublished
  for (const s of schemas) {
    const rec = s as Record<string, unknown>;
    const dateStr = rec.dateModified ?? rec.datePublished;
    if (typeof dateStr === "string") {
      const date = new Date(dateStr);
      if (!isNaN(date.getTime())) {
        const daysAgo = (now - date.getTime()) / 86_400_000;
        return daysAgo <= 60 ? "fresh" : daysAgo <= 180 ? "aging" : "stale";
      }
    }
  }

  // Try meta tags: article:modified_time or last-modified
  const metaRe = /<meta[^>]+(?:property=["']article:modified_time["']|name=["'](?:last-modified|revised)["'])[^>]*>/gi;
  let m: RegExpExecArray | null;
  while ((m = metaRe.exec(html)) !== null) {
    const contentM = m[0].match(/content=["']([^"']+)["']/i);
    if (contentM) {
      const date = new Date(contentM[1]);
      if (!isNaN(date.getTime())) {
        const daysAgo = (now - date.getTime()) / 86_400_000;
        return daysAgo <= 60 ? "fresh" : daysAgo <= 180 ? "aging" : "stale";
      }
    }
  }

  return "unknown";
}

export function toGrade(score: number, max: number): AiVisibilitySection["grade"] {
  const pct = max > 0 ? score / max : 0;
  if (pct >= 0.85) return "Strong";
  if (pct >= 0.60) return "Moderate";
  if (pct >= 0.35) return "Weak";
  return "Not Established";
}

/**
 * `wikidataFound` and `kgFound` are three-state on purpose.
 *
 * `null` means the lookup did not complete — the API returned 5xx, timed out, or was
 * never reached. That is not evidence the brand has no entity, and scoring it as
 * though it were charged the site 6 and 5 points for our own network trouble (#337).
 */
/**
 * What a third-party entity lookup came back with, and why if it came back with
 * nothing.
 *
 * Structural on purpose, so `WikidataMatch` in `lib/tools/shared` satisfies it
 * without either module importing the other and without an analyzer depending on
 * a tool. `reason` used to be dropped at the seam: `checkWikidata` narrowed the
 * record to a bare `boolean | null`, so this file printed a generic sentence
 * where the lookup had the specific one — "Wikidata search API returned HTTP
 * 503" became "Wikidata could not be reached on this run".
 */
export interface EntityLookup {
  found: boolean | null;
  reason?: string;
}

export function scoreL1(
  schemas: readonly unknown[],
  html: string,
  wikidata: EntityLookup,
  kg: EntityLookup,
  vertical: Vertical,
  llmsTxtPresent: boolean,
): { score: number; max: number; notApplicable: number; notEvaluated: number; checks: AiVisibilityCheck[] } {
  const { found: wikidataFound, reason: wikidataReason } = wikidata;
  const { found: kgFound, reason: kgReason } = kg;
  const checks: AiVisibilityCheck[] = [];

  // 1. Organization/LocalBusiness schema with name + url (7 pts)
  // `findNodeInAll` rather than a private matcher, and this is not a tidy-up:
  // the private one only looked at top-level array elements, so an Organization
  // inside `@graph` — the shape Yoast, RankMath and every WordPress SEO plugin
  // emits — was invisible to it, and this 7-point check failed on those sites for
  // markup they had. The shared walk flattens `@graph` and skips bare `@id`
  // references (ADR-0016).
  const orgSchema = findNodeInAll(schemas, ["Organization", "LocalBusiness", "Corporation", "NGO"]);
  const hasOrgName = !!(orgSchema?.name);
  const hasOrgUrl = !!(orgSchema?.url);
  const orgComplete = hasOrgName && hasOrgUrl;
  checks.push({
    name: "Organization schema with name + url", source: CITABILITY_HEURISTIC,
    passed: orgComplete,
    points: 7,
    detail: orgSchema
      ? orgComplete
        ? `"${orgSchema.name}" — schema complete`
        : `Schema present but missing: ${[!hasOrgName && "name", !hasOrgUrl && "url"].filter(Boolean).join(", ")}`
      : "No Organization/LocalBusiness schema found — add one with name, url, and logo",
  });

  // 2. sameAs with 2+ identity platform URLs (7 pts)
  const sameAsRaw = orgSchema?.sameAs;
  const sameAsUrls: string[] = Array.isArray(sameAsRaw)
    ? sameAsRaw.map(String)
    : sameAsRaw ? [String(sameAsRaw)] : [];
  const identityDomains = ["linkedin.com", "wikipedia.org", "wikidata.org", "twitter.com", "x.com", "facebook.com", "instagram.com", "crunchbase.com", "angel.co"];
  const identityUrls = sameAsUrls.filter((u) => identityDomains.some((d) => u.toLowerCase().includes(d)));
  const hasSameAs = identityUrls.length >= 2;
  checks.push({
    name: "Organization schema with 2 or more identity links", source: CITABILITY_HEURISTIC,
    passed: hasSameAs,
    points: 7,
    detail: sameAsUrls.length > 0
      ? `${identityUrls.length} identity link${identityUrls.length === 1 ? "" : "s"} found, 2 or more needed: ${identityUrls.slice(0, 3).join(", ")}`
      : "No identity links in the Organization schema. Add LinkedIn, Wikipedia, Crunchbase and your social profiles as sameAs entries",
  });

  // 3. Key directory presence for this vertical (7 pts)
  //
  // The evidence is asymmetric, the same way #340's trust pages are. A page linking
  // its G2 profile is weak but real evidence the profile exists. A page NOT linking
  // one is evidence of nothing at all: we measured outbound links from one document
  // and the claim is about a listing on someone else's site. The old check called
  // both halves an answer, so a brand genuinely listed on G2 that does not link to it
  // failed for 7 points (#341).
  //
  // So a hit scores, and a miss leaves both sides of the fraction. It cannot be
  // settled from a page fetch, and pretending otherwise is what this reads as.
  const foundDirs = detectDirectoryPresence(html, sameAsUrls);
  const priorityDirs = VERTICAL_PRIORITY_DIRS[vertical];
  const foundPriority = foundDirs.filter((d) => priorityDirs.some((p) => d.includes(p)));
  const hasDirectories = foundPriority.length >= 1 || foundDirs.length >= 2;
  checks.push({
    name: `Links to ${vertical} vertical directories`, source: RESEARCH.localListings,
    passed: hasDirectories,
    points: 7,
    status: hasDirectories ? undefined : "not-evaluated",
    detail: hasDirectories
      ? `Detected: ${foundDirs.slice(0, 4).join(", ")}`
      : notScored(
          `no links to ${priorityDirs.slice(0, 3).join(", ")} on this page, and a listing lives on someone else's site so it cannot be read from here`,
          "confirm by hand; listings drive ~42% of AI citations for location queries (Yext, 6.8M citations)",
        ),
  });

  // 4. Wikidata entity (6 pts)
  checks.push({
    name: "Wikidata entity found", source: CITABILITY_HEURISTIC,
    passed: wikidataFound === true,
    points: 6,
    // Out of the score rather than failing it. Telling a brand that already has a
    // Wikidata item to go and create one, because Wikidata was down for eight
    // seconds, is worse than saying nothing.
    status: wikidataFound === null ? "not-evaluated" : undefined,
    detail: wikidataFound === null
      ? notScored(wikidataReason ?? "Wikidata could not be reached on this run")
      : wikidataFound
      ? "Brand entity found in Wikidata — primary knowledge graph for AI entity resolution"
      : "No Wikidata entry — submit at wikidata.org/wiki/Wikidata:WikiProject_Stub_creation",
  });

  // 5. Entity name consistency (6 pts)
  const ogSiteName = html.match(/<meta[^>]+property=["']og:site_name["'][^>]*content=["']([^"']+)["']/i)?.[1]
    ?? html.match(/<meta[^>]+content=["']([^"']+)["'][^>]*property=["']og:site_name["']/i)?.[1]
    ?? null;
  const orgName = typeof orgSchema?.name === "string" ? orgSchema.name : null;
  const candidates = [ogSiteName, orgName].filter(Boolean) as string[];
  // A consistency check needs two things to compare, and with fewer than two it has
  // no answer of either kind. Both of the old branches were wrong in opposite
  // directions: zero sources printed "Could not compare" and then docked all 6
  // points, and one source set `nameConsistent = true` and awarded all 6 for a
  // comparison that never happened (#337, #341). The missing markup is still worth
  // saying — it is in the detail — but it is a finding about the page, not a score
  // for a question this page could not answer.
  let nameConsistent = false;
  let nameDetail: string;
  if (candidates.length >= 2) {
    const [a, b] = candidates.map((n) => n.toLowerCase().replace(/[^a-z0-9]/g, ""));
    nameConsistent = a === b || a.includes(b) || b.includes(a);
    nameDetail = nameConsistent
      ? `Consistent across og:site_name and schema: "${candidates[0]}"`
      : `Mismatch: og:site_name="${ogSiteName}" ≠ schema="${orgName}" — use one canonical brand name`;
  } else if (candidates.length === 1) {
    nameDetail = `Only one source of the brand name ("${candidates[0]}"), so there was nothing to compare it against — add the other of og:site_name and Organization.name`;
  } else {
    nameDetail = "Neither og:site_name nor Organization.name is present, so there was nothing to compare — add both";
  }
  checks.push({
    name: "Entity name consistent across og:site_name and Organization schema", source: CITABILITY_HEURISTIC,
    passed: nameConsistent,
    points: 6,
    status: candidates.length >= 2 ? undefined : "not-evaluated",
    detail: nameDetail,
  });

  // 6. llms.txt — reported, not scored.
  //
  // This was worth 7 points on the claim that it "signals AI-ready
  // infrastructure". No engine has published anything of the sort, and Google
  // has published the opposite: its generative-AI guide lists llms.txt among the
  // things Google Search does not use, helping and harming nothing.
  //
  // Zero points rather than deletion: a site that has one should still see it
  // acknowledged, and told the truth about it.
  checks.push({
    name: "llms.txt file present (informational — no engine has confirmed using it)", source: ROBOTS_FACT,
    passed: true,
    points: 0,
    detail: llmsTxtPresent
      ? "llms.txt found. Google Search does not read it and no other engine has confirmed it does. Harmless to keep, but it earns nothing."
      : "No llms.txt. Google Search does not use it, so its absence costs nothing.",
  });

  // 7. Google Knowledge Graph bonus (5 pts, only if API key configured)
  if (readOptionalConfig("GOOGLE_KG_API_KEY")) {
    checks.push({
      name: "Google Knowledge Graph entity confirmed", source: CITABILITY_HEURISTIC,
      passed: kgFound === true,
      points: 5,
      status: kgFound === null ? "not-evaluated" : undefined,
      detail: kgFound === null
        ? notScored(kgReason ?? "the Knowledge Graph API did not answer on this run")
        : kgFound
        ? "Brand entity confirmed in Google Knowledge Graph"
        : "Not found in Google Knowledge Graph — strengthen entity signals to earn a Knowledge Panel",
    });
  }

  // Derived, never declared. This was a hand-written `const MAX = 40`, and when
  // the llms.txt check dropped from 7 points to 0 the constant stayed — so a
  // flawless site could reach 33 out of a stated 40 and `toGrade` quietly marked
  // everybody down. A total that is computed cannot drift from its parts.
  //
  // It also makes the Knowledge Graph check honest: that one only runs when an
  // API key is configured, and a fixed maximum charged every site for a check it
  // was never given.
  return { ...totals(checks), checks };
}

/**
 * Both totals from the one list, under this file's field name for the ceiling.
 *
 * `max` rather than the shared type's name because `AiVisibilitySection` has
 * always called it that and every stored audit row uses it.
 */
function totals(checks: AiVisibilityCheck[]): {
  score: number;
  max: number;
  notApplicable: number;
  notEvaluated: number;
} {
  const { score, max, notApplicable, notEvaluated } = tally(checks);
  // Both coverage figures are carried out of the layer, not swallowed. `notEvaluated`
  // is the one that makes this run incomparable to the last one; `notApplicable` was
  // being dropped here, so a check that a page kind cannot owe left the fraction and
  // the caller had no way to name the points it had lost.
  return { score, max, notApplicable, notEvaluated };
}

export function analyzeL2(
  page: ParsedPage,
  schemas: readonly unknown[],
  /**
   * Whether the SITE publishes an about page, settled by the caller.
   *
   * Passed in rather than read from `html` because this analyzer is pure and the
   * answer can need a second request. Same shape of mistake as the E-E-A-T
   * indicators in #340: told a site with a full about page to "create one with brand
   * narrative" whenever the analyzed page's template did not link it.
   */
  aboutOnSite: TrustPageFinding,
): AiVisibilityL2 {
  // The page/press detectors read anchors and visible text, not the HTML string:
  // a phrase in an `aria-label` or a URL inside a script used to count as a link.
  const { $, html } = page;
  const visibleText = page.readable.allText();
  const signals: AiVisibilityL2Signal[] = [];

  // Author/Person schema with sameAs
  const personSchema = findNodeInAll(schemas, ["Person"]);
  const hasPerson = !!(personSchema?.sameAs);
  signals.push({
    name: "Author schema (Person) with profile links", source: CITABILITY_HEURISTIC,
    found: hasPerson,
    detail: hasPerson
      ? "Person schema with sameAs found — author authority feeds AI training layer"
      : "No Person schema with sameAs — add author profiles linking to LinkedIn/Wikipedia to strengthen author authority signals",
  });

  // Press / newsroom page — multilingual slug/text (e.g. /prensa, /sala-de-prensa)
  const hasPressPage = hasLocalizedLink($, visibleText, "press");
  signals.push({
    name: "Press/newsroom page exists", source: CITABILITY_HEURISTIC,
    found: hasPressPage,
    detail: hasPressPage
      ? "Press section detected — aggregates earned media that feeds AI training data"
      : "No press page found — create /press or /newsroom to surface earned media coverage",
  });

  // Outbound links to authoritative domains
  const authDomains = [
    ".edu", ".gov", "wikipedia.org", "reuters.com", "apnews.com",
    "bbc.com", "nytimes.com", "techcrunch.com", "forbes.com", "wsj.com",
    "bloomberg.com", "theguardian.com", "economist.com",
  ];
  const outboundLinks = extractOutboundLinks(html);
  const authLinks = outboundLinks.filter((u) => authDomains.some((d) => u.includes(d)));
  const hasAuthLinks = authLinks.length >= 2;
  signals.push({
    name: "2+ outbound links to authoritative sources", source: RESEARCH.geoTactics,
    found: hasAuthLinks,
    detail: hasAuthLinks
      ? `${authLinks.length} authoritative outbound links detected`
      : `${authLinks.length} authoritative links found — cite credible sources (.edu, .gov, major press) to signal authority to AI`,
  });

  // About/team page — a question about the site, so the answer comes from the caller.
  // An L2 signal is narrative and unscored, which is exactly why the wrong answer was
  // cheap to leave in place and expensive to read: it is advice, and telling someone
  // to write a page they already have is worse than saying nothing.
  const hasAbout = aboutOnSite.answer === "present";
  signals.push({
    name: "About or team page exists", source: CITABILITY_HEURISTIC,
    found: hasAbout,
    detail:
      aboutOnSite.answer === "unknown"
        ? `Not checked: ${aboutOnSite.reason}`
        : !hasAbout
        ? "No about/team page detected — create one with brand narrative, founding story, and team bios"
        : aboutOnSite.where === "page"
        ? "About page found — helps AI build entity depth about your organization"
        : "About page found on the site home, though this page does not link it — helps AI build entity depth, but link it from here too",
  });

  const foundCount = signals.filter((s) => s.found).length;
  const summary =
    foundCount === 4 ? "Strong brand depth signals — AI can describe you confidently from memory" :
    foundCount >= 2 ? "Moderate brand depth — some gaps in training data footprint" :
    "Weak brand depth — AI likely lacks confidence describing your brand without searching";

  return { signals, summary };
}

export function scoreL4(
  page: ParsedPage,
  aiBotAccess:
    | { status: "ok" | "blocked"; blocked: string[] }
    | { status: "unavailable"; blocked: string[]; reason: string },
  freshness: "fresh" | "aging" | "stale" | "unknown",
  pageKind: PageKind,
): { score: number; max: number; notApplicable: number; notEvaluated: number; wordCount: number; checks: AiVisibilityCheck[] } {
  const { html } = page;
  const checks: AiVisibilityCheck[] = [];

  const bodyMatch = html.match(/<body[^>]*>([\s\S]*?)<\/body>/i)?.[1] ?? html;
  const cleanText = bodyMatch
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  const words = cleanText.split(/\s+/).filter((w) => w.length > 0);
  const wordCount = words.length;
  const cutoff = Math.ceil(wordCount * 0.30);
  const firstThirtyPct = words.slice(0, cutoff).join(" ");

  // Which phrasings to look for, decided by the language the page declares (#342).
  // A single English regex drove the two checks below, so a correct Spanish page
  // could not pass either — and there is no way to explain that to a customer who
  // bought this product in Spanish.
  const choice = patternsFor(page.language);
  const languageUnreadable = choice.outcome === "unsupported";
  const patterns = languageUnreadable ? null : choice.patterns;
  // Said once, appended to both checks, because both fail for the identical reason
  // and a reader comparing them should not have to notice they match.
  const unreadableDetail = languageUnreadable
    ? notScored(
        `this page declares ${choice.languageName}, and the phrasings we look for are only written for ${SUPPORTED_LANGUAGES.join(" and ")}`,
        "your page may well do this, we cannot read it yet",
      )
    : "";
  const foundIn = (text: string) =>
    patterns !== null && (patterns.definition.test(text) || patterns.statistic.test(text));

  // 1. Key answer / data point in first 30% of text (10 pts)
  const hasEarlyKeyContent = foundIn(firstThirtyPct) && firstThirtyPct.length > 80;
  checks.push({
    name: "Key answer or data point in first 30% of text", source: RESEARCH.citationPosition,
    passed: hasEarlyKeyContent,
    points: 10,
    status: languageUnreadable ? "not-evaluated" : undefined,
    detail: languageUnreadable
      ? unreadableDetail
      : hasEarlyKeyContent
      ? "Page leads with definitions or data — 44.2% of AI citations come from the first 30% of content"
      : "No definition or data point in first 30% — front-load your key value prop or a statistic for maximum AI citation probability",
  });

  // 2. Content length 800–1500 words (8 pts)
  //
  // The studies measured grounding *coverage* against page length: roughly 50% at
  // ~800 words, ~13% at ~4000. This check reports where a page sits on that curve.
  // It used to call the range an "AI grounding sweet spot", which is a rule about
  // how long a page should be — a claim neither study makes, and the same phrasing
  // `docs/google-search-central-conformance.md` §1.11 struck from the GEO
  // analyzer. §1.1 records that Google has no word-count rule either.
  const inRange = wordCount >= 800 && wordCount <= 1500;
  checks.push({
    name: "Content length 800–1500 words (measured grounding-coverage range)",
    source: RESEARCH.groundingBudget,
    passed: inRange,
    points: 8,
    detail: wordCount < 800
      ? `${wordCount} words. Grounding coverage was measured at roughly 50% for ~800-word pages; a shorter page is not disqualified, it simply carries less that can be grounded`
      : wordCount > 1500
      ? `${wordCount} words. Coverage fell as length rose (~50% at ~800 words against ~13% at ~4000), so a long page is not penalised — a smaller share of it gets used. Splitting by topic is one response; leaving it long is another`
      : `${wordCount} words, inside the range where coverage was highest in the cited measurements`,
  });

  // 3. Definition patterns present (6 pts)
  const hasDefinitions = patterns !== null && patterns.definition.test(cleanText);
  checks.push({
    name: "Definition patterns present (X is a…, X es un…, refers to, significa)", source: RESEARCH.geoTactics,
    passed: hasDefinitions,
    points: 6,
    status: languageUnreadable ? "not-evaluated" : undefined,
    detail: languageUnreadable
      ? unreadableDetail
      : hasDefinitions
      ? patterns !== null && patterns.definition.test(firstThirtyPct)
        ? "Definitions found in first 30% — excellent citation anchor for AI engines"
        : "Definitions found but not in first 30% — move key definitional sentences to the top"
      : "No definition patterns. Add sentences of the form 'X is a…', which state the subject outright instead of assuming it",
  });

  // 4. Question-based H2/H3 headings ≥ 2 (6 pts)
  // Read from the heading's visible text, not matched against its markup. The regex
  // was `<h[2-3][^>]*>[^<]*\?[^<]*</h[2-3]>`, which `[^<]*` makes unable to match a
  // heading containing any nested tag — and a Spanish question opens with `¿`, which
  // templates very often wrap (#342).
  const questionHeadings = page.readable
    .texts("h2,h3")
    .filter((heading) => heading.includes("?"));
  const hasQuestionHeadings = questionHeadings.length >= 2;
  checks.push({
    name: "2+ question-based H2/H3 headings (Q&A structure)", source: RESEARCH.answerCapsules,
    passed: hasQuestionHeadings,
    points: 6,
    detail: `${questionHeadings.length} question heading${questionHeadings.length !== 1 ? "s" : ""} found${hasQuestionHeadings ? " — 72.4% of ChatGPT-cited posts put a self-contained answer right after a question heading" : " — add headings like 'What is X?' and 'How does X work?'"}`,
  });

  // 5. Data density ≥ 3 stats per 1000 words (6 pts)
  const statsMatches = cleanText.match(/\b\d+(?:[.,]\d+)?(?:\s*%|\s*million|\s*billion|\s*thousand|\s*k\b)/gi) ?? [];
  const statsPer1k = wordCount > 0 ? (statsMatches.length / wordCount) * 1000 : 0;
  const hasStats = statsPer1k >= 3;
  checks.push({
    name: "Data density ≥ 3 statistics per 1000 words", source: RESEARCH.geoTactics,
    passed: hasStats,
    points: 6,
    detail: `${statsMatches.length} data points found (${statsPer1k.toFixed(1)}/1k words)${hasStats ? " — statistics/data favored by AI grounding (GEO: statistics addition)" : " — add percentages, numbers, and research findings"}`,
  });

  // 6. Visible Q&A pattern (3 pts) — rewards semantic HTML (details/summary, dl/dt/dd)
  // OR FAQPage schema as a fallback signal. AI engines extract from the rendered DOM,
  // not from @type. FAQPage rich results were deprecated by Google on May 7, 2026 and
  // Ahrefs' 2026 causal study found no AI citation lift from JSON-LD.
  const hasFaqSchema = /"@type"\s*:\s*"FAQPage"/i.test(html);
  const hasDisclosure = /<details[^>]*>[\s\S]*?<summary[^>]*>/i.test(html);
  const hasDefList = /<dl[^>]*>[\s\S]*?<dt[^>]*>/i.test(html);
  const hasQaPattern = hasDisclosure || hasDefList || hasFaqSchema;
  checks.push({
    name: "Visible Q&A pattern (details/summary, dl/dt/dd, or FAQPage schema)", source: RESEARCH.schemaHasNoLift,
    passed: hasQaPattern,
    points: 3,
    detail: hasDisclosure
      ? "Semantic <details>/<summary> disclosure detected — preferred pattern for AI extraction"
      : hasDefList
        ? "Definition list (dl/dt/dd) detected — valid Q&A semantic pattern"
        : hasFaqSchema
          ? "FAQPage JSON-LD found — note Google deprecated FAQ rich results May 2026; pair with visible Q&A in the DOM"
          : "No Q&A pattern detected — add <details>/<summary> with visible questions and answers",
  });

  // 7. Named-entity density (3 pts) — replaces the old Speakable-schema check,
  // which the AI Visibility Framework never references. Entity density is one of
  // the framework's five measured characteristics of cited text (~20.6% vs ~5–8%).
  const eDensity = entityDensity(cleanText);
  const hasEntityDensity = eDensity >= 0.08;
  checks.push({
    name: "Named-entity density (specific tools, brands, people, places)", source: RESEARCH.entityDensity,
    passed: hasEntityDensity,
    points: 3,
    detail: `${(eDensity * 100).toFixed(1)}% named-entity density${hasEntityDensity
      ? " — entity-dense like cited text (~20.6% vs ~5–8% normal; K. Indig / Gauge, proxy)"
      : " — name specific tools, brands, people, and data points; cited text is entity-dense (~20.6%)"}`,
  });

  // 8. Core content in static HTML (3 pts)
  const staticText = bodyMatch
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  const hasStaticContent = staticText.length > 300;
  checks.push({
    name: "Core content in static HTML (not JS-only)", source: STATIC_HTML_HEURISTIC,
    passed: hasStaticContent,
    points: 3,
    detail: hasStaticContent
      ? `${staticText.length} chars of static HTML content — AI crawlers can index it`
      : "Minimal static content — AI crawlers (GPTBot, ClaudeBot) don't execute JavaScript",
  });

  // 9. AI bots not blocked in robots.txt (8 pts)
  //
  // The one check in this module that used to be wrong in both directions at once: a
  // robots.txt we could not read printed "not accessible" and still deducted all 8,
  // while a 5xx that happened to serve a body reported a clean 8/8 "all crawlers
  // allowed" about a server that never answered correctly (#337). A site with no
  // robots.txt still passes, because that is a real answer: no rules, nothing blocked.
  const unreadable = aiBotAccess.status === "unavailable";
  const aiBotsDetail = aiBotAccess.status === "unavailable"
    ? notScored(aiBotAccess.reason, "retry, or check that /robots.txt is reachable")
    : aiBotAccess.blocked.length === 0
    ? "GPTBot, PerplexityBot, ClaudeBot, and Google-Extended are all allowed — AI crawlers can index your content"
    : `${aiBotAccess.blocked.join(", ")} blocked in robots.txt — remove these rules to allow AI crawlers to index your content`;
  checks.push({
    name: "AI crawlers allowed (GPTBot, PerplexityBot, ClaudeBot, Google-Extended)", source: ROBOTS_FACT,
    passed: aiBotAccess.status === "ok",
    points: 8,
    status: unreadable ? "not-evaluated" : undefined,
    detail: aiBotsDetail,
  });

  // 10. Content freshness (5 pts max)
  //
  // Gated on the Page Kind, which is the whole of #288 arriving in the second of the
  // two modules it was about. #288's complaint was that `geo_score` and
  // `ai_visibility_score` contradicted each other on the same homepage; the fix
  // landed in `geo-analyzer`, which marks this exact signal N/A for undated page
  // kinds at three call sites, and this one kept docking a homepage 5 points for not
  // being an article (#337).
  const undated = isUndatedPage(pageKind);
  const freshnessPoints = freshness === "fresh" ? 5 : freshness === "aging" ? 3 : 0;
  const freshnessPassed = freshnessPoints > 0;
  // The day thresholds are ours (`FRESHNESS_HEURISTIC` says so). The detail used to
  // add a multiplier about which engines favour recent content, which no platform
  // publishes — the same invented figure `check-source.ts` records as removed. It
  // states what was measured on the page and stops.
  const freshnessDetail =
    freshness === "fresh" ? "Modified within the last 60 days" :
    freshness === "aging" ? "Modified within the last 180 days. Worth refreshing if the topic moves" :
    freshness === "stale" ? "Last modified more than 180 days ago" :
    "No modified date found. State one in the page's JSON-LD, or in an article:modified_time meta tag";
  checks.push({
    name: "Content freshness (modified within 180 days)", source: FRESHNESS_HEURISTIC,
    passed: freshnessPassed,
    points: 5,
    // The one partial-credit check here: 5 for fresh, 3 for aging, 0 for stale.
    earned: freshnessPoints,
    status: undated ? "not-applicable" : undefined,
    detail: undated
      ? `N/A for ${pageKind} pages: this kind of page is not published on a date, so there is no freshness to measure`
      : freshnessDetail,
  });

  return { ...totals(checks), wordCount, checks };
}

/**
 * Typed to the three fields it reads, not to the section.
 *
 * It was declared as taking `AiVisibilitySection["l1"]` while the tool calls it
 * with the analyzer's own checks. That type-checked as long as the two shapes were
 * identical, and quietly became untrue when storage started resolving `source` to
 * `provenance` — the signature named a shape the caller never passes. Nothing here
 * touches provenance either way: an action is derived from the check's name and
 * detail.
 */
type ActionInput = {
  checks: ReadonlyArray<{ name: string; passed: boolean; detail: string }>;
};

/**
 * What L4 needs to say beyond its checks.
 *
 * `wordCount` because the length check fails in two directions and the advice is
 * opposite in each: a 300-word page should be expanded, a 4,000-word one should not.
 * Carried as a figure rather than read back out of the check's prose, which is how
 * this action came to be dead in the first place (#341).
 */
type L4ActionInput = ActionInput & { wordCount: number };

export function buildTopActions(
  l1: Readonly<ActionInput>,
  l4: Readonly<L4ActionInput>,
  l2: Readonly<{ signals: ReadonlyArray<{ name: string; found: boolean }> }>,
  vertical: Vertical,
): string[] {
  const actions: Array<{ priority: number; action: string }> = [];

  for (const c of l1.checks) {
    if (c.passed) continue;
    if (c.name.includes("Organization schema"))
      actions.push({ priority: 1, action: "Add Organization schema with name, url, and logo — this is the primary gate for AI entity resolution" });
    else if (c.name.includes("sameAs"))
      actions.push({ priority: 2, action: "Add sameAs URLs to Organization schema: LinkedIn, Wikipedia or Wikidata, Crunchbase, and your main social profiles" });
    else if (c.name.includes("Wikidata"))
      actions.push({ priority: 3, action: "Create a Wikidata entry for your brand — it's the primary knowledge graph AI systems use for entity resolution" });
    else if (c.name.includes("director"))
      actions.push({ priority: 2, action: `Get listed on ${VERTICAL_PRIORITY_DIRS[vertical].slice(0, 2).join(" and ")} — active review profiles correlate with ~3x higher ChatGPT citation (ConvertMate); listings drive ~42% of location-query citations (Yext)` });
    else if (c.name.includes("consistent"))
      actions.push({ priority: 2, action: "Fix entity name inconsistency — use one exact brand name in og:site_name, Organization schema, and title tag" });
    // No llms.txt action. The check can no longer fail, and recommending a file
    // Google states it does not read is the advice this audit set out to remove.
  }

  for (const c of l4.checks) {
    if (c.passed) continue;
    if (c.name.includes("first 30%"))
      actions.push({ priority: 1, action: "Front-load a definition or key data point in your first paragraph — 44.2% of AI citations come from the first 30% of page text" });
    else if (c.name.includes("AI crawlers allowed"))
      actions.push({ priority: 1, action: `Allow AI crawlers in robots.txt — remove Disallow rules for GPTBot, PerplexityBot, ClaudeBot, and Google-Extended` });
    // Was `c.detail.includes("below")`, against a detail later rewritten to stop
    // calling the range a rule — so the words it matched on were gone and the action
    // could never fire (#341). It reads the measurement now, not the prose about it.
    else if (c.name.includes("800–1500") && l4.wordCount < 800)
      actions.push({ priority: 2, action: "Expand key pages with specific data and examples. Grounding coverage was measured highest around 800–1500 words (Dejan AI, Dec 2025; Indig / Gauge, Feb 2026) — the range is where the measurement peaked, not a length to write to" });
    else if (c.name.includes("Named-entity density"))
      actions.push({ priority: 2, action: "Name specific tools, brands, people, and data points — cited text is entity-dense (~20.6% vs ~5–8% in normal prose)" });
    else if (c.name.includes("question"))
      actions.push({ priority: 2, action: "Add 2+ question-based H2/H3 headings (e.g. 'What is X?', 'How does X work?'), each followed by a self-contained answer — 72.4% of ChatGPT-cited posts had that shape (Indig / Search Engine Land, Nov 2025). No platform publishes a ranking of formats" });
    else if (c.name.includes("Definition"))
      actions.push({ priority: 2, action: "Add definitional sentences near the top of key pages. Declarative 'X is a…' phrasing is one of the tactics the KDD 2024 GEO paper measured, where adding statistics, quotations and citations raised visibility by up to 40%" });
    else if (c.name.includes("freshness"))
      actions.push({ priority: 3, action: "Add or update dateModified in your JSON-LD schema — AI systems prefer recently updated pages for citations" });
    else if (c.name.includes("Q&A pattern"))
      actions.push({ priority: 3, action: "Add a visible Q&A section using semantic HTML (details/summary or dl/dt/dd) — AI engines extract from the rendered DOM, not from @type" });
  }

  for (const s of l2.signals) {
    if (!s.found && s.name.includes("Press"))
      actions.push({ priority: 4, action: "Create a /press or /newsroom page — earned media aggregated there feeds the AI training layer with authoritative brand signals" });
  }

  // Deduplicate and sort
  const seen = new Set<string>();
  return actions
    .sort((a, b) => a.priority - b.priority)
    .filter((a) => { if (seen.has(a.action)) return false; seen.add(a.action); return true; })
    .slice(0, 5)
    .map((a) => a.action);
}

export function buildL3Guide(vertical: Vertical): AiVisibilitySection["l3"] {
  const editorialSources: Record<Vertical, string[]> = {
    saas:       ["G2 (g2.com)", "Capterra (capterra.com)", "Product Hunt", "Reddit r/SaaS, r/entrepreneur"],
    local:      ["Yelp", "Google Maps", "TripAdvisor", "NextDoor", "local Reddit subreddits"],
    healthcare: ["Healthgrades", "Zocdoc", "US News Health", "Vitals.com"],
    finance:    ["NerdWallet", "Bankrate", "Investopedia", "Reddit r/personalfinance"],
    agency:     ["Clutch (clutch.co)", "GoodFirms", "G2", "UpCity", "Reddit r/marketing"],
    ecommerce:  ["Google Shopping", "Trustpilot", "Wirecutter", "Reddit product review subreddits"],
    legal:      ["Avvo", "Martindale-Hubbell", "FindLaw", "Justia"],
    education:  ["Class Central", "G2 Learning", "Course Report", "Reddit r/learnprogramming"],
    generic:    ["G2", "Capterra", "Trustpilot", "Reddit relevant subreddits", "Crunchbase"],
  };

  return {
    vertical,
    editorialSources: editorialSources[vertical],
  };
}
