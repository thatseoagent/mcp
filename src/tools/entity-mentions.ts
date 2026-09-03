import { z } from "zod";
import { type ToolMetadata, type InferSchema } from "xmcp";
import { notScored } from "../lib/analyzers/scored-checks";
import { extractJsonLd } from "../lib/analyzers/json-ld-graph";
import { publishingEntity, isDeclared } from "../lib/analyzers/publishing-entity";
import { pageLanguage } from "../lib/analyzers/page-language";
import { fetchHtml } from "../lib/http-client";
import { PageFetchError } from "../lib/page-fetch-error";
import { PAGE_AUDIT_USER_AGENT } from "../lib/bot-identity";
import { readWellKnown } from "../lib/well-known";
import { lookupWikidata } from "../lib/wikidata-check";
import { defineCachedTool } from "../lib/define-tool";
import { domainFromUrl, refreshable } from "../lib/with-cache";
import { toolError, toolText } from "../lib/tool-result";

export const schema = {
  ...refreshable,
  url: z
    .string()
    .url()
    .describe("Homepage URL of the brand to check for off-site entity mentions"),
};

export const metadata: ToolMetadata = {
  name: "entity_mentions",
  description:
    "Check where a brand exists off its own site: Wikipedia, Wikidata, Reddit, and " +
    "the LinkedIn, YouTube and GitHub profiles its homepage links to. Reports a " +
    "platform that did not answer as not checked rather than as an absence. Needs " +
    "no credentials and no database.",
  annotations: {
    title: "Check off-site entity mentions",
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: true,
  },
};

/** Completes the sentence "Could not …" for every failure this Tool can return. */
const FAILURE_CONTEXT = "check off-site mentions for this brand";

/*
 * The robots.txt gate the retired handler applied to each of these fetches is not
 * here, for the reason `http-client.ts` gives: it arrives with the crawl Tools,
 * which are the ones that read a site at volume. What this Tool asks for is a
 * homepage and three profile URLs the homepage itself published — one request
 * each, to pages their owners link to publicly. When the gate lands, this file is
 * one of the callers to reconnect to it, and the "refused by robots" outcome maps
 * onto `unanswered` below rather than needing a fifth state.
 */

/** How long any one third-party lookup is given. */
const LOOKUP_TIMEOUT = 8_000;

/**
 * One platform's answer.
 *
 * `status: "not-evaluated"` is a third state and not a kind of `found: false`: a
 * platform that did not answer is evidence of nothing, and reporting it as an
 * absence is how this audit told a confident lie.
 */
type EntityPlatformResult = {
  platform: string;
  found: boolean;
  status?: "not-evaluated";
  url?: string;
  /** True when we only asked whether something exists at a URL, not an API. */
  headOnly?: boolean;
  detail?: string;
};

/**
 * The homepage, or the status that says why we do not have it.
 *
 * Through the shared fetcher, so this read joins the one every other Tool in the
 * same turn already made. Only a {@link PageFetchError} is caught: that is the one
 * failure this Tool can describe better than the seam can — it knows the read was
 * of the homepage and that nothing downstream ran. Everything else, an SSRF
 * refusal above all, travels on to `defineTool`, whose whole job is deciding which
 * messages we are entitled to publish.
 */
async function fetchHomepage(url: string): Promise<{ text: string; status: number }> {
  try {
    return { text: await fetchHtml(url), status: 200 };
  } catch (error) {
    if (error instanceof PageFetchError) return { text: "", status: error.status };
    throw error;
  }
}

/**
 * Does something exist at this URL?
 *
 * Three answers, because `response.ok` puts a 403, a 429, a timeout and a genuine
 * 404 in one bucket labelled "not reachable". LinkedIn is the case that makes it
 * worth doing: it answers HTTP 999 to clients that are not browsers, so this check
 * told Operators their company page was unreachable when what happened is that
 * LinkedIn does not talk to us.
 *
 * The three states are `well-known.ts`'s, under this file's own names, because it
 * already draws exactly this line for exactly this reason. A profile URL is not a
 * well-known path, so the module is used rather than the concept re-derived.
 */
type HeadOutcome = "present" | "absent" | "unanswered";

