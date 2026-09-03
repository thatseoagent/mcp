/**
 * The well-known files an agent reads before it does anything else — and whether
 * they say what they claim to say.
 *
 * The third tier of #386, specified in #389. The asymmetry that made it worth
 * building is the point: **we already publish most of these and had no way to
 * check any of them.** `lib/seo/agent-entry-points.ts` serves our OpenAPI spec and
 * our MCP server card, `lib/agent-skills/sign.ts` signs our skills index,
 * `lib/web-bot-auth/sign.ts` signs requests per RFC 9421 — every one of those is a
 * *producer*, and there was no consumer that audited the same artifact on anyone
 * else's domain. `auth.md` appeared nowhere in `lib/` at all. A third-party scan
 * found six defects in files we wrote.
 *
 * ## The rule that shapes everything here
 *
 * **This tier only ever adds.** A site with none of these artifacts scores +0 and
 * is not penalised, because these are emerging formats and a scored penalty would
 * be a claim we cannot support. An artifact that is absent is `not-applicable`; an
 * artifact that is *present and malformed* earns less of the bonus than a correct
 * one would, which is not the same thing as losing points a site never had.
 *
 * ## Validate the payload, not the status
 *
 * Every defect the scan found on us was a 200 response with a structurally
 * incomplete body. A checker that asserts reachability finds none of them. So each
 * check here parses the document and names the fields that are missing, verifies
 * a digest against the bytes it advertises, and — for the auth chain — walks from
 * one document to the next and reports where the walk stops.
 *
 * See `docs/agent-discovery.md` for what these checks may claim, and ADR-0025 for
 * the axis. Read-only, unauthenticated, same-site: rules 6 and 7 of that ADR.
 */

import { createHash } from "node:crypto";
import { getDomain } from "tldts";
import { AGENT_HTTP_FACT, AGENT_HTTP_THRESHOLD, type CheckSource } from "./check-source";
import { tally, type Scorable } from "./scored-checks";
import { validateUrl } from "../http-client";
import { couldNotRun, curl, disallowed, land, probe, type Landing, type Probe } from "./agent-probe";
import { failure, success, type Result } from "../type-guards";

/**
 * The most this whole tier can add.
 *
 * Five, matching the cap the scanner that prompted #389 uses, and kept for the
 * reason #389 gives: "absence never lowers a score; that framing is correct and we
 * should keep it". The number is ours and the check that reports it says so.
 */
const MAX_BONUS = 5;

/** How many skill entries have their digest verified against the bytes. */
const MAX_DIGESTS_VERIFIED = 5;

/** How much readable text a published markdown document needs to count as written. Ours. */
const MIN_MARKDOWN_CHARS = 200;

const PATHS = {
  serverCard: "/.well-known/mcp/server-card.json",
  mcpDiscovery: "/.well-known/mcp",
  protectedResource: "/.well-known/oauth-protected-resource",
  authorizationServer: "/.well-known/oauth-authorization-server",
  authMd: "/auth.md",
  skills: "/.well-known/agent-skills/index.json",
  apiCatalog: "/.well-known/api-catalog",
  signatures: "/.well-known/http-message-signatures-directory",
  pricingMd: "/pricing.md",
  llmsTxt: "/llms.txt",
} as const;

/**
 * The seven sections of the `auth.md` specification.
 *
 * Matched against heading text, lower-cased, by the distinctive word rather than
 * the whole phrase: authors write "## Register a client" and "## Registration",
 * and a check that demanded the spec's exact wording would report a missing
 * section about a document that has it.
 */
const AUTH_SECTIONS = [
  { name: "Discover", matches: ["discover"] },
  { name: "Pick a method", matches: ["pick a method", "choose a method", "authentication method", "auth method"] },
  { name: "Register", matches: ["register", "registration"] },
  { name: "Claim", matches: ["claim"] },
  { name: "Use the credential", matches: ["use the credential", "use your credential", "using the credential", "use the token", "using your token"] },
  { name: "Errors", matches: ["error"] },
  { name: "Revocation", matches: ["revoke", "revocation"] },
];

export interface DiscoveryCheck extends Scorable {
  name: string;
  /** Required: the renderer prints it for every check, passing or not. */
  detail: string;
  /** The exact request, as a `curl` line the reader can paste. */
  request: string;
  source: CheckSource;
}

export interface AgentDiscoveryResult {
  url: string;
  checks: DiscoveryCheck[];
  /**
   * What this tier adds, out of {@link MAX_BONUS}. Never negative, never a penalty.
   *
   * Absent artifacts are in the denominator and earn nothing, which is what a
   * bonus is. A site with none of them gets +0, and +0 is exactly what it would
   * have had if this tier did not exist.
   */
  bonus: number;
  maxBonus: number;
  /** Of the artifacts the site DOES publish, how much of their structure is right. */
  quality: { score: number; max: number };
  notApplicable: number;
  notEvaluated: number;
}

// ── Reading documents ─────────────────────────────────────────────────────────

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

type Base = { name: string; points: number; request: string; source: CheckSource };

function baseFor(name: string, points: number, url: string, source: CheckSource = AGENT_HTTP_FACT): Base {
  return { name, points, request: curl(url, { body: true }), source };
}

/**
 * The three ways an artifact fails to be measurable, in the one order they must
 * be tested.
 *
 * `absent` before anything else, because it is the state this tier exists to
 * treat gently: a 404 on `/auth.md` is not a defect, it is a site that has not
 * adopted an emerging format. Returning `null` means "the document is here and
 * parsed, carry on".
 */
