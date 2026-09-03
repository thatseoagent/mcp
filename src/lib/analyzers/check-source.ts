/**
 * Where a check gets its authority.
 *
 * The audit in `docs/google-search-central-conformance.md` found ten checks that
 * reported as problems things Google states are not problems: a 300-word floor,
 * a single H1, a 60-character title, a canonical that points anywhere but at
 * itself. None of them were wrong on purpose. They were wrong because writing an
 * invented rule cost exactly as much as writing a real one — `push("Low word
 * count")` type-checks as well as anything.
 *
 * So the cost is moved into the type. A finding carries the reason it is a
 * finding, and the three kinds are not interchangeable:
 *
 *   - `google`        — Google says this, and here is the page and the words.
 *   - `research`      — a third party measured it, and here is who and where.
 *   - `heuristic`     — our judgement. Legitimate, but it is ours and says so.
 *   - `accessibility` — a real standard about human readers, not about ranking.
 *
 * `research` was the fourth, added for `ai-visibility-analyzer`. That module is the
 * best-sourced thing in the product and read like the worst: every figure it
 * reports is traced in `docs/research/ai-visibility-sources.md`, which no user
 * sees, so "44.2% of AI citations come from the first 30% of content" reached the
 * reader as our bare assertion. None of the first three kinds could fix it —
 * `heuristic` throws away a study of 1.2M citations, and `google` would be a lie.
 * The distinction between "we think this" and "someone measured this, here is who"
 * is worth a kind of its own.
 *
 * The distinction is the product. Google's own page on third-party SEO tools
 * warns that vendors "don't have access to our internal ranking data", so a
 * report that cannot separate Google's rules from its own is making exactly the
 * claim Google warns about.
 */

export type CheckSource =
  | {
      kind: "google";
      /** Canonical URL on developers.google.com. */
      doc: string;
      /**
       * The sentence being relied on, verbatim. Not a paraphrase.
       *
       * Verbatim is the whole point and it is easy to lose: two entries here were
       * added as tidied-up composites of a heading and a nearby sentence, which
       * read as quotations and were not. One of them reached a marketing page
       * inside quotation marks. If the wording you want does not exist as one
       * sentence, add two entries rather than writing the sentence you wish Google
       * had written.
       */
      quote: string;
    }
  | {
      kind: "research";
      /** Who measured it and when, as the reader should see it attributed. */
      study: string;
      /**
       * What the study actually found, in its own terms.
       *
       * Here so the check can be held to it. Two checks in
       * `ai-visibility-analyzer` had real sources and still overstated them: a
       * word-count range became an "AI grounding sweet spot" when the study
       * measured grounding coverage by length, and "72.4% of cited posts had
       * answer capsules" became "the most-cited content format". A source does not
       * license a claim bigger than itself, and this field is where a reviewer
       * checks the difference.
       */
      finding: string;
      /** Where to read it, when it is public. */
      url?: string;
    }
  | {
      kind: "heuristic";
      /** Why we believe it, given Google does not say it. */
      rationale: string;
    }
  | {
      kind: "accessibility";
      /** The standard this serves, e.g. "WCAG 2.2 §1.3.1". */
      standard: string;
      /** Google's position on its SEO impact, so the report can say it plainly. */
      seoImpact: string;
    };

const SEARCH = "https://developers.google.com/search/docs";

/**
 * The citations this codebase relies on, read on 2026-07-31.
 *
 * Only what is actually cited lives here. An earlier draft held eighteen
 * entries, a dozen of which nothing referenced — a catalogue of things we might
 * one day check, which is indistinguishable from a catalogue of things we
 * already do. When a gap in `docs/google-search-central-conformance.md` §3
 * closes, its quote arrives with the code that needs it.
 */