async function headCheck(url: string): Promise<HeadOutcome> {
  const { origin, pathname, search } = new URL(url);
  const read = await readWellKnown(origin, pathname + search, {
    method: "HEAD",
    timeout: LOOKUP_TIMEOUT,
  });
  if (read.outcome === "found") return "present";
  if (read.outcome === "absent") return "absent";
  return "unanswered";
}

/**
 * One result from a `headCheck`, so the three URL-shaped platforms cannot drift
 * apart on what a 403 means.
 */
function fromHead(
  platform: string,
  url: string,
  outcome: HeadOutcome,
  present: string,
  absent: string,
): EntityPlatformResult {
  if (outcome === "unanswered") {
    return {
      platform,
      found: false,
      status: "not-evaluated",
      url,
      headOnly: true,
      detail: notScored(
        `${platform} did not answer our check`,
        "the page may well be there, we could not confirm it",
      ),
    };
  }
  return {
    platform,
    found: outcome === "present",
    url,
    headOnly: true,
    detail: outcome === "present" ? present : absent,
  };
}

/** One Wikipedia edition. `null` when it did not answer; `false` when it has no article. */
async function wikipediaSummary(
  brand: string,
  lang: string,
): Promise<{ found: boolean; title?: string; url?: string; status?: number }> {
  const res = await fetch(
    `https://${lang}.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(brand)}`,
    {
      signal: AbortSignal.timeout(LOOKUP_TIMEOUT),
      // Wikipedia's API policy asks for a descriptive agent with a way to reach
      // the operator.
      headers: { "User-Agent": PAGE_AUDIT_USER_AGENT },
    },
  );
  if (res.status === 404) return { found: false };
  if (!res.ok) return { found: false, status: res.status };
  const data = (await res.json()) as {
    title?: string;
    content_urls?: { desktop?: { page?: string } };
  };
  return { found: true, title: data.title, url: data.content_urls?.desktop?.page };
}

/**
 * `language` is the page's, and English is the fallback rather than the only try.
 *
 * `en.wikipedia.org` hard-coded meant a Spanish company with a Spanish article and
 * no English one was reported as having no Wikipedia presence.
 *
 * Asymmetric, so it costs nothing in the common case: an article found in the
 * page's own language is conclusive and English is never asked. Only a negative
 * spends the second request, because a brand writing in Spanish may perfectly well
 * have an English article and nothing else.
 */
async function checkWikipedia(
  brand: string,
  language: string | null,
): Promise<EntityPlatformResult> {
  try {
    const editions = language && language !== "en" ? [language, "en"] : ["en"];
    let lastStatus: number | undefined;

    for (const lang of editions) {
      const hit = await wikipediaSummary(brand, lang);
      if (hit.found) {
        return {
          platform: "Wikipedia",
          found: true,
          url: hit.url,
          detail: hit.title ? `Article: "${hit.title}" (${lang}.wikipedia.org)` : "Article found",
        };
      }
      if (hit.status) lastStatus = hit.status;
    }

    if (lastStatus !== undefined) {
      // A 429 or a 5xx is not evidence that the brand has no article.
      return {
        platform: "Wikipedia",
        found: false,
        status: "not-evaluated",
        detail: notScored(`Wikipedia answered HTTP ${lastStatus}`),
      };
    }
    return {
      platform: "Wikipedia",
      found: false,
      detail: `No Wikipedia article found (searched ${editions
        .map((lang) => `${lang}.wikipedia.org`)
        .join(" and ")})`,
    };
  } catch {
    // The clearest instance in the file, and it stated the problem in its own
    // output: `✗ Wikipedia — NOT FOUND` printed about a brand that may well have
    // an article, counted into the summary as an absence nobody established.
    return {
      platform: "Wikipedia",
      found: false,
      status: "not-evaluated",
      detail: notScored("the request to Wikipedia failed or timed out"),
    };
  }
}