function unmeasurable(base: Base, response: Probe): DiscoveryCheck | null {
  if (!response.ok) {
    return response.blockedByRobots
      ? disallowed(base, response.url)
      : couldNotRun(base, `the request failed — ${response.reason}`);
  }
  if (response.status === 404 || response.status === 410) {
    return {
      ...base,
      status: "not-applicable",
      detail: `Not published (HTTP ${response.status}). This tier only ever adds: not having this artifact costs nothing, and publishing a correct one would add to the bonus.`,
    };
  }
  if (response.status >= 300 && response.status < 400) {
    return couldNotRun(base, `the request answered HTTP ${response.status} and this audit does not follow a redirect to a well-known document, so none was read`);
  }
  if (response.status > 200 && response.status < 300) {
    // 204 and friends: the request succeeded and there is no document in it.
    return couldNotRun(base, `the request answered HTTP ${response.status}, which carries no document`);
  }
  if (response.status >= 400) {
    // Not `not-applicable`: 404 and 410 are the two statuses that mean "not
    // published", and they were handled above. A 401 or a 500 means the document
    // may well exist and we did not read it, which is a different sentence.
    return couldNotRun(base, `the request answered HTTP ${response.status}, so no document was read`);
  }
  return null;
}

/** A JSON document, or the reason it is not one. */
function parsed(response: Extract<Probe, { ok: true }>): Record<string, unknown> | null {
  try {
    const doc: unknown = JSON.parse(response.body);
    return isRecord(doc) ? doc : null;
  } catch {
    return null;
  }
}

/**
 * A present-but-malformed artifact.
 *
 * Zero earned, full points still on the table — the distinction from `absent`,
 * which leaves both sides. A document that answered 200 and is not the document it
 * claims to be is the class of defect this tier was written for.
 */
function malformed(base: Base, detail: string): DiscoveryCheck {
  return { ...base, earned: 0, detail };
}

/**
 * The shared shape of a JSON artifact check: is it measurable, is it JSON, judge it.
 *
 * Six checks repeated this preamble, each with its own unchecked cast back to the
 * successful branch of `Probe` — a cast that only existed because `unmeasurable`
 * returns `Check | null` and throws away the narrowing it just proved. One helper
 * removes six copies and all six casts.
 */
function jsonArtifact(
  base: Base,
  response: Probe,
  judge: (doc: Record<string, unknown>, ok: Extract<Probe, { ok: true }>) => DiscoveryCheck,
): DiscoveryCheck {
  const blocked = unmeasurable(base, response);
  if (blocked) return blocked;

  // `unmeasurable` returned null, so the response is a 200. Narrowed here once
  // rather than asserted at six call sites.
  if (!response.ok) return couldNotRun(base, `the request failed — ${response.reason}`);
  const doc = parsed(response);
  if (!doc) {
    return malformed(base, `The document answered HTTP ${response.status} and its body is not a JSON object. An agent that fetched it has nothing to read.`);
  }
  return judge(doc, response);
}

/**
 * A check whose verdict is a list of defects against a count of things that can
 * go wrong.
 *
 * `total` is ours in every case — it is how many buckets we decided to divide the
 * artifact into — which is why every caller of this passes
 * {@link AGENT_HTTP_THRESHOLD} as its source.
 */
function problemsCheck(base: Base, problems: readonly string[], total: number, clean: string): DiscoveryCheck {
  if (problems.length === 0) return { ...base, passed: true, detail: clean };
  return fractionCheck(
    base,
    { met: Math.max(0, total - problems.length), total, missing: [...problems] },
    (_met, _total, miss) => `Found: ${miss.join("; and ")}.`,
  );
}

/** Fields a document declares, and the ones it does not. */
function requiredFields(
  doc: Record<string, unknown>,
  fields: readonly string[],
): { met: number; total: number; missing: string[] } {
  const missing = fields.filter((field) => doc[field] === undefined || doc[field] === null || doc[field] === "");
  return { met: fields.length - missing.length, total: fields.length, missing };
}

function fractionCheck(
  base: Base,
  { met, total, missing }: { met: number; total: number; missing: string[] },
  say: (met: number, total: number, missing: readonly string[]) => string,
): DiscoveryCheck {
  return {
    ...base,
    earned: Math.round((base.points * met) / total),
    passed: met === total,
    detail: say(met, total, missing),
  };
}

// ── The artifacts ─────────────────────────────────────────────────────────────

function checkServerCard(response: Probe, url: string): DiscoveryCheck {
  const base = baseFor("MCP server card is complete", 10, url);
  return jsonArtifact(base, response, (doc) => {
  // `url` as well as `serverUrl`: the MCP card schema has used both spellings, and
  // failing a card for the field name its own schema version asked for would be a
  // finding about our reading rather than about the document.
  const hasEndpoint = doc.serverUrl !== undefined || doc.url !== undefined || isRecord(doc.remotes) || Array.isArray(doc.remotes);
  const fields = requiredFields(doc, ["name", "description", "version"]);
  const missing = [...fields.missing];
  if (!hasEndpoint) missing.push("serverUrl");
  const hasTools = Array.isArray(doc.tools) && doc.tools.length > 0;
  if (!hasTools) missing.push("tools[]");

  const total = 5;
  const met = total - missing.length;
  return fractionCheck(base, { met, total, missing }, (m, t, miss) =>
    miss.length === 0
      ? `All ${t} fields present, and ${Array.isArray(doc.tools) ? doc.tools.length : 0} tools listed. An agent can decide whether to connect without connecting first.`
      : `${m}/${t} fields present. Missing: ${miss.join(", ")}. The card answered 200, so a checker that asserted reachability would have called this fine.`,
  );
  });
}

