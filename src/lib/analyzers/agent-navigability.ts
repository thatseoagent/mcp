/**
 * Can an agent navigate this site's HTTP responses, or only read one page of it?
 *
 * The first of the three tiers in #386, and the one that needs nothing but
 * `fetch`, so it applies to every site and carries almost no applicability
 * gating. Every check here is an assertion about a response: a soft 404 either
 * happened or it did not, `Vary: Accept` is either on the response or it is not,
 * a fence count is either even or odd.
 *
 * That is what separates this module from `geo-analyzer` and
 * `ai-visibility-analyzer`. Those are our model of how an answer engine picks
 * text — legitimate, disclosed as ours, and per
 * `docs/google-search-central-conformance.md` §3.1 unfalsifiable. This is the same
 * kind of thing `agent-operability.ts` is, and for the same reason: a fact a
 * reader can reproduce. See `docs/agent-navigability.md` for what these checks
 * may and may not claim, and ADR-0025 for why the axis existed unmeasured.
 *
 * ## The probes, and their limits
 *
 * Three requests, more with redirect hops. All of them GET, all of them
 * read-only, none of them authenticated:
 *
 *   1. The URL itself, following same-host redirects by hand.
 *   2. `{origin}{PROBE_PATH}`, a path that should not exist, to see what the
 *      server does with a path that does not exist. Followed the same way: a
 *      locale guard that answers `/x` with a 308 to `/en/x` is the common case,
 *      and stopping at the 308 would report "this site does not 404" about a site
 *      whose 404 is one hop away.
 *   3. The final URL again with `Accept: text/markdown`.
 *
 * **Probes never leave the host.** A redirect whose `Location` points at another
 * origin is recorded and not followed — an audit of example.com must not turn
 * into a request to whatever example.com points at.
 *
 * **`PROBE_PATH` is a constant, not a nonce.** Every finding here ships with the
 * `curl` line that produced it, and a reader who cannot re-run the exact request
 * cannot check our work. A random path would make each report's evidence
 * unreproducible the moment it was printed.
 *
 * **No renderer.** Same limit as every other module in this directory: a
 * redirect assembled at runtime by a framework router is invisible here, so a
 * finding is evidence and an absence of findings is not.
 */

import { load, type CheerioAPI } from "cheerio";
import {
  AGENT_HTTP_FACT,
  AGENT_HTTP_THRESHOLD,
  type CheckSource,
} from "./check-source";
import { tally, type Scorable } from "./scored-checks";
import { readableDocument } from "../visible-text";
import { validateUrl } from "../http-client";
import {
  couldNotRun,
  curl,
  land,
  MAX_HOPS,
  probe,
  unresolved,
  type Landing,
  type Probe,
} from "./agent-probe";
import { failure, success, type Result } from "../type-guards";

/**
 * The path we ask for in order to be told it does not exist.
 *
 * Deliberately self-describing: it names the product and says what it is, so an
 * operator reading their access log meets an explanation rather than a mystery.
 */
const PROBE_PATH = "/thatseoagent-probe-this-path-should-not-exist";

/**
 * The extracted-text ceiling, in approximate tokens.
 *
 * Ours, and marked as ours by {@link AGENT_HTTP_THRESHOLD}. Anchored to the
 * smallest context an agent is likely to give one page rather than to any
 * published limit, because no crawler operator publishes one: a page under this
 * survives a reader that budgets a quarter of a 128k window for a single source.
 */
const TOKEN_BUDGET = 30_000;

/** Characters per token, the usual English approximation. Named so the report can say so. */
const CHARS_PER_TOKEN = 4;

/**
 * How short a body has to be, in visible characters, before a script that assigns
 * to `location` reads as a redirect stub rather than as a page with a script on it.
 *
 * Ours, like every other number in this block, and named so the finding can quote
 * it back to the reader instead of asserting "near-empty" and leaving them to
 * guess what we measured.
 */
const STUB_BODY_CHARS = 200;

/** How much readable text a 404 needs before it counts as saying anything at all. Ours. */
const MIN_RECOVERY_BODY_CHARS = 40;

/** Statuses that mean "this path does not exist", which is the answer we want. */
const ABSENT_STATUSES = new Set([404, 410]);