async function checkWikidata(
  brand: string,
  language: string | null,
): Promise<EntityPlatformResult> {
  // `wbsearchentities` searches one language's labels at a time, so an item
  // labelled only in Spanish stays invisible to an English-only search.
  const match = await lookupWikidata(brand, language);
  if (match.found && match.id) {
    return {
      platform: "Wikidata",
      found: true,
      url: `https://www.wikidata.org/wiki/${match.id}`,
      detail: match.description ? `"${match.description}"` : `Entity: ${match.label}`,
    };
  }
  // `found: null` means the API never answered, which is not the same as no entity.
  if (match.found === null) {
    return {
      platform: "Wikidata",
      found: false,
      status: "not-evaluated",
      detail: notScored(match.reason ?? "Wikidata did not answer"),
    };
  }
  return { platform: "Wikidata", found: false, detail: "No matching Wikidata entity" };
}

async function checkReddit(brand: string): Promise<EntityPlatformResult> {
  try {
    const qs = new URLSearchParams({ q: brand, sort: "relevance", limit: "5" });
    const res = await fetch(`https://www.reddit.com/search.json?${qs}`, {
      signal: AbortSignal.timeout(LOOKUP_TIMEOUT),
      headers: { "User-Agent": PAGE_AUDIT_USER_AGENT },
    });
    // Reddit rate-limits unauthenticated search hard, so this is the branch most
    // likely to fire in a real run.
    if (!res.ok) {
      return {
        platform: "Reddit",
        found: false,
        status: "not-evaluated",
        detail: notScored(`Reddit answered HTTP ${res.status}`),
      };
    }
    const data = (await res.json()) as { data?: { children?: unknown[] } };
    const threadCount = data.data?.children?.length ?? 0;
    if (threadCount > 0) {
      return {
        platform: "Reddit",
        found: true,
        url: `https://www.reddit.com/search/?q=${encodeURIComponent(brand)}`,
        detail: `${threadCount} thread(s) found`,
      };
    }
    return { platform: "Reddit", found: false, detail: "No threads found" };
  } catch {
    return {
      platform: "Reddit",
      found: false,
      status: "not-evaluated",
      detail: notScored("the request to Reddit failed or timed out"),
    };
  }
}

async function checkLinkedIn(html: string): Promise<EntityPlatformResult | null> {
  const slug = html.match(
    /https?:\/\/(?:www\.)?linkedin\.com\/company\/([A-Za-z0-9_-]+)/,
  )?.[1];
  if (!slug) return null;
  const url = `https://www.linkedin.com/company/${slug}`;
  return fromHead(
    "LinkedIn",
    url,
    await headCheck(url),
    "Company page found",
    "No company page at that URL",
  );
}

async function checkYouTube(html: string): Promise<EntityPlatformResult | null> {
  const url = html.match(
    /https?:\/\/(?:www\.)?youtube\.com\/(?:@[A-Za-z0-9_.-]+|channel\/[A-Za-z0-9_-]+|c\/[A-Za-z0-9_.-]+|user\/[A-Za-z0-9_.-]+)/,
  )?.[0];
  if (!url) return null;
  return fromHead("YouTube", url, await headCheck(url), "Channel found", "No channel at that URL");
}

async function checkGitHub(html: string): Promise<EntityPlatformResult | null> {
  const url = html.match(
    /https?:\/\/(?:www\.)?github\.com\/[A-Za-z0-9_-]+(?:\/[A-Za-z0-9_.-]+)?/,
  )?.[0];
  if (!url) return null;
  return fromHead(
    "GitHub",
    url,
    await headCheck(url),
    "Profile/repo found",
    "No profile or repo at that URL",
  );
}