function checkMcpDiscoverable(card: Probe, wellKnown: Probe, llms: Probe | null, origin: string): DiscoveryCheck {
  const base = baseFor("The MCP server can be found without being told where it is", 5, `${origin}${PATHS.serverCard}`);

  const routes: string[] = [];
  if (card.ok && card.status === 200) routes.push(`a server card at ${PATHS.serverCard}`);
  if (wellKnown.ok && wellKnown.status === 200) routes.push(`a response at ${PATHS.mcpDiscovery}`);
  if (llms?.ok && llms.status === 200 && advertisesMcp(llms)) routes.push("a reference in /llms.txt");

  // Absence here is absence of an MCP server, which is not a defect — the same
  // rule as every other row in this tier.
  if (routes.length === 0) {
    return {
      ...base,
      status: "not-applicable",
      detail: `No MCP server advertised at ${PATHS.serverCard}, ${PATHS.mcpDiscovery} or in /llms.txt. Not having one costs nothing.`,
    };
  }

  return { ...base, passed: true, detail: `Found via ${routes.join(", and ")}. An agent does not need the URL handed to it.` };
}

/**
 * An `llms.txt` that points at an MCP server, as opposed to one that mentions the
 * protocol.
 *
 * wordpress.org's llms.txt says WordPress "provides first-class support for …​ the
 * Model Context Protocol (MCP)" and links to a news article about an adapter. That
 * is prose about an ecosystem, not a way for an agent to find *this site's*
 * server, and crediting it reported a discovery route wordpress.org does not have.
 *
 * So the reference has to be addressable: a URL with an `mcp` path segment, or one
 * on an `mcp.` host, which are the two conventions in use. A markdown body that is
 * actually HTML is refused outright — a soft-404 shell is not an llms.txt.
 */