export const GOOGLE_SAYS = {
  canonicalNotRequired: {
    kind: "google",
    doc: `${SEARCH}/crawling-indexing/consolidate-duplicate-urls`,
    quote:
      "While we encourage you to use these methods, none of them are required; your site will likely do just fine without specifying a canonical preference.",
  },
  titleTruncatedByWidth: {
    kind: "google",
    doc: `${SEARCH}/appearance/title-link`,
    quote:
      "The title link is truncated in Google Search results as needed, typically to fit the device width.",
  },
  descriptionsMustBeUnique: {
    kind: "google",
    doc: `${SEARCH}/appearance/snippet`,
    quote: "Create unique descriptions for each page on your site.",
  },
  descriptionHasNoLimit: {
    kind: "google",
    doc: `${SEARCH}/appearance/snippet`,
    quote:
      "There's no limit on how long a meta description can be, but the snippet is truncated in Google Search results as needed, typically to fit the device width.",
  },
  directivesNeedCrawlAccess: {
    kind: "google",
    doc: `${SEARCH}/crawling-indexing/robots-meta-tag`,
    quote:
      "Keep in mind that these settings can be read and followed only if crawlers are allowed to access the pages that include these settings.",
  },
  linksNeedHref: {
    kind: "google",
    doc: `${SEARCH}/crawling-indexing/links-crawlable`,
    quote:
      "Google can follow links only if they are an <a> tag with an href attribute.",
  },
  /**
   * The gate on whether a page is eligible at all.
   *
   * Note what Google's third requirement actually means, because the first draft
   * of the gate got it wrong: "Indexable content means: The textual content is in
   * a file type that Google Search supports. The content doesn't violate our spam
   * policies." It is *not* about `noindex` — see {@link noindexRemovesThePage},
   * which is a separate mechanism on a separate page. Conflating them put a
   * sentence in front of clients that Google never wrote.
   */
  minimumTechnicalRequirements: {
    kind: "google",
    doc: `${SEARCH}/essentials/technical`,
    quote:
      "As long as your page meets the minimum technical requirements, it's eligible to be indexed by Google Search:",
  },
  onlyHttp200IsIndexed: {
    kind: "google",
    doc: `${SEARCH}/essentials/technical`,
    quote:
      "Google only indexes pages that are served with an HTTP 200 (success) status code.",
  },
  /**
   * Not one of the three technical requirements, and as decisive as any of them.
   * Filed from the robots-meta-tag page because that is where Google documents it.
   */
  noindexRemovesThePage: {
    kind: "google",
    doc: `${SEARCH}/crawling-indexing/robots-meta-tag`,
    quote: "Do not show this page, media, or resource in search results.",
  },
  agentsReadTheAccessibilityTree: {
    kind: "google",
    doc: `${SEARCH}/fundamentals/ai-optimization-guide`,
    quote:
      "browser agents may access your website to gather the data they need to complete these tasks, such as analyzing visual renderings (like screenshots), inspecting the DOM structure, and interpreting the accessibility tree.",
  },
} as const satisfies Record<string, Extract<CheckSource, { kind: "google" }>>;

/**
 * The third-party measurements this analyzer's checks rest on.
 *
 * Transcribed from `docs/research/ai-visibility-sources.md`, which is the audit
 * trail and stays the audit trail — including the corrections it records, such as
 * the "3×" that was wrongly attached to author schema before being re-anchored to
 * review profiles, and the "48.7%" that turned out to be a secondary cut of the
 * Yext study and was restated as 42%. What is new is that the attribution now
 * travels with the finding to the reader instead of living in a file nobody
 * outside the repo opens.
 *
 * Every `finding` is what the study measured, not what we conclude from it. When a
 * check's wording drifts past its `finding`, the check is wrong even though the
 * source is real — which is how the two claims corrected alongside this arrived.
 */
export const RESEARCH = {
  citationPosition: {
    kind: "research",
    study: "Kevin Indig / Gauge, Feb 2026 (1.2M citations)",
    finding: "44.2% of citations came from the first 30% of a page's text",
  },
  entityDensity: {
    kind: "research",
    study: "Kevin Indig / Gauge, Feb 2026 (1.2M citations)",
    finding: "cited text averaged 20.6% entity density against 5-8% for normal English",
  },
  groundingBudget: {
    kind: "research",
    study: "Dejan AI, Dec 2025 and Kevin Indig / Gauge, Feb 2026",
    finding:
      "grounding coverage fell with page length: roughly 50% at ~800 words against ~13% at ~4000",
  },
  answerCapsules: {
    kind: "research",
    study: "Kevin Indig / Search Engine Land, Nov 2025",
    finding:
      "72.4% of ChatGPT-cited posts had a self-contained answer immediately after a question heading",
  },
  reviewProfiles: {
    kind: "research",
    study: "ConvertMate, Jan 2026",
    finding: "active review profiles corresponded to ~3x the ChatGPT citation rate",
  },
  localListings: {
    kind: "research",
    study: "Yext, Oct 2025 (6.8M citations)",
    finding: "listings accounted for 42% of citations on location queries",
  },
  geoTactics: {
    kind: "research",
    study: "Aggarwal, Murahari et al., KDD 2024 (Princeton / Georgia Tech / Allen AI)",
    finding:
      "adding statistics, quotations and citations raised visibility by up to 40% — the only peer-reviewed measurement of these tactics",
    url: "arxiv.org/abs/2311.09735",
  },
  schemaHasNoLift: {
    kind: "research",
    study: "Ahrefs, May 2026 (1,885 treated pages against 4,000 controls)",
    finding:
      "adding schema did not raise citations: AI Overviews -4.6%, AI Mode +2.4%, ChatGPT +2.2%",
    url: "ahrefs.com/blog/schema-ai-citations",
  },
  seoExplainsLittle: {
    kind: "research",
    study: "Profound / Mike King, Feb 2026",
    finding: "conventional SEO factors explained only 4-7% of AI citations",
  },
} as const satisfies Record<string, Extract<CheckSource, { kind: "research" }>>;