export default defineCachedTool(FAILURE_CONTEXT, { toolName: "entity_mentions", domainOf: domainFromUrl }, async ({ url }: InferSchema<typeof schema>) => {
  const home = await fetchHomepage(url);
  const html = home.text;
  // The shared module, not a private regex parser. A private one could not see an
  // Organization inside a top-level JSON-LD array — the shape any site without
  // `@graph` emits — so it fell through to a fragment of `<title>` and searched
  // Wikipedia and Wikidata for that. It never looked for `Person` either, so every
  // personal site did the same.
  const entity = publishingEntity(extractJsonLd(html), html);
  const brand = entity?.name ?? "";
  const language = pageLanguage(html);

  const lines: string[] = [];
  lines.push("=== ENTITY MENTIONS AUDIT ===\n");
  lines.push(`URL: ${url}`);
  // Where the name came from, because it decides how much a NOT FOUND is worth.
  // "No Wikipedia article for Acme Corp" and "no Wikipedia article for the first
  // four words of your page title" are different sentences.
  const provenance = entity
    ? entity.source === "schema"
      ? "declared in schema"
      : entity.source === "og"
        ? "from og:site_name"
        : "guessed from the page title"
    : "";
  lines.push(`Brand detected: ${brand || "(unknown)"}${brand ? ` (${provenance})` : ""}\n`);
  if (entity && !isDeclared(entity)) {
    lines.push(
      "This name was taken from the <title>, not declared as a Publishing Entity. Add " +
        "Organization or Person schema so these lookups search for what you actually call " +
        "yourself; until then, treat any NOT FOUND below as a finding about the title " +
        "rather than about the brand.\n",
    );
  }

  if (!brand) {
    // An error, not a short report: no platform was checked, so there is no audit
    // here — and a Tool that cannot do its whole job says so rather than returning
    // less (CONTEXT.md, ADR-0003). Both sentences name what to change.
    //
    // Two different facts, and they used to print as one. A page we never read
    // tells us nothing about how the brand is marked up.
    lines.push(
      home.text
        ? "The page was read, but it names no brand: no Organization, LocalBusiness or " +
            "Person schema, no og:site_name, no usable title. Add one of those and this " +
            "audit can run."
        : `The homepage could not be read (${
            home.status ? `HTTP ${home.status}` : "no response"
          }), so the brand name could not be taken from it and no platform was checked. ` +
            `This is not a finding about the brand.`,
    );
    return toolError(lines.join("\n"));
  }

  const [wikipediaResult, wikidataResult, redditResult, linkedInResult, youTubeResult, gitHubResult] =
    await Promise.allSettled([
      checkWikipedia(brand, language),
      checkWikidata(brand, language),
      checkReddit(brand),
      checkLinkedIn(html),
      checkYouTube(html),
      checkGitHub(html),
    ]);

  // Every check absorbs its own failures, so a rejection here means something
  // unforeseen threw — which is still "we did not find out", and mapping it to a
  // plain `found: false` is the outermost layer of the same mistake.
  const unwrap = (
    settled: PromiseSettledResult<EntityPlatformResult | null>,
    platform: string,
  ): EntityPlatformResult | null =>
    settled.status === "fulfilled"
      ? settled.value
      : {
          platform,
          found: false,
          status: "not-evaluated",
          detail: notScored("the check failed unexpectedly"),
        };

  const platforms: EntityPlatformResult[] = [
    unwrap(wikipediaResult, "Wikipedia")!,
    unwrap(wikidataResult, "Wikidata")!,
    unwrap(redditResult, "Reddit")!,
  ];
  for (const [settled, name] of [
    [linkedInResult, "LinkedIn"],
    [youTubeResult, "YouTube"],
    [gitHubResult, "GitHub"],
  ] as const) {
    const result = unwrap(settled, name);
    if (result !== null) platforms.push(result);
  }

  lines.push("=== PLATFORM RESULTS ===\n");
  for (const platform of platforms) {
    // `NOT RUN` is the wording `renderVerdict` already returns for this state in
    // the scoring Tools. The word travels, the module does not: that one deals in
    // marks and this renderer deals in words.
    const verdict =
      platform.status === "not-evaluated" ? "NOT RUN" : platform.found ? "FOUND" : "NOT FOUND";
    const method = platform.headOnly ? " [URL check only]" : " [API check]";
    lines.push(
      `${platform.platform}${method}: ${verdict}` +
        `${platform.detail ? ` — ${platform.detail}` : ""}` +
        `${platform.url ? ` (${platform.url})` : ""}`,
    );
  }

  // Out of the denominator, not out of the numerator. A platform that did not
  // answer used to lower the count exactly like a real absence, so two runs against
  // the same brand gave different figures with nothing about the brand having
  // changed — the same arithmetic `tally` does for a scored check.
  const answered = platforms.filter((platform) => platform.status !== "not-evaluated");
  const foundCount = answered.filter((platform) => platform.found).length;
  const unchecked = platforms.length - answered.length;
  lines.push(
    `\nSummary: ${foundCount}/${answered.length} platforms confirmed` +
      (unchecked > 0 ? `, ${unchecked} not checked` : ""),
  );

  return toolText(lines.join("\n"));
});