/**
 * Routes a useful 404 body points at.
 *
 * Matched as substrings of the body's visible text and of its link targets, so a
 * 404 that links to `/sitemap.xml` and one that writes the word counts alike. The
 * list is short on purpose: these are the conventional entry points an agent
 * already knows to look for, and crediting anything link-shaped would credit a
 * site-wide nav bar, which every soft 404 has.
 */
const RECOVERY_ROUTES = ["sitemap", "llms.txt", "/docs", "openapi", "/api"];

/**
 * The `Link` relations that tell an agent where the machine-readable surface is.
 *
 * `service-desc` sits beside `service-doc` because RFC 8631 defines both and a site
 * that publishes an OpenAPI file typically uses the first: our own headers say
 * `rel="service-desc"` for `/openapi.json` and `rel="service-doc"` for the human
 * page. Accepting only one of the pair would have failed the exact convention it
 * was written to reward.
 */
const AGENT_LINK_RELS = ["sitemap", "describedby", "service-doc", "service-desc", "api-catalog"] as const;

/**
 * One check, with the request that produced it.
 *
 * `request` is the field that makes this tier different from the rest of the
 * product. A GEO finding is an argument; one of these is a claim about a
 * response, and a claim about a response that the reader cannot reproduce is a
 * claim they have to take on trust. Every check states the `curl` line, including
 * the ones that could not run — those especially, since "we could not find out"
 * is the case where someone will want to try it themselves.
 */
export interface AgentNavigabilityCheck extends Scorable {
  name: string;
  /** Required: the renderer prints it for every check, passing or not. */
  detail: string;
  /** The exact request, as a `curl` line the reader can paste. */
  request: string;
  /** Where this check gets its authority. See `check-source.ts`. */
  source: CheckSource;
}

export interface AgentNavigabilityResult {
  url: string;
  /** Where the URL ended up after same-host redirects. */
  finalUrl: string;
  checks: AgentNavigabilityCheck[];
  /** Earned over the scorable checks only. Never includes a check that did not run. */
  score: number;
  max: number;
  /** Points belonging to checks this site cannot owe. Reported, never scored. */
  notApplicable: number;
  /** Points belonging to checks that could not be evaluated on this run. */
  notEvaluated: number;
}

// ── Checks ────────────────────────────────────────────────────────────────────

function isMarkdown(headers: Headers): boolean {
  const type = headers.get("content-type")?.toLowerCase() ?? "";
  return type.includes("text/markdown") || type.includes("text/x-markdown");
}

/**
 * Visible text of an HTML body, or the body itself when it is not HTML.
 *
 * Takes an already-parsed document when the caller has one. `check404Body` needs
 * the same body for its text and for its links, and parsing it twice there (three
 * times, in the first draft) is a full clone of the tree per call.
 */
function readableText(body: string, contentType: string | null, parsed?: CheerioAPI): string {
  if (contentType && !contentType.toLowerCase().includes("html")) return body;
  return readableDocument(parsed ?? load(body)).allText();
}