/**
 * The GEO and citability checks, as what they are: our reading of how answer
 * engines pick passages.
 *
 * These carry one shared rationale because they rest on one shared bet, and
 * saying it once is what makes it arguable. The bet is that a passage a person
 * can lift out of a page unaided is also the passage a system lifts, so the
 * checks look for self-contained answers, attribution and structure. That is a
 * position about writing, not a measurement of any engine.
 *
 * Google's AI-optimization guide is the reason the wording is this careful. It
 * rules out the two claims these checks are most tempted into — that content
 * should be cut into AI-sized pieces, and that it should be written a particular
 * way for AI — so a check here may describe what it looked for and why we think
 * it helps a reader, and may not assert what an engine does with it. The numbers
 * that used to appear in these recommendations ("~2x", "at ~3× the rate", "the
 * sweet spot") were the tell: no AI platform publishes citation rates, so a
 * multiplier could only have been invented.
 */
export const CITABILITY_HEURISTIC: CheckSource = {
  kind: "heuristic",
  rationale:
    "our reading of what makes a passage quotable on its own; no AI platform publishes citation criteria",
};

/**
 * Content served in the HTML response rather than assembled by JavaScript.
 *
 * Was briefly sourced to Google's technical requirements, which is backwards:
 * Google *renders* JavaScript before indexing, and its third requirement is about
 * file types and spam policies. The reason to prefer static HTML is that no AI
 * crawler's operator documents whether it renders, so static is the safer
 * assumption — an assumption, which is exactly what a heuristic is.
 */
export const STATIC_HTML_HEURISTIC: CheckSource = {
  kind: "heuristic",
  rationale:
    "Google renders JavaScript; whether a given AI crawler does is not documented by its operator, so we treat static HTML as the safer assumption",
};

/**
 * Freshness signals, which are ours in a narrower way.
 *
 * Google does state that it uses `dateModified` where it can be trusted, but the
 * 90-day and 180-day thresholds are ours, and so is treating a `Last-Modified`
 * header as evidence of anything. The rationale names the invented part.
 */
export const FRESHNESS_HEURISTIC: CheckSource = {
  kind: "heuristic",
  rationale: "the day thresholds are ours; Google publishes no freshness window",
};

/**
 * Access to a page by a named AI crawler.
 *
 * Not a heuristic and not a Google rule: it reports what a site's own robots.txt
 * says about GPTBot, ClaudeBot, PerplexityBot and Google-Extended. The fact is
 * verifiable in the file, and what it means for citation is the operator's call,
 * so the check states the fact and stops.
 */
export const ROBOTS_FACT: CheckSource = {
  kind: "heuristic",
  rationale:
    "reports what your robots.txt and meta tags say; what a given AI engine does with the access is unpublished",
};

/**
 * What a server returned to a stated request.
 *
 * The provenance of the whole agent-navigability tier, and the reason that tier
 * is worth building: a soft 404 either happened or it did not, `Vary: Accept` is
 * either on the response or it is not. Nothing here is a reading of how a model
 * picks text, so nothing here can be wrong in the way #386 says our GEO surface
 * is unfalsifiable — it can only be out of date, which a re-run fixes.
 *
 * Filed as `heuristic` rather than as a kind of its own, following {@link
 * ROBOTS_FACT}, which reports a fact about robots.txt under the same label. The
 * shared rationale carries the honest half: the response is a fact, and what any
 * particular agent does with it is the operator's undocumented business.
 */
export const AGENT_HTTP_FACT: CheckSource = {
  kind: "heuristic",
  rationale:
    "reports what the server returned to the request shown; no agent operator publishes how its client handles the response",
};

/**
 * A response measured against a number we chose.
 *
 * Split from {@link AGENT_HTTP_FACT} because it is not the same kind of claim,
 * and the split has to be made per check rather than per module: the measurement
 * is a fact, the threshold that turns it into a verdict is ours, in exactly the
 * way {@link FRESHNESS_HEURISTIC}'s day counts are ours.
 *
 * Three checks in `agent-navigability.ts` take this instead of the fact source —
 * the page token budget (where an agent truncates), the JavaScript-redirect stub
 * (how short a body has to be to count as a stub), and the 404 recovery body (how
 * much text, and which entry points count as a way back). If any part of a
 * verdict rests on one of our numbers, the whole check carries this, because a
 * reader cannot see which half of a sentence was measured.
 */