function advertisesMcp(llms: Extract<Probe, { ok: true }>): boolean {
  const type = llms.headers.get("content-type")?.toLowerCase() ?? "";
  if (type.includes("html")) return false;
  return /https?:\/\/mcp\.[^\s)]+/i.test(llms.body) || /(?:https?:\/\/[^\s)]*)?\/mcp(?:[/?#\s)]|$)/im.test(llms.body);
}

function checkMcpEndpoint(endpointProbe: Probe | null, endpoint: string | null): DiscoveryCheck {
  const base = baseFor("The MCP endpoint answers a machine-readable response", 5, endpoint ?? "");

  if (!endpoint || !endpointProbe) {
    return {
      ...base,
      status: "not-applicable",
      detail: "No MCP endpoint was advertised, so there was nothing to reach.",
      request: "n/a — no endpoint advertised",
    };
  }

  // Deliberately not routed through `unmeasurable`: for every other artifact a
  // non-2xx means no document was read, and here a 401 is the *right* answer — a
  // protected server refusing in a shape an agent can parse. Only the transport
  // failures and an outright 404 are settled before the body is looked at.
  if (!endpointProbe.ok) {
    return endpointProbe.blockedByRobots
      ? disallowed(base, endpointProbe.url)
      : couldNotRun(base, `the request failed — ${endpointProbe.reason}`);
  }
  if (endpointProbe.status === 404 || endpointProbe.status === 410) {
    // A 404 on an advertised endpoint is a real defect, not an absent artifact:
    // the card promised something that is not there.
    return malformed(base, `The card advertises ${endpoint} and a GET there answers HTTP ${endpointProbe.status}. An agent that trusted the card would find nothing.`);
  }
  if (endpointProbe.status >= 300 && endpointProbe.status < 400) {
    return couldNotRun(base, `the endpoint answered HTTP ${endpointProbe.status} and this audit does not follow it, so no response body was read`);
  }

  const ok = endpointProbe as Extract<Probe, { ok: true }>;
  const type = ok.headers.get("content-type")?.toLowerCase() ?? "";
  const isJson = type.includes("json");

  // 401 is a pass here and says so. A protected server answering a structured
  // refusal is doing the right thing; the check is about the shape, not the access.
  if (isJson && parsed(ok)) {
    // #389 asks whether "the server is protected and whether OAuth metadata
    // discovery works". RFC 9728 answers it in one header: a 401 that carries
    // `WWW-Authenticate: Bearer resource_metadata="…"` hands an agent the next
    // document instead of leaving it to guess the well-known path.
    const challenge = ok.headers.get("www-authenticate") ?? "";
    const pointsAtMetadata = /resource_metadata\s*=/i.test(challenge);
    const protectedNote =
      ok.status === 401 || ok.status === 403
        ? pointsAtMetadata
          ? " — protected, and the challenge names its resource metadata, so discovery works from the endpoint alone"
          : " — protected, and the challenge carries no `resource_metadata`, so an agent has to guess where the OAuth metadata lives (RFC 9728 §5.1)"
        : "";
    return {
      ...base,
      // Protected-without-a-pointer is a real gap, and a small one: the endpoint
      // still answered something parseable, which is what this check is named for.
      ...(protectedNote && !pointsAtMetadata ? { earned: base.points - 1 } : { passed: true }),
      detail: `HTTP ${ok.status} with a JSON body${protectedNote}. This is a read-only GET; the JSON-RPC surface itself is not exercised.`,
    };
  }

  return malformed(
    base,
    `HTTP ${ok.status} answered ${type || "no content type"}${isJson ? " and a body that did not parse" : ""}. An agent that follows the card gets something it cannot parse.`,
  );
}

function checkProtectedResource(response: Probe, url: string): DiscoveryCheck {
  const base = baseFor("OAuth protected-resource metadata is complete (RFC 9728)", 10, url);
  return jsonArtifact(base, response, (doc) =>
    fractionCheck(
    base,
    requiredFields(doc, ["resource", "authorization_servers", "scopes_supported", "bearer_methods_supported"]),
    (met, total, missing) =>
      missing.length === 0
        ? `All ${total} RFC 9728 fields present. An agent knows which authorization server guards this resource and how to present a token.`
        : `${met}/${total} RFC 9728 fields present. Missing: ${missing.join(", ")}.`,
    ),
  );
}

function checkAuthorizationServer(response: Probe | null, url: string, offSite: string | null): DiscoveryCheck {
  const base = baseFor("OAuth authorization-server metadata is complete (RFC 8414)", 10, url);
  if (offSite) {
    return couldNotRun(
      base,
      `the resource points its authorization server at ${new URL(offSite).host}, a different registrable domain to the site being audited, and this audit does not fetch third parties on a document's say-so`,
    );
  }
  if (!response) return couldNotRun(base, "there was no authorization server document to read");
  return jsonArtifact(base, response, (doc) => {
  const fields = requiredFields(doc, ["issuer", "authorization_endpoint", "token_endpoint"]);
  const methods = doc.code_challenge_methods_supported;
  const pkce = Array.isArray(methods) && methods.includes("S256");
  const missing = [...fields.missing];
  if (!pkce) missing.push("code_challenge_methods_supported: S256");

  const total = 4;
  return fractionCheck(base, { met: total - missing.length, total, missing }, (met, t, miss) =>
    miss.length === 0
      ? `All three RFC 8414 endpoints present, and PKCE S256 is offered. A public client can complete a code flow without a secret.`
      : `${met}/${t} present. Missing: ${miss.join(", ")}.${pkce ? "" : " Without S256 a public client has no safe way to complete a code flow."}`,
  );
  });
}

/**
 * The traversal, which is the check #389 says matters most.
 *
 * "Each file can be individually valid and the path still broken — which is
 * exactly what happened to us." So this walks it and reports the step it stopped
 * at, rather than passing a verdict on the set.
 *
 * It starts where #389 says an agent starts — "an agent starting at `auth.md`
 * should reach the registration endpoint by following links" — so `auth.md` is
 * step 0 when it exists, and the walk records whether it actually points onward
 * rather than merely existing. A site with no `auth.md` is not penalised for it:
 * the walk simply begins at the protected-resource metadata and says so.
 */
function checkAuthChain(
  prm: Probe,
  asProbe: Probe | null,
  asUrl: string | null,
  declared: string | null,
  offSite: string | null,
  authMd: Probe,
): DiscoveryCheck {
  const base = baseFor("The auth discovery chain can be walked end to end", 15, asUrl ?? prm.url);
  const blocked = unmeasurable(base, prm);
  if (blocked) {
    // No protected-resource metadata means no chain to walk, which is the absent
    // case rather than a broken one.
    return blocked.status === "not-applicable"
      ? { ...blocked, detail: "No protected-resource metadata, so there is no discovery chain to walk. Not a defect." }
      : blocked;
  }

  const prmDoc = parsed(prm as Extract<Probe, { ok: true }>);
  const steps: string[] = [];

  // Step 0. Present and pointing onward, or present and a dead end — those are
  // different findings, and the second is the one an agent trips over.
  if (authMd.ok && authMd.status === 200) {
    steps.push(
      /(?:\.well-known|oauth|mcp|register)/i.test(authMd.body)
        ? "auth.md (links onward)"
        : "auth.md (mentions no discovery document — an agent starting here has to guess)",
    );
  }
  steps.push("protected-resource metadata");

  if (!prmDoc) return malformed(base, "The walk stops at the protected-resource metadata: it is not a JSON object.");
  if (!declared) {
    return malformed(base, "The walk stops at the protected-resource metadata: it declares no `authorization_servers`, so an agent has nowhere to go next.");
  }
  steps.push(`authorization_servers[0] → ${declared}`);

  if (offSite) {
    // Not a defect of the site's, and not a pass either: we chose not to look.
    return couldNotRun(
      base,
      `the chain leaves for ${new URL(offSite).host}, a different registrable domain, and this audit does not follow a document's pointer to a third party. Everything up to that hop resolved: ${steps.join(" → ")}`,
    );
  }

  if (!asProbe || !asProbe.ok || asProbe.status !== 200) {
    const what = !asProbe || !asProbe.ok ? "could not be fetched" : `answered HTTP ${asProbe.status}`;
    return malformed(base, `The walk stops at the authorization server: ${asUrl} ${what}. Each document before it is valid and the path is still broken.`);
  }

  const asDoc = parsed(asProbe);
  if (!asDoc) return malformed(base, `The walk stops at the authorization server: ${asUrl} answered 200 and is not a JSON object.`);
  steps.push("authorization-server metadata");

  const problems: string[] = [];
  // The cross-reference #389 asks for: "an AS origin absent from the PRM
  // `authorization_servers` list is the class of bug this tier exists to catch".
  const issuer = typeof asDoc.issuer === "string" ? asDoc.issuer : null;
  if (issuer && !sameOrigin(issuer, declared)) {
    problems.push(`the server's \`issuer\` (${issuer}) is not the origin the resource pointed at (${declared})`);
  }
  const registration =
    typeof asDoc.registration_endpoint === "string"
      ? asDoc.registration_endpoint
      : asDoc.client_id_metadata_document_supported === true
        ? "client ID metadata documents (no registration call needed)"
        : null;
  if (!registration) {
    problems.push("the server offers neither a `registration_endpoint` nor client ID metadata documents, so a new agent has no way to become a client");
  }

  if (problems.length > 0) {
    return fractionCheck(base, { met: 2, total: 3, missing: problems }, (_met, _total, miss) =>
      `The documents resolve (${steps.join(" → ")}) and the chain does not close: ${miss.join("; and ")}.`,
    );
  }

  steps.push(registration!);
  return { ...base, passed: true, detail: `Walked end to end: ${steps.join(" → ")}. An agent starting at the first of those reaches a way to become a client without a dead end.` };
}

function sameOrigin(a: string, b: string): boolean {
  try {
    return new URL(a).origin === new URL(b).origin;
  } catch {
    return false;
  }
}

/**
 * The only host other than the audited one this tier will fetch from.
 *
 * A site's protected-resource metadata names its own authorization server, and
 * for a real deployment that is often `auth.example.com` or an identity provider
 * on a subdomain. Refusing to follow it at all would make the traversal check
 * useless on every site that separates the two. Following it *anywhere* would
 * mean a document on example.com could aim our request at `tenant.auth0.com` —
 * a third party we were never asked to audit, whose response we would then report
 * as the site's, under a `curl` line pointing at someone else's server.
 *
 * eTLD+1 is the line that admits the first and refuses the second, and it is the
 * same boundary and the same unit the API tier uses for a spec's declared
 * `servers` (ADR-0025 rule 6).
 */
function sameSite(a: string, b: string): boolean {
  try {
    const domainA = getDomain(new URL(a).hostname);
    const domainB = getDomain(new URL(b).hostname);
    return domainA !== null && domainA === domainB;
  } catch {
    return false;
  }
}

function checkAuthMd(response: Probe, url: string): DiscoveryCheck {
  const base = baseFor("auth.md covers the sections the draft lists", 10, url, AGENT_HTTP_THRESHOLD);
  const blocked = unmeasurable(base, response);
  if (blocked) return blocked;

  const ok = response as Extract<Probe, { ok: true }>;
  const type = ok.headers.get("content-type")?.toLowerCase() ?? "";
  const headings = ok.body
    .split("\n")
    .filter((line) => /^#{1,3}\s/.test(line))
    .map((line) => line.replace(/^#+\s*/, "").toLowerCase());
  const found = AUTH_SECTIONS.filter((section) =>
    section.matches.some((needle) => headings.some((heading) => heading.includes(needle))),
  );
  const missing = AUTH_SECTIONS.filter((section) => !found.includes(section)).map((section) => section.name);

  // The content type is part of the artifact, not a nicety: an agent that asked
  // for auth.md and got text/html has to guess whether it found the document.
  const servedAsMarkdown = type.includes("markdown");
  const total = AUTH_SECTIONS.length + 1;
  const met = found.length + (servedAsMarkdown ? 1 : 0);

  // Reported as "N of 7 sections, and the content type", never as the internal
  // fraction: "2/8" tells a reader about our arithmetic rather than their file.
  const sections = `${found.length} of ${AUTH_SECTIONS.length} sections`;
  const typeNote = servedAsMarkdown
    ? "served as text/markdown"
    : `served as ${type || "no content type"} rather than text/markdown`;

  return fractionCheck(base, { met, total, missing }, (_m, _t, miss) =>
    miss.length === 0 && servedAsMarkdown
      ? `All ${AUTH_SECTIONS.length} sections present, ${typeNote}. The list is the WorkOS auth.md draft's, and requiring a heading rather than a passing mention is our reading of that draft, not a published requirement.`
      : `${sections} found, ${typeNote}.${miss.length ? ` Missing: ${miss.join(", ")}.` : ""} Sections are matched by heading: the list is the WorkOS auth.md draft's, and requiring a heading rather than a passing mention is our reading of that draft, not a published requirement.`,
  );
}

/**
 * Three outcomes, because two conflated the finding with its absence.
 *
 * `mismatched` is the defect #389 is after: bytes we hashed disagree with the
 * digest advertised for them. `unverifiable` is a skill we never fetched — it is
 * off-site, robots disallows it, the request failed. Folding the second into the
 * first says "this digest does not match the bytes served" about bytes nobody
 * read, which is the same not-evaluated/failure conflation ADR-0025 rule 8 exists
 * to stop. Only `mismatched` costs points.
 */
type SkillDigest =
  | { outcome: "verified"; name: string; url: string }
  | { outcome: "mismatched"; name: string; url: string; reason: string }
  | { outcome: "unverifiable"; name: string; url: string; reason: string };

function checkSkillsIndex(response: Probe, url: string, digests: SkillDigest[], capped: number): DiscoveryCheck {
  const base = baseFor("Agent Skills index conforms, and its digests match the bytes", 15, url, AGENT_HTTP_THRESHOLD);
  return jsonArtifact(base, response, (doc) => {
  const problems: string[] = [];
  if (typeof doc.$schema !== "string") {
    problems.push("no `$schema`, so a reader treats the index as v0.1.0 rather than v0.2.0");
  }

  const skills = Array.isArray(doc.skills) ? doc.skills : [];
  if (skills.length === 0) problems.push("the `skills` array is empty or absent");

  const malformedEntries: string[] = [];
  for (const entry of skills) {
    if (!isRecord(entry)) {
      malformedEntries.push("(an entry that is not an object)");
      continue;
    }
    const name = typeof entry.name === "string" ? entry.name : "(unnamed)";
    const faults: string[] = [];
    if (entry.type !== "skill-md" && entry.type !== "archive") faults.push("type");
    if (typeof entry.url !== "string") faults.push("url");
    if (typeof entry.digest !== "string" || !/^sha256:[0-9a-f]{64}$/.test(entry.digest)) faults.push("digest");
    if (faults.length > 0) malformedEntries.push(`${name} (${faults.join(", ")})`);
  }
  if (malformedEntries.length > 0) problems.push(`entries missing fields: ${malformedEntries.join(", ")}`);

  const mismatched = digests.filter((digest) => digest.outcome === "mismatched");
  const unverifiable = digests.filter((digest) => digest.outcome === "unverifiable");
  const verified = digests.filter((digest) => digest.outcome === "verified");

  if (mismatched.length > 0) {
    // The worst defect in the tier and the reason #389 asks for byte verification:
    // a stale digest tells an agent the file it just fetched is not the file that
    // was advertised.
    problems.push(
      `digests that do not match the bytes served: ${mismatched.map((d) => `${d.name} (${d.reason})`).join(", ")}`,
    );
  }

  // Reported, never charged for: we did not read these bytes, so we make no claim
  // about them either way.
  const unverifiableNote = unverifiable.length > 0
    ? ` Not checked, and not counted against you: ${unverifiable.map((d) => `${d.name} (${d.reason})`).join(", ")}.`
    : "";

  const verifiedNote = verified.length > 0
    ? ` Verified ${verified.length} digest${verified.length === 1 ? "" : "s"} against the bytes${capped > 0 ? `, ${capped} more not checked (cap of ${MAX_DIGESTS_VERIFIED} per run)` : ""}.`
    : capped > 0
      ? ` ${capped} digest${capped === 1 ? "" : "s"} not checked (cap of ${MAX_DIGESTS_VERIFIED} per run).`
      : "";

  if (problems.length === 0) {
    return { ...base, passed: true, detail: `Conforms to v0.2.0: \`$schema\`, and every entry carries a type, a url and a sha256 digest.${verifiedNote}${unverifiableNote}` };
  }

  // Partial credit: an index with a real defect is still worth more than none.
  const total = 3;
  const met = Math.max(0, total - problems.length);
  return fractionCheck(base, { met, total, missing: problems }, (_m, _t, miss) => `Found: ${miss.join("; ")}.${verifiedNote}${unverifiableNote}`);
  });
}

function checkApiCatalog(response: Probe, url: string): DiscoveryCheck {
  const base = baseFor("api-catalog is a usable linkset (RFC 9727)", 10, url, AGENT_HTTP_THRESHOLD);
  return jsonArtifact(base, response, (doc, ok) => {
  const problems: string[] = [];
  const type = ok.headers.get("content-type")?.toLowerCase() ?? "";
  if (!type.includes("application/linkset+json")) {
    problems.push(`the content type is ${type || "absent"} rather than application/linkset+json`);
  } else if (!type.includes("rfc9727")) {
    problems.push("the content type carries no rfc9727 profile");
  }

  const linkset = Array.isArray(doc.linkset) ? doc.linkset : null;
  if (!linkset || linkset.length === 0) {
    problems.push("`linkset` is empty or absent");
  } else {
    // The defect the scan found on us: a linkset whose entries carry no `item`
    // links is a catalogue of nothing, and it answers 200.
    const withItems = linkset.filter(
      (entry) => isRecord(entry) && Array.isArray(entry.item) && entry.item.length > 0,
    );
    if (withItems.length === 0) {
      problems.push("no entry carries `item` links, so the catalogue lists nothing an agent can follow");
    }
  }

  return problemsCheck(
    base,
    problems,
    2,
    `Served as ${type} with ${linkset?.length ?? 0} linkset entr${linkset?.length === 1 ? "y" : "ies"} carrying item links.`,
  );
  });
}

function checkSignatureDirectory(response: Probe, url: string): DiscoveryCheck {
  const base = baseFor("Web Bot Auth key directory is complete (RFC 9421)", 10, url, AGENT_HTTP_THRESHOLD);
  return jsonArtifact(base, response, (doc) => {
  const keys = Array.isArray(doc.keys) ? doc.keys : null;
  if (!keys || keys.length === 0) return malformed(base, "The directory carries no `keys`, so a verifier has nothing to check a signature against.");

  const ed25519 = keys.filter((key) => isRecord(key) && key.kty === "OKP" && key.crv === "Ed25519");
  const problems: string[] = [];
  if (ed25519.length === 0) problems.push("no Ed25519 JWK (kty=OKP, crv=Ed25519)");
  const withoutKid = ed25519.filter((key) => isRecord(key) && typeof key.kid !== "string").length;
  if (withoutKid > 0) problems.push(`${withoutKid} key(s) with no \`kid\``);
  // The scan's finding on us, and a real one: a key with no lifetime cannot be
  // rotated, because nothing tells a verifier when to stop trusting it.
  const withoutLifetime = ed25519.filter((key) => isRecord(key) && (key.nbf === undefined || key.exp === undefined)).length;
  if (withoutLifetime > 0) {
    problems.push(`${withoutLifetime} key(s) with no \`nbf\`/\`exp\` lifetime, so a verifier is never told when to stop trusting them`);
  }

  const stated = problemsCheck(
    base,
    problems,
    3,
    `${ed25519.length} Ed25519 key(s), each with a \`kid\` and an \`nbf\`/\`exp\` lifetime.`,
  );
  // The key count leads the sentence when something is wrong: "1 key published,
  // and it has no lifetime" is a different report to "no lifetimes".
  return stated.passed ? stated : { ...stated, detail: `${keys.length} key(s) published. ${stated.detail}` };
  });
}

function checkPricingMd(response: Probe, url: string): DiscoveryCheck {
  const base = baseFor("pricing.md is published with real content", 5, url, AGENT_HTTP_THRESHOLD);
  const blocked = unmeasurable(base, response);
  if (blocked) return blocked;

  const ok = response as Extract<Probe, { ok: true }>;
  const type = ok.headers.get("content-type")?.toLowerCase() ?? "";
  const text = ok.body.trim();

  // An SPA answers every path with its shell and a 200, so `/pricing.md` serving
  // HTML is far more likely to be a soft 404 than a pricing document with the
  // wrong content type. Crediting it would report an artifact the site does not
  // have — the same trap `advertisesMcp` guards for llms.txt.
  if (type.includes("html")) {
    return malformed(
      base,
      `Answered HTTP ${ok.status} with ${type}. A markdown path serving HTML is usually an app shell answering every unknown path, so this is not read as a pricing document.`,
    );
  }

  if (text.length < MIN_MARKDOWN_CHARS) {
    return malformed(
      base,
      `Published, and under ${MIN_MARKDOWN_CHARS} characters of content. An agent comparing products reads pricing.md because the HTML pricing page is usually assembled by JavaScript; a stub answers nothing.`,
    );
  }

  return type.includes("markdown")
    ? { ...base, passed: true, detail: `${text.length} characters of markdown. An agent comparing products can read the terms without rendering the pricing page.` }
    : fractionCheck(base, { met: 1, total: 2, missing: [type || "no content type"] }, (_m, _t, miss) =>
        `${text.length} characters of content, served as ${miss[0]} rather than text/markdown.`,
      );
}

// ── Entry point ───────────────────────────────────────────────────────────────

/**
 * Audit the machine-readable artifacts an agent looks for before anything else.
 *
 * Read-only GETs, all of them same-site, plus up to {@link MAX_DIGESTS_VERIFIED}
 * fetches of the skill files whose digests the index advertises.
 */
export async function auditAgentDiscovery(url: string): Promise<Result<AgentDiscoveryResult>> {
  try {
    validateUrl(url);

    const landing: Landing = await land(url);
    const origin = new URL(landing.finalUrl).origin;
    const at = (path: string) => `${origin}${path}`;

    const [card, wellKnown, prm, asDefault, authMd, skills, catalog, signatures, pricing] = await Promise.all([
      probe(at(PATHS.serverCard)),
      probe(at(PATHS.mcpDiscovery)),
      probe(at(PATHS.protectedResource)),
      probe(at(PATHS.authorizationServer)),
      probe(at(PATHS.authMd)),
      probe(at(PATHS.skills)),
      probe(at(PATHS.apiCatalog)),
      probe(at(PATHS.signatures)),
      probe(at(PATHS.pricingMd)),
    ]);

    // Only fetched when nothing else advertises the server, so the common case
    // costs one request fewer and llms.txt is read for the one question it answers.
    const cardFound = card.ok && card.status === 200;
    const wellKnownFound = wellKnown.ok && wellKnown.status === 200;
    const llms = cardFound || wellKnownFound ? null : await probe(at(PATHS.llmsTxt));

    const cardDoc = cardFound ? parsed(card as Extract<Probe, { ok: true }>) : null;
    const endpoint = endpointFrom(cardDoc, origin);

    // RFC 9728 puts a resource's metadata under the resource's own path, so a
    // server at `/mcp` publishes at `/.well-known/oauth-protected-resource/mcp`.
    // Probing only the root reported "Not published" about most real MCP servers,
    // and made the traversal check n/a for the sites it was written for.
    const prmRoot = prm.ok && prm.status === 200 ? prm : null;
    const endpointPath = endpoint ? new URL(endpoint).pathname.replace(/\/+$/, "") : "";
    const prmScoped =
      !prmRoot && endpointPath && endpointPath !== "/"
        ? await probe(`${origin}${PATHS.protectedResource}${endpointPath}`)
        : null;
    const prmUsed = prmRoot ?? (prmScoped?.ok && prmScoped.status === 200 ? prmScoped : prm);
    const prmUrl = prmUsed === prmScoped ? `${origin}${PATHS.protectedResource}${endpointPath}` : at(PATHS.protectedResource);

    // Where the resource says its authorization server is, which is the hop the
    // traversal check is actually about.
    const prmDoc = prmUsed.ok && prmUsed.status === 200 ? parsed(prmUsed as Extract<Probe, { ok: true }>) : null;
    const declared = declaredAuthorizationServer(prmDoc);
    // A declared server we may not fetch is not a server we quietly fetch anyway:
    // `offSiteAuthServer` carries the refusal into both checks that would have
    // read its document, so the finding names the third party instead of the
    // request naming it.
    const offSiteAuthServer = declared !== null && !sameSite(declared, landing.finalUrl) ? declared : null;
    const asUrl = declared && !offSiteAuthServer ? authorizationServerMetadataUrl(declared) : at(PATHS.authorizationServer);
    const sameAsDefault = asUrl === at(PATHS.authorizationServer);

    const [endpointProbe, asProbe, digestResults] = await Promise.all([
      endpoint ? probe(endpoint, "application/json") : Promise.resolve(null),
      offSiteAuthServer ? Promise.resolve(null) : sameAsDefault ? Promise.resolve(asDefault) : probe(asUrl),
      verifyDigests(skills, origin),
    ]);

    const checks: DiscoveryCheck[] = [
      checkServerCard(card, at(PATHS.serverCard)),
      checkMcpDiscoverable(card, wellKnown, llms, origin),
      checkMcpEndpoint(endpointProbe, endpoint),
      checkProtectedResource(prmUsed, prmUrl),
      checkAuthorizationServer(asProbe, asUrl, offSiteAuthServer),
      checkAuthChain(prmUsed, asProbe, asUrl, declared, offSiteAuthServer, authMd),
      checkAuthMd(authMd, at(PATHS.authMd)),
      checkSkillsIndex(skills, at(PATHS.skills), digestResults.verified, digestResults.capped),
      checkApiCatalog(catalog, at(PATHS.apiCatalog)),
      checkSignatureDirectory(signatures, at(PATHS.signatures)),
      checkPricingMd(pricing, at(PATHS.pricingMd)),
    ];

    const { score, max, notApplicable, notEvaluated } = tally(checks);

    // The bonus, and the one line of arithmetic that has to be right.
    //
    // The denominator is the FULL set of artifacts, always — not "the ones we
    // managed to read". An earlier version excluded unevaluated checks from it,
    // and airbnb.com, where bot protection refused eight of eleven documents,
    // came out at +2.5 of 5 on the strength of a single artifact: a bonus
    // computed over a denominator that had quietly shrunk to one. On a fixed
    // scale, an artifact that is absent, unreadable or malformed all earn the
    // same nothing, and nothing is never a penalty — the floor is +0, exactly
    // what a site with none of these would have had if this tier did not exist.
    //
    // The `quality` fraction beside it is where the n/a-vs-not-evaluated
    // discipline lives: it counts only what the site publishes and we could read.
    // `score` is the earned total: `tally` already skips every check with a
    // status and sums the rest. Adding them up here with `earnedBy` would be a
    // second place the arithmetic lives, which is the one thing `scored-checks.ts`
    // exists to prevent — and a test in that module enforces it.
    const possible = checks.reduce((sum, check) => sum + check.points, 0);
    const bonus = possible === 0 ? 0 : Math.round((MAX_BONUS * score * 10) / possible) / 10;

    return success({
      url,
      checks,
      bonus,
      maxBonus: MAX_BONUS,
      quality: { score, max },
      notApplicable,
      notEvaluated,
    });
  } catch (error) {
    return failure(error instanceof Error ? error : new Error(String(error)));
  }
}

/** The MCP endpoint a card advertises, under any of the spellings the schema has used. */
function endpointFrom(card: Record<string, unknown> | null, origin: string): string | null {
  if (!card) return null;
  const direct = [card.serverUrl, card.url].find((value) => typeof value === "string") as string | undefined;
  if (direct) {
    try {
      const absolute = new URL(direct, origin);
      return absolute.origin === origin ? absolute.toString() : null;
    } catch {
      return null;
    }
  }
  return null;
}

function declaredAuthorizationServer(prm: Record<string, unknown> | null): string | null {
  if (!prm || !Array.isArray(prm.authorization_servers)) return null;
  const first = prm.authorization_servers.find((entry) => typeof entry === "string");
  return typeof first === "string" ? first : null;
}

/**
 * Where RFC 8414 says an issuer's metadata lives.
 *
 * The well-known segment goes after the host and before the issuer's path, which
 * is the part everyone gets wrong: for `https://example.com/tenant` the document
 * is at `https://example.com/.well-known/oauth-authorization-server/tenant`.
 */
function authorizationServerMetadataUrl(issuer: string): string {
  try {
    const url = new URL(issuer);
    const path = url.pathname.replace(/\/+$/, "");
    return `${url.origin}${PATHS.authorizationServer}${path}`;
  } catch {
    return issuer;
  }
}

/**
 * Fetch each advertised skill and check its digest against the bytes.
 *
 * "A stale digest is worse than none, because it tells an agent the file it just
 * fetched is not the file that was advertised." Capped, and the cap is reported
 * rather than applied silently.
 */
async function verifyDigests(
  skills: Probe,
  origin: string,
): Promise<{ verified: SkillDigest[]; capped: number }> {
  if (!skills.ok || skills.status !== 200) return { verified: [], capped: 0 };
  const doc = parsed(skills);
  const entries = doc && Array.isArray(doc.skills) ? doc.skills : [];

  const checkable = entries.filter(
    (entry): entry is Record<string, unknown> =>
      isRecord(entry) && typeof entry.url === "string" && typeof entry.digest === "string",
  );
  const chosen = checkable.slice(0, MAX_DIGESTS_VERIFIED);

  const verified = await Promise.all(
    chosen.map(async (entry): Promise<SkillDigest> => {
      const name = typeof entry.name === "string" ? entry.name : String(entry.url);
      let target: string;
      try {
        const absolute = new URL(entry.url as string, origin);
        if (absolute.origin !== origin) {
          return { outcome: "unverifiable", name, url: String(entry.url), reason: "the entry points off-site, and this audit does not follow it" };
        }
        target = absolute.toString();
      } catch {
        return { outcome: "unverifiable", name, url: String(entry.url), reason: "the entry's url is not a URL" };
      }

      const response = await probe(target);
      if (!response.ok) {
        return {
          outcome: "unverifiable",
          name,
          url: target,
          reason: response.blockedByRobots ? "robots.txt disallows the file, and we honour it" : `the file could not be fetched (${response.reason})`,
        };
      }
      if (response.status !== 200) {
        return { outcome: "unverifiable", name, url: target, reason: `the file answered HTTP ${response.status}` };
      }

      const actual = `sha256:${createHash("sha256").update(response.body, "utf8").digest("hex")}`;
      return actual === entry.digest
        ? { outcome: "verified", name, url: target }
        : { outcome: "mismatched", name, url: target, reason: `advertised ${String(entry.digest).slice(0, 20)}…, bytes hash to ${actual.slice(0, 20)}…` };
    }),
  );

  return { verified, capped: checkable.length - chosen.length };
}