function checkDistinct404(missing: Landing): AgentNavigabilityCheck {
  const probe404 = missing.probe;
  const followed = missing.hops.length > 0;
  const base = {
    name: "A path that does not exist returns 404",
    points: 20,
    request: curl(missing.requested, { followed }),
    source: AGENT_HTTP_FACT,
  };

  if (!probe404.ok) return couldNotRun(base, `the probe request failed — ${probe404.reason}`);

  if (missing.offHost) {
    // Not a zero, and not `notScored` either. The hop is a fact about the site, so
    // the sentence must not claim innocence on its behalf — but we never followed
    // it, so whether the path 404s is genuinely unknown and charging 20 points for
    // an unasked question is the thing ADR-0025 forbids.
    return {
      ...base,
      status: "not-evaluated",
      detail: `The probe path redirects to another host (${missing.offHost.location}), which this audit records and does not follow, so whether the path returns a 404 was never established. Not scored either way. Re-run the request above by hand to find out.`,
    };
  }

  // Said out loud whenever it happened, because it changes what the reader is
  // looking at: on a localized site the probe is answered by `/en/…`, not by the
  // path that was asked for, and a status reported without that context reads as
  // a fact about a URL nobody requested.
  const via = followed
    ? ` (after ${missing.hops.length} same-host redirect${missing.hops.length === 1 ? "" : "s"}, at ${missing.finalUrl})`
    : "";

  if (ABSENT_STATUSES.has(probe404.status)) {
    return {
      ...base,
      passed: true,
      detail: `HTTP ${probe404.status}${via}. An agent probing for a path can tell "not found" from "found".`,
    };
  }

  if (unresolved(probe404)) {
    return {
      ...base,
      passed: false,
      detail: `Still redirecting after ${MAX_HOPS} hops, last to ${probe404.headers.get("location") ?? "an unstated location"}. An agent following a missing path never arrives at an answer.`,
    };
  }

  if (probe404.status === 200) {
    return {
      ...base,
      passed: false,
      detail: `HTTP 200${via} on a path that should not exist — a soft 404. Every path an agent probes appears to exist, so it follows all of them and gets this same response back each time.`,
    };
  }

  return {
    ...base,
    passed: false,
    detail: `HTTP ${probe404.status}${via}. Neither a 404 nor a 200: an agent is told the request failed, not that the path is absent.`,
  };
}

function check404Body(missing: Landing): AgentNavigabilityCheck {
  const probe404 = missing.probe;
  const base = {
    name: "The 404 body says where to go instead",
    points: 10,
    // `body: true` — this check is a claim about what the body says, and a line
    // that discards the body cannot show the reader what we read.
    request: curl(missing.requested, { followed: missing.hops.length > 0, body: true }),
    // Not `AGENT_HTTP_FACT`: the body is a fact, but which entry points count as a
    // way back, and how much text counts as a body, are both ours.
    source: AGENT_HTTP_THRESHOLD,
  };

  if (!probe404.ok) return couldNotRun(base, `the probe request failed — ${probe404.reason}`);

  if (missing.offHost) {
    return {
      ...base,
      status: "not-evaluated",
      detail: `The probe path redirects to another host, which this audit does not follow, so there is no error body of this site's to read. Not scored either way.`,
    };
  }

  if (!ABSENT_STATUSES.has(probe404.status)) {
    // Structural, and already reported: the site has no 404 response for this
    // check to read. Scoring it zero would charge the same defect twice.
    return {
      ...base,
      status: "not-applicable",
      detail: `The site answered HTTP ${probe404.status} rather than 404, so there is no error body to read. The status itself is the finding above.`,
    };
  }

  // One parse, shared. Three `load()` calls on the same body was the first draft.
  const $ = load(probe404.body);
  const text = readableText(probe404.body, probe404.headers.get("content-type"), $).toLowerCase();
  const links = $("a[href]")
    .map((_, el) => $(el).attr("href") ?? "")
    .get()
    .join(" ")
    .toLowerCase();
  const named = RECOVERY_ROUTES.filter((route) => text.includes(route) || links.includes(route));

  if (named.length > 0) {
    return {
      ...base,
      passed: true,
      detail: `The body names ${named.join(", ")}, so an agent that hit a wall is told where the map is.`,
    };
  }

  if (text.trim().length >= MIN_RECOVERY_BODY_CHARS) {
    return {
      ...base,
      earned: 5,
      detail: `The body has text but names none of the conventional entry points (${RECOVERY_ROUTES.join(", ")}). Add one line listing them and a lost agent recovers instead of giving up.`,
    };
  }

  return {
    ...base,
    earned: 0,
    detail: `The 404 body has under ${MIN_RECOVERY_BODY_CHARS} characters of readable text. The status is right and the response says nothing an agent can act on.`,
  };
}