export const AGENT_HTTP_THRESHOLD: CheckSource = {
  kind: "heuristic",
  rationale:
    "the response is a fact; the threshold it is judged against is ours, and no agent operator publishes one",
};

/**
 * Heading structure, as the standard that actually governs it.
 *
 * Google is on the record that heading order and count do not affect ranking.
 * They do affect someone navigating a page by headings, which is a real finding
 * worth reporting — as long as the report does not let a reader believe Google
 * asked for it.
 *
 * Lives here rather than beside one of the analyzers that raises it: three of
 * them do, and a shared source belongs with the other sources.
 */
export const HEADING_ACCESSIBILITY: CheckSource = {
  kind: "accessibility",
  standard: "WCAG 2.2 §1.3.1 Info and Relationships",
  seoImpact: "Google states heading order and count do not affect ranking",
};

/**
 * Operability by an agent, which is the accessibility tree by another name.
 *
 * The only `accessibility` source whose `seoImpact` points at something Google
 * asks for rather than something it says not to worry about, and the reason is the
 * AI-optimization guide: agents "interpret the accessibility tree", so a control
 * with no accessible name is missing one for them too. That makes these findings
 * the rare case where the accessibility fix and the AI-era fix are one fix.
 *
 * Still filed as `accessibility` rather than `google`. Google names the mechanism;
 * it does not say an unnamed button costs you anything in Search, and the standard
 * that actually governs the markup is WCAG. Claiming the stronger source would be
 * the same overreach the rest of this module exists to prevent.
 *
 * A function rather than a constant because the criterion varies with the finding:
 * an unnamed control is §4.1.2, a missing landmark is §1.3.1. The constant it
 * replaced hard-coded §4.1.2 for both, which cited the wrong criterion for one of
 * the two things it reported.
 */
export function agentOperability(standard: string): CheckSource {
  return {
    kind: "accessibility",
    standard,
    seoImpact:
      "Google states browser agents interpret the accessibility tree, so this affects what an agent can do on the page rather than how it ranks",
  };
}

/**
 * A finding with its provenance attached, in the `string` shape the report,
 * the MCP tools and the stored audits already speak.
 *
 * Findings travel as plain strings through several layers, so the alternative to
 * this was a type migration across all of them. Putting the qualifier in the text
 * gets the honesty to the reader now: a heuristic that announces itself as ours
 * cannot be mistaken for something Google said, which was the whole failure.
 *
 * Google-sourced findings are left bare, and the `source` argument goes unread
 * for them. That is deliberate on two counts: they are the baseline the report
 * exists to deliver, so tagging every one would bury the two kinds that need
 * marking; and passing the citation anyway is what makes the call site prove it
 * has one. A rule with no quote to hand cannot be written as though it had.
 */
export function annotate(message: string, source: CheckSource): string {
  const q = qualifier(source);
  return q ? `${message} — ${q}` : message;
}

/**
 * The qualifier alone, for callers that keep it in its own field.
 *
 * The structured report needs the marking separate from the check's name, because
 * the name is an identifier there and things look themselves up by it. This is
 * where the wording lives now, so {@link annotate} composes it rather than the
 * other caller taking `annotate`'s output apart again with a hard-coded separator.
 *
 * `undefined` for a Google-sourced finding: those are the baseline, and marking
 * every one of them would bury the two kinds that need marking.
 */
export function qualifier(source: CheckSource): string | undefined {
  if (source.kind === "google") return undefined;
  if (source.kind === "accessibility") {
    return `Accessibility (${source.standard}); ${source.seoImpact}`;
  }
  if (source.kind === "research") {
    // Names the study and nothing else. The point is that the reader can tell this
    // is someone's measurement rather than our opinion, and go and read it.
    return `Measured by ${source.study}${source.url ? ` — ${source.url}` : ""}`;
  }
  // "That SEO Agent", spelled the way the product is spelled everywhere else. It
  // said "thatseoagent" — the domain, not the name — on every heuristic row of
  // every report, which is the single most-repeated string the product shows a
  // client.
  //
  // Sentence case rather than the full capitals the shape of the line suggests.
  // These three strings share one renderer, and two of them carry things capitals
  // destroy: `arxiv.org/abs/2311.09735` becomes an address nobody can retype, and
  // "Aggarwal, Murahari et al." and "WCAG 2.2 §1.3.1 Info and Relationships" stop
  // being names. A rule that only holds for the shortest of the three would be
  // three rules.
  return "That SEO Agent heuristic, not a Google rule";
}