function checkRedirectHygiene(landing: Landing): AgentNavigabilityCheck {
  const base = {
    name: "Redirects happen in HTTP, not in JavaScript",
    points: 15,
    request: curl(landing.requested, { followed: landing.hops.length > 0, body: true }),
    // Not `AGENT_HTTP_FACT`: a `meta refresh` is a fact, but "a body this short
    // with a script that assigns to location is a redirect stub" is our threshold.
    source: AGENT_HTTP_THRESHOLD,
  };

  if (!landing.probe.ok) return couldNotRun(base, `the page could not be fetched — ${landing.probe.reason}`);

  const problems: string[] = [];

  const contentType = landing.probe.headers.get("content-type") ?? "";
  if (contentType.toLowerCase().includes("html")) {
    const $ = load(landing.probe.body);
    const refresh = $('meta[http-equiv="refresh" i]').attr("content");
    if (refresh) {
      problems.push(`a <meta http-equiv="refresh" content="${refresh}"> tag, which nothing that skips JavaScript and skips rendering will act on`);
    }

    const text = readableDocument($).allText().trim();
    const assignsLocation = $("script")
      .toArray()
      .some((el) => /location\s*(\.\s*(href|replace|assign)\s*[=(]|=)/.test($(el).html() ?? ""));
    if (assignsLocation && text.length < STUB_BODY_CHARS) {
      problems.push(
        `a near-empty body (${text.length} characters of text, under the ${STUB_BODY_CHARS} this check treats as a stub) whose script assigns to location — a non-rendering agent sees the stub, not the destination`,
      );
    }
  }

  if (landing.offHost) {
    problems.push(
      `a hop to another host (${landing.offHost.url} → ${landing.offHost.location}), which this audit records and does not follow`,
    );
  }

  if (unresolved(landing.probe)) {
    problems.push(
      `a chain still redirecting after ${MAX_HOPS} hops, so an agent following it never arrives`,
    );
  }

  if (problems.length > 0) {
    return { ...base, passed: false, detail: `Found ${problems.join("; and ")}.` };
  }

  const hopNote = landing.hops.length === 0
    ? "no redirects"
    : `${landing.hops.length} same-host HTTP redirect${landing.hops.length === 1 ? "" : "s"}`;
  return {
    ...base,
    passed: true,
    detail: `${hopNote}, no meta refresh and no JavaScript-only redirect stub. An agent that does not run scripts reaches the same page a browser does.`,
  };
}

function checkMarkdownVariant(md: Probe, landing: Landing): AgentNavigabilityCheck {
  const base = {
    name: "Accept: text/markdown returns markdown",
    points: 10,
    request: curl(md.url, { accept: "text/markdown", body: true }),
    source: AGENT_HTTP_FACT,
  };

  if (!md.ok) return couldNotRun(base, `the negotiated request failed — ${md.reason}`);

  if (!isMarkdown(md.headers)) {
    return {
      ...base,
      passed: false,
      detail: `The server answered ${md.headers.get("content-type") ?? "no content type"}. An agent asking for markdown gets HTML and has to strip the chrome itself, which is where content gets lost.`,
    };
  }

  // A URL that serves markdown to everyone answers both probes with the same
  // bytes, and that is a pass: the agent asked for markdown and got markdown.
  // Comparing bodies without checking what the default response was reported
  // every `.md` path and every `app/api/md/**` route as a mislabelled payload —
  // the in-house customer #387 named, failed by the check written for it.
  const defaultWasMarkdown = landing.probe.ok && isMarkdown(landing.probe.headers);
  if (md.body === (landing.probe.ok ? landing.probe.body : "") && !defaultWasMarkdown) {
    return {
      ...base,
      passed: false,
      detail:
        "The content type says text/markdown and the body is byte-identical to the HTML response. The header is a label on the wrong payload.",
    };
  }

  return {
    ...base,
    passed: true,
    detail: defaultWasMarkdown
      ? `The server answered ${md.headers.get("content-type")} — ${md.body.length} characters of markdown, and it serves markdown to an unnegotiated request too.`
      : `The server answered ${md.headers.get("content-type")} with a different body to the HTML one — ${md.body.length} characters of markdown.`,
  };
}

function checkVaryAccept(md: Probe, landing: Landing, servesMarkdown: boolean): AgentNavigabilityCheck {
  const base = {
    name: "Vary: Accept on the negotiated response",
    points: 10,
    request: curl(md.url, { accept: "text/markdown" }),
    source: AGENT_HTTP_FACT,
  };

  if (!md.ok) return couldNotRun(base, `the negotiated request failed — ${md.reason}`);

  // One representation for everyone is not negotiation, so there is nothing for a
  // cache to get wrong. Read off the responses rather than off the check's verdict:
  // a markdown-only URL passes the check above while owing no `Vary` at all.
  const oneRepresentation =
    !servesMarkdown || (landing.probe.ok && isMarkdown(landing.probe.headers));

  if (oneRepresentation) {
    return {
      ...base,
      status: "not-applicable",
      detail: servesMarkdown
        ? "The URL serves markdown whether or not it is asked to, so there is only one representation and nothing for a cache to vary on."
        : "The URL serves one representation, so there is nothing for a cache to vary on. This becomes a real requirement the day the site answers Accept: text/markdown with markdown.",
    };
  }

  const vary = md.headers.get("vary") ?? "";
  const varies = vary
    .split(",")
    .map((token) => token.trim().toLowerCase())
    .includes("accept");

  return varies
    ? { ...base, passed: true, detail: `Vary: ${vary}. A cache keeps the two representations apart.` }
    : {
        ...base,
        passed: false,
        detail: `The URL serves two representations and the response says ${vary ? `Vary: ${vary}` : "no Vary header"}. Under cache pressure a CDN can hand the HTML to an agent that asked for markdown, or the reverse, depending on which variant landed in the cache first — a bug that is invisible to a single request.`,
      };
}

function checkTokenBudget(landing: Landing): AgentNavigabilityCheck {
  const base = {
    name: "The page fits an agent's reading budget",
    points: 10,
    request: curl(landing.requested, { followed: landing.hops.length > 0, body: true }),
    source: AGENT_HTTP_THRESHOLD,
  };

  if (!landing.probe.ok) return couldNotRun(base, `the page could not be fetched — ${landing.probe.reason}`);

  if (landing.probe.status !== 200) {
    return couldNotRun(
      base,
      `the URL answered HTTP ${landing.probe.status}, so the body measured would be an error page rather than the page`,
    );
  }

  const text = readableText(landing.probe.body, landing.probe.headers.get("content-type"));
  const tokens = Math.ceil(text.length / CHARS_PER_TOKEN);
  const measured = `${text.length} characters of extracted text, about ${tokens.toLocaleString("en-US")} tokens at ${CHARS_PER_TOKEN} characters each`;

  return tokens <= TOKEN_BUDGET
    ? {
        ...base,
        passed: true,
        detail: `${measured} — inside the ${TOKEN_BUDGET.toLocaleString("en-US")}-token threshold this check uses.`,
      }
    : {
        ...base,
        passed: false,
        detail: `${measured}, past the ${TOKEN_BUDGET.toLocaleString("en-US")}-token threshold this check uses. An agent that truncates does not say so: it answers from the first half and the tail is silently lost. Split the page, or publish the sections separately.`,
      };
}

function checkCodeFences(md: Probe, servesMarkdown: boolean): AgentNavigabilityCheck {
  const base = {
    name: "Code fences in the served markdown are balanced",
    points: 5,
    request: curl(md.url, { accept: "text/markdown", body: true }),
    source: AGENT_HTTP_FACT,
  };

  if (!md.ok) return couldNotRun(base, `the negotiated request failed — ${md.reason}`);

  if (!servesMarkdown) {
    return {
      ...base,
      status: "not-applicable",
      detail: "The URL serves no markdown variant, so there is no markdown to parse.",
    };
  }

  const fences = md.body.split("\n").filter((line) => /^\s{0,3}(```|~~~)/.test(line)).length;

  return fences % 2 === 0
    ? {
        ...base,
        passed: true,
        detail: `${fences} fence line${fences === 1 ? "" : "s"}, an even count. Every code block closes.`,
      }
    : {
        ...base,
        passed: false,
        detail: `${fences} fence lines, an odd count: one block never closes. CommonMark treats everything after an unclosed fence as code, so a parsing agent silently loses the rest of the document.`,
      };
}

function checkAgentLinkHeaders(landing: Landing): AgentNavigabilityCheck {
  const base = {
    /**
     * Informational, worth nothing, and that is the finding about this check
     * rather than about the sites it runs on.
     *
     * It was scored out of 8 until a sweep of six third-party sites — Stripe,
     * es.wikipedia, wordpress.org, MDN, Airbnb, nextjs.org — returned 0 of 4 on
     * every one of them while thatseoagent.com returned 4 of 4. The parser was
     * right; the practice is simply ours. A check nobody but its author passes
     * does not measure a site, it measures how much the site resembles us, and
     * charging eight points for that would have buried the soft-404 finding
     * underneath a recommendation no peer follows.
     *
     * #387 filed this as a "Bonus", and #389 states the rule for the whole class
     * of emerging artifacts: absence must never lower a score. So the fact is
     * still reported, with the same request beside it — it is simply not priced.
     */
    points: 0,
    name: "Link headers advertise the machine-readable surface (informational)",
    request: curl(landing.requested, { followed: landing.hops.length > 0 }),
    source: AGENT_HTTP_FACT,
  };

  if (!landing.probe.ok) return couldNotRun(base, `the page could not be fetched — ${landing.probe.reason}`);

  if (unresolved(landing.probe)) {
    return couldNotRun(
      base,
      `the chain was still redirecting after ${MAX_HOPS} hops, so the headers read would belong to a redirect rather than to the page`,
    );
  }

  const header = landing.probe.headers.get("link") ?? "";
  const found = AGENT_LINK_RELS.filter((rel) =>
    new RegExp(`rel\\s*=\\s*"?[^",]*\\b${rel}\\b`, "i").test(header),
  );
  const missing = AGENT_LINK_RELS.filter((rel) => !found.includes(rel));

  return {
    ...base,
    passed: found.length > 0,
    detail: found.length > 0
      ? `Advertised: ${found.join(", ")}${missing.length ? `. Not advertised: ${missing.join(", ")}` : ""}. An agent learns where these are from the response headers alone, before parsing anything.`
      : `No RFC 8288 Link relation among ${AGENT_LINK_RELS.join(", ")}. Adding them lets an agent find the sitemap and the API description without fetching and parsing the page first. Not scored: few sites do this today, so its absence is not counted against you.`,
  };
}

// ── Entry point ───────────────────────────────────────────────────────────────

/**
 * Audit the HTTP facts that decide whether an agent can navigate a site.
 *
 * The order of the probes is the order of the dependencies: the landing response
 * settles the final URL, the final URL's origin settles where to probe for a 404,
 * and the final URL is what gets asked for markdown. Three requests, plus one per
 * same-host redirect hop.
 */
export async function auditAgentNavigability(
  url: string,
): Promise<Result<AgentNavigabilityResult>> {
  try {
    validateUrl(url);

    const landing = await land(url);
    const origin = new URL(landing.finalUrl).origin;

    // Both wait on `land`, because both target the URL the chain landed on rather
    // than the one that was typed. Once that is known they are independent.
    // The probe path is landed too, not fetched once. A locale guard that answers
    // `/x` with a 308 to `/en/x` is the common case, and stopping at the 308 would
    // report "this site does not 404" about a site whose 404 is one hop away —
    // which is exactly what auditing our own production site turned up.
    const [missing, md] = await Promise.all([
      land(`${origin}${PROBE_PATH}`),
      probe(landing.finalUrl, "text/markdown"),
    ]);

    const variant = checkMarkdownVariant(md, landing);
    // The gate for the two checks below, read off the check rather than recomputed,
    // so a site can never be told it serves markdown by one check and not by another.
    const servesMarkdown = variant.passed === true;

    const checks: AgentNavigabilityCheck[] = [
      checkDistinct404(missing),
      check404Body(missing),
      checkRedirectHygiene(landing),
      variant,
      checkVaryAccept(md, landing, servesMarkdown),
      checkTokenBudget(landing),
      checkCodeFences(md, servesMarkdown),
      checkAgentLinkHeaders(landing),
    ];

    const { score, max, notApplicable, notEvaluated } = tally(checks);

    return success({
      url,
      finalUrl: landing.finalUrl,
      checks,
      score,
      max,
      notApplicable,
      notEvaluated,
    });
  } catch (error) {
    return failure(error instanceof Error ? error : new Error(String(error)));
  }
}
