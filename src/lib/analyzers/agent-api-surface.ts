/**
 * Can an agent call this site's API, or only find out that it has one?
 *
 * The second of the three tiers in #386, specified in #388, and the one where the
 * applicability gating does the real work: **a site with no API surface is not a
 * site failing an API tier.** Nothing here scores until a spec has actually been
 * found, and "found" means fetched and parsed, not guessed.
 *
 * ## What made this worth building
 *
 * A third-party scan of our own production site on 2026-08-22 returned one line no
 * tool we shipped could have produced:
 *
 * > Partial compatibility: 9/9 operationIds, 1/9 typed schemas
 *
 * Nine operations that an agent knows how to call and eight it cannot predict the
 * response of. The strings `openapi` / `OpenAPI` appeared zero times across
 * `lib/analyzers/` and `lib/tools/` at the time. We could not have told a customer
 * that about their spec, and we could not tell it about our own.
 *
 * ## What it may claim, and what it may not
 *
 * Same rule as the HTTP tier: every check is an assertion about a document a
 * server served or a response it returned. Nothing here says anything about
 * ranking or citation. See `docs/agent-api-surface.md`, and ADR-0025 for the axis.
 *
 * Two limits it holds to, both from #388:
 *
 * - **Read-only, never authenticated.** No writes, no auth attempts, no
 *   exhausting someone's rate limit in order to observe that they publish
 *   rate-limit headers. The error-shape probe is a GET at a path that should not
 *   exist, which is the cheapest way to see an error without causing one.
 * - **Fractions, not verdicts.** `1/9 typed schemas` names the work; "spec
 *   quality: poor" does not. Every fraction cites the operations it counted.
 */

import { getDomain } from "tldts";
import { AGENT_HTTP_FACT, AGENT_HTTP_THRESHOLD, type CheckSource } from "./check-source";
import { tally, type Scorable } from "./scored-checks";
import { validateUrl } from "../http-client";
import {
  couldNotRun,
  curl,
  disallowed,
  land,
  probe,
  PROBE_PATH,
  unresolved,
  type Landing,
  type Probe,
} from "./agent-probe";
import { failure, success, type Result } from "../type-guards";

/**
 * Where a spec conventionally lives, in the order an agent would try.
 *
 * Short on purpose. Each entry is one more request against someone's server, and
 * these five plus the two the site can advertise for itself (a `Link` relation and
 * the RFC 9727 catalogue) cover what is actually deployed. Guessing further is how
 * an audit turns into a scan.
 */
const SPEC_PATHS = [
  "/openapi.json",
  "/openapi.yaml",
  "/api/openapi.json",
  "/swagger.json",
  // The two framework defaults, which cover most specs that are published without
  // anyone choosing a path: springdoc writes the first, ASP.NET the second.
  "/v3/api-docs",
  "/swagger/v1/swagger.json",
  "/.well-known/api-catalog",
];

/** `Link` relations that point at a machine-readable API description (RFC 8631). */
const SPEC_RELS = ["service-desc", "describedby"];

/** Conventional GraphQL endpoint. Detection only — see `checkGraphql`. */
const GRAPHQL_PATH = "/graphql";

/** HTTP methods that are operations in an OpenAPI path item. */
const METHODS = ["get", "put", "post", "delete", "patch", "options", "head", "trace"];

/**
 * Header families that tell a caller its remaining budget.
 *
 * The IETF draft names the first five; `X-RateLimit-*` is the de-facto original
 * and is accepted because a caller can read either. A check that credited only the
 * standard one would report "no rate limit headers" about an API that publishes
 * them, which is a false statement about a response.
 *
 * `Retry-After` was in this list and is not. It says when to come back after
 * being refused; it does not state a remaining budget, which is the name on this
 * check. A 404 carrying `Retry-After` would have passed a check about a header it
 * does not have — the list being ours is exactly why it needs watching.
 */
const RATE_LIMIT_HEADERS = [
  "ratelimit",
  "ratelimit-policy",
  "ratelimit-limit",
  "ratelimit-remaining",
  "ratelimit-reset",
  "x-ratelimit-limit",
  "x-ratelimit-remaining",
  "x-ratelimit-reset",
];

/**
 * The two halves of a machine-readable error, kept apart on purpose.
 *
 * #388 asks for "structured errors with a code, a message and a resolution hint",
 * and a check that awarded full marks for any one of eight fields let a body
 * carrying only `status` read as fully compliant. So an identifier a client can
 * branch on and a sentence a human can act on are counted separately, and full
 * credit needs both. RFC 9457 names `type`/`title`/`detail`/`status`.
 *
 * Both lists are ours, which is why this check carries `AGENT_HTTP_THRESHOLD`
 * rather than presenting the verdict as a fact about the response.
 */
const ERROR_IDENTIFIERS = ["type", "code", "error", "status"];
const ERROR_MESSAGES = ["title", "detail", "message", "errors", "description", "hint"];

export interface ApiSurfaceCheck extends Scorable {
  name: string;
  /** Required: the renderer prints it for every check, passing or not. */
  detail: string;
  /** The exact request, as a `curl` line the reader can paste. */
  request: string;
  source: CheckSource;
}

export interface AgentApiSurfaceResult {
  url: string;
  /** Where the spec was found, or `null` when none was. The gate for everything else. */
  specUrl: string | null;
  /** The API base the error probe used, or `null` when there was nothing safe to probe. */
  apiBase: string | null;
  checks: ApiSurfaceCheck[];
  score: number;
  max: number;
  /** Points belonging to checks this site cannot owe. Reported, never scored. */
  notApplicable: number;
  /** Points belonging to checks that could not be evaluated on this run. */
  notEvaluated: number;
}

// ── The spec ──────────────────────────────────────────────────────────────────

type Operation = {
  path: string;
  method: string;
  /** `operationId` plus path, so a finding can be opened at the right line. */
  label: string;
  op: Record<string, unknown>;
  /** Path-item parameters and the operation's own, references already resolved. */
  parameters: unknown[];
};

type Spec = {
  url: string;
  doc: Record<string, unknown>;
  operations: Operation[];
};

/** A spec we found and could not read, kept apart from a spec we never found. */
type Unparsed = { url: string; reason: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** An OpenAPI or Swagger document, by the key that declares which it is. */
function looksLikeSpec(doc: unknown): doc is Record<string, unknown> {
  return isRecord(doc) && (typeof doc.openapi === "string" || typeof doc.swagger === "string");
}

/**
 * Resolve a local `$ref`, or hand back what was given.
 *
 * Not a full JSON Reference implementation: local pointers only, which is what a
 * spec uses for its own components and the only kind we could follow without
 * fetching more of someone's site. It exists because without it a perfectly valid
 * spec gets a false finding — `parameters: [{$ref: "#/components/parameters/Id"}]`
 * has neither `schema` nor `content` at the reference site, so an untouched check
 * reports "untyped parameters" about a document that types them. A false
 * statement about a served document is the one thing this axis may not make.
 */
function deref(doc: Record<string, unknown>, node: unknown, depth = 0): unknown {
  if (!isRecord(node) || typeof node.$ref !== "string" || depth > MAX_REF_DEPTH) return node;
  if (!node.$ref.startsWith("#/")) return node;

  let current: unknown = doc;
  for (const rawSegment of node.$ref.slice(2).split("/")) {
    const segment = rawSegment.replace(/~1/g, "/").replace(/~0/g, "~");
    if (!isRecord(current)) return node;
    current = current[segment];
  }

  return current === undefined ? node : deref(doc, current, depth + 1);
}

/** How far a chain of local references is followed before we stop. */
const MAX_REF_DEPTH = 5;

function operationsOf(doc: Record<string, unknown>): Operation[] {
  const paths = isRecord(doc.paths) ? doc.paths : {};
  const operations: Operation[] = [];

  for (const [path, rawItem] of Object.entries(paths)) {
    const item = deref(doc, rawItem);
    if (!isRecord(item)) continue;
    // OpenAPI lets a path item declare parameters once and inherit them into every
    // operation under it. Reading only the operation's own list made those
    // operations pass vacuously, and made a `{version}` path parameter declared
    // once invisible to the versioning check.
    const inherited = Array.isArray(item.parameters) ? item.parameters : [];

    for (const [method, rawOp] of Object.entries(item)) {
      if (!METHODS.includes(method.toLowerCase())) continue;
      const op = deref(doc, rawOp);
      if (!isRecord(op)) continue;
      const own = Array.isArray(op.parameters) ? op.parameters : [];
      const id = typeof op.operationId === "string" ? op.operationId : null;
      operations.push({
        path,
        method: method.toUpperCase(),
        // The citation #388 asks for: "`operationId` plus the path, so the reader
        // can open the spec at the right line". An operation with no id is named
        // by what it does have, rather than reported as an anonymous failure.
        label: id ? `${id} (${method.toUpperCase()} ${path})` : `${method.toUpperCase()} ${path}`,
        op,
        parameters: [...inherited, ...own].map((parameter) => deref(doc, parameter)),
      });
    }
  }

  return operations;
}

/**
 * The same registrable domain, which is the only host other than the audited one
 * this tier will talk to.
 *
 * A spec declares its own `servers`, and for most real APIs that is
 * `api.example.com` while the audit was pointed at `example.com`. Refusing to
 * probe it would report "we could not see your errors" about every API that
 * separates its hosts, which is most of them. Following it anywhere at all would
 * mean a spec on example.com could aim our request at a third party. eTLD+1 is
 * the line that admits the first and refuses the second, and it is the same unit
 * the Site Limit already counts (`lib/utils/registrable-domain.ts`).
 */
function sameSite(a: string, b: string): boolean {
  const domainA = getDomain(new URL(a).hostname);
  const domainB = getDomain(new URL(b).hostname);
  return domainA !== null && domainA === domainB;
}

/** Absolute same-site URLs a `Link` header advertises as an API description. */
function specLinksFrom(landing: Landing): string[] {
  if (!landing.probe.ok) return [];
  const header = landing.probe.headers.get("link") ?? "";
  const urls: string[] = [];

  for (const entry of header.split(/,(?=\s*<)/)) {
    const target = entry.match(/<([^>]+)>/)?.[1];
    if (!target) continue;
    if (!SPEC_RELS.some((rel) => new RegExp(`rel\\s*=\\s*"?[^",]*\\b${rel}\\b`, "i").test(entry))) continue;
    try {
      const absolute = new URL(target, landing.finalUrl).toString();
      if (sameSite(absolute, landing.finalUrl)) urls.push(absolute);
    } catch {
      // A malformed target is the site's, not ours to report here: the HTTP tier
      // owns what the `Link` header says. Skipping it keeps this discovery-only.
    }
  }

  return urls;
}

/** Same-site `item` targets out of an RFC 9727 linkset, which is a catalogue of APIs. */
function catalogueLinks(body: string, base: string): string[] {
  try {
    const doc: unknown = JSON.parse(body);
    if (!isRecord(doc) || !Array.isArray(doc.linkset)) return [];
    const urls: string[] = [];
    for (const entry of doc.linkset) {
      if (!isRecord(entry)) continue;
      for (const key of ["item", "service-desc", "describedby"]) {
        const targets = entry[key];
        if (!Array.isArray(targets)) continue;
        for (const target of targets) {
          if (!isRecord(target) || typeof target.href !== "string") continue;
          const absolute = new URL(target.href, base).toString();
          if (sameSite(absolute, base)) urls.push(absolute);
        }
      }
    }
    return urls;
  } catch {
    return [];
  }
}

/**
 * Find the spec, or say where we looked.
 *
 * Returns three outcomes rather than two, and the third is the point: a spec we
 * fetched and could not parse is not a spec that is absent. YAML is the case that
 * matters — this repo ships no YAML parser, so a `.yaml` spec is *found* and the
 * quality checks below are `not-evaluated` with that reason, never `not-applicable`
 * and never a zero.
 */
async function findSpec(
  landing: Landing,
): Promise<{ spec: Spec | null; unparsed: Unparsed | null; tried: string[] }> {
  const origin = new URL(landing.finalUrl).origin;
  const advertised = specLinksFrom(landing);
  const conventional = SPEC_PATHS.map((path) => `${origin}${path}`);
  // When the caller pointed at an API base rather than at a homepage
  // (`petstore3.swagger.io/api/v3`), the spec usually sits under that path, not at
  // the origin. Trying both is one extra request and is what makes the tool
  // answer the question the caller actually asked.
  const base = landing.finalUrl.replace(/\/+$/, "");
  const underPath = new URL(landing.finalUrl).pathname.replace(/\/+$/, "")
    ? SPEC_PATHS.map((path) => `${base}${path}`)
    : [];
  const tried: string[] = [];
  let unparsed: Unparsed | null = null;

  for (const url of [...advertised, ...underPath, ...conventional]) {
    if (tried.includes(url)) continue;
    tried.push(url);

    const response = await probe(url);
    if (!response.ok || response.status !== 200) continue;

    // The catalogue is a pointer, not a spec: follow its items once.
    if (url.endsWith("/.well-known/api-catalog")) {
      for (const target of catalogueLinks(response.body, url)) {
        if (tried.includes(target)) continue;
        tried.push(target);
        const item = await probe(target);
        if (!item.ok || item.status !== 200) continue;
        const parsed = parseSpec(item);
        if (parsed.spec) return { spec: parsed.spec, unparsed: null, tried };
        unparsed ??= parsed.unparsed;
      }
      continue;
    }

    const parsed = parseSpec(response);
    if (parsed.spec) return { spec: parsed.spec, unparsed: null, tried };
    unparsed ??= parsed.unparsed;
  }

  return { spec: null, unparsed, tried };
}

function parseSpec(response: Extract<Probe, { ok: true }>): { spec: Spec | null; unparsed: Unparsed | null } {
  try {
    const doc: unknown = JSON.parse(response.body);
    if (!looksLikeSpec(doc)) return { spec: null, unparsed: null };
    return { spec: { url: response.url, doc, operations: operationsOf(doc) }, unparsed: null };
  } catch {
    // Not JSON. A YAML spec is the common case and this repo has no YAML parser,
    // so it is recorded as found-and-unread rather than silently skipped: the
    // difference between "you have no spec" and "we could not read yours" is the
    // whole discipline of this tier.
    const looksYaml = /^\s*(openapi|swagger)\s*:/m.test(response.body);
    return {
      spec: null,
      unparsed: looksYaml
        ? { url: response.url, reason: "the spec is YAML and this audit reads only JSON specs" }
        : null,
    };
  }
}

// ── Fractions ─────────────────────────────────────────────────────────────────

/**
 * A per-operation count, rendered the way #388 asks for it.
 *
 * "Report it as a fraction, the way their line does. `9/9` and `1/9` are more
 * useful than one blended percentage, because they point at different work." The
 * offenders are named, up to a cap, because a spec with sixty operations missing a
 * schema should say how big the problem is without printing sixty lines.
 */
const MAX_NAMED = 6;

function fraction(
  operations: readonly Operation[],
  satisfies: (op: Operation) => boolean,
): { met: number; total: number; missing: string[] } {
  const missing = operations.filter((op) => !satisfies(op)).map((op) => op.label);
  return { met: operations.length - missing.length, total: operations.length, missing };
}

function names(missing: readonly string[]): string {
  const shown = missing.slice(0, MAX_NAMED).join(", ");
  return missing.length > MAX_NAMED ? `${shown}, and ${missing.length - MAX_NAMED} more` : shown;
}

/**
 * Points earned by a fraction, at the check's own weight.
 *
 * `total` is never 0 here: `runFraction` returns `not-applicable` before it gets
 * this far, because a spec with no operations has nothing to be measured on.
 */
function earnedFor(points: number, met: number, total: number): number {
  return Math.round((points * met) / total);
}

// ── Checks ────────────────────────────────────────────────────────────────────

type Base = { name: string; points: number; request: string; source: CheckSource };

/** The state every quality check takes when no spec was found. */
function noSpec(base: Base, tried: readonly string[]): ApiSurfaceCheck {
  return {
    ...base,
    status: "not-applicable",
    detail: `No API description was found, so this does not apply. Looked at ${tried.length} location${tried.length === 1 ? "" : "s"}, including the conventional ones and anything the site advertised in a Link header or an api-catalog. A site with no API is not a site with a failing API.`,
  };
}

function specCheck(
  base: Base,
  spec: Spec | null,
  unparsed: Unparsed | null,
  tried: readonly string[],
  run: (spec: Spec) => ApiSurfaceCheck,
): ApiSurfaceCheck {
  if (spec) return run(spec);
  if (unparsed) return couldNotRun(base, `a spec was found at ${unparsed.url} but ${unparsed.reason}`);
  return noSpec(base, tried);
}

function countOperationIds(spec: Spec): { met: number; total: number; missing: string[] } {
  const seen = new Map<string, number>();
  for (const operation of spec.operations) {
    const id = operation.op.operationId;
    if (typeof id === "string") seen.set(id, (seen.get(id) ?? 0) + 1);
  }
  return fraction(spec.operations, (operation) => {
    const id = operation.op.operationId;
    // Unique as well as present: two operations sharing an id is worse than one
    // having none, because a generated client silently keeps only the last.
    return typeof id === "string" && id.length > 0 && seen.get(id) === 1;
  });
}

/**
 * A schema that describes a payload, as opposed to one that names its container.
 *
 * The distinction that made this tier's headline number reproducible. Our own
 * spec of 2026-08-21 typed eight of its nine operations as
 * `content: {"application/json": {schema: {type: "object"}}}` — a schema that
 * says "an object arrives" and nothing about what is in it. A naive check counts
 * that as typed and reports 9/9; the scanner that prompted #388 reported **1/9**,
 * and the scanner was right. `{type: "object"}` with no properties leaves a
 * function-calling client exactly where it started.
 *
 * So a schema counts when it says something: a `$ref` to a named component, a
 * composition, an enumeration, declared `properties` or `items`, or a scalar type
 * — a `text/markdown` response typed `{type: "string"}` genuinely is fully
 * described. It does not count when it is a bare container.
 */
function describesPayload(schema: unknown): boolean {
  if (!isRecord(schema)) return false;
  if (typeof schema.$ref === "string") return true;
  for (const key of ["properties", "items", "enum", "const", "allOf", "oneOf", "anyOf", "additionalProperties", "patternProperties", "prefixItems"]) {
    if (schema[key] !== undefined) return true;
  }
  const type = schema.type;
  const scalar = ["string", "number", "integer", "boolean"];
  if (typeof type === "string") return scalar.includes(type);
  if (Array.isArray(type)) return type.some((entry) => typeof entry === "string" && scalar.includes(entry));
  return false;
}

function hasTypedResponse(operation: Operation, doc: Record<string, unknown>): boolean {
  const responses = deref(doc, operation.op.responses);
  if (!isRecord(responses)) return false;

  for (const [code, rawResponse] of Object.entries(responses)) {
    // Success responses only, and `default` is not one of them: it is where a spec
    // puts its error shape, so counting it would let a spec that types only its
    // failures read as one that tells a caller what a successful call returns.
    if (!/^2\d\d$/.test(code) && code !== "2XX") continue;
    const response = deref(doc, rawResponse);
    if (!isRecord(response)) continue;

    // Swagger 2.0 hangs the schema straight off the response; OpenAPI 3 puts it
    // under a media type. Both are in `SPEC_PATHS`' reach — `/swagger.json` and
    // `/swagger/v1/swagger.json` are 2.0's conventional homes — so reading only
    // the 3.x shape reported 0/N typed schemas about every 2.0 spec in existence.
    if (describesPayload(deref(doc, response.schema))) return true;

    const content = deref(doc, response.content);
    if (!isRecord(content)) continue;
    for (const rawMedia of Object.values(content)) {
      const media = deref(doc, rawMedia);
      if (isRecord(media) && describesPayload(deref(doc, media.schema))) return true;
    }
  }

  return false;
}

function hasTypedParameters(operation: Operation): boolean {
  // No parameters is a typed signature, not an untyped one. Counting it as a
  // failure would charge every GET that takes nothing for the sins of the ones
  // that take an untyped string.
  return operation.parameters.every(
    (parameter) =>
      isRecord(parameter) &&
      // Swagger 2.0 types a body parameter with `schema` and everything else with
      // a bare `type` on the parameter itself.
      (parameter.schema !== undefined || parameter.content !== undefined || typeof parameter.type === "string"),
  );
}

/** The API base the spec declares, when it is one we may talk to. */
function apiBaseOf(spec: Spec, siteUrl: string): { base: string | null; reason: string | null } {
  const servers = Array.isArray(spec.doc.servers) ? spec.doc.servers : [];
  const first = servers.find((server) => isRecord(server) && typeof server.url === "string");
  const declared = isRecord(first) && typeof first.url === "string" ? first.url : null;

  if (!declared) return { base: new URL(siteUrl).origin, reason: null };

  let absolute: string;
  try {
    absolute = new URL(declared, siteUrl).toString().replace(/\/$/, "");
  } catch {
    return { base: null, reason: `the spec declares an unparseable server URL (${declared})` };
  }

  if (!sameSite(absolute, siteUrl)) {
    return {
      base: null,
      reason: `the spec points its server at ${new URL(absolute).host}, which is a different registrable domain to the site being audited, and this audit does not send requests to third parties on a spec's say-so`,
    };
  }

  return { base: absolute, reason: null };
}

function checkErrorShape(landing: Landing | null, reason: string | null, request: string): ApiSurfaceCheck {
  const base: Base = {
    name: "Errors come back as parseable JSON",
    points: 15,
    request,
    // Ours: which fields count as an identifier and which as a message, and the
    // part-credit ladder between them.
    source: AGENT_HTTP_THRESHOLD,
  };

  if (reason) return couldNotRun(base, reason);
  if (!landing) return couldNotRun(base, "there was no API base to probe");
  const errorProbe = landing.probe;
  if (!errorProbe.ok) {
    return errorProbe.blockedByRobots
      ? disallowed(base, errorProbe.url)
      : couldNotRun(base, `the probe request failed — ${errorProbe.reason}`);
  }
  if (unresolved(errorProbe)) {
    return couldNotRun(
      base,
      `the probe was still redirecting after every hop we follow, so nothing we read was an error document`,
    );
  }

  const type = errorProbe.headers.get("content-type")?.toLowerCase() ?? "";
  const isJson = type.includes("json");
  const status = errorProbe.status;

  if (!isJson) {
    return {
      ...base,
      passed: false,
      detail: `HTTP ${status} answered ${type || "no content type"}. An agent cannot parse an HTML error page: it gets a status and a wall of markup where it needed a reason. Note this is a pass even when the status is 401 — a 401 with a JSON body tells a caller what credential is missing; a 401 with a login page does not.`,
    };
  }

  let identifiers: string[] = [];
  let messages: string[] = [];
  try {
    const doc: unknown = JSON.parse(errorProbe.body);
    if (isRecord(doc)) {
      identifiers = ERROR_IDENTIFIERS.filter((field) => doc[field] !== undefined);
      messages = ERROR_MESSAGES.filter((field) => doc[field] !== undefined);
    }
  } catch {
    return {
      ...base,
      earned: 5,
      detail: `HTTP ${status} claimed ${type} and the body did not parse as JSON. The content type is a promise the response did not keep.`,
    };
  }

  if (identifiers.length > 0 && messages.length > 0) {
    return {
      ...base,
      passed: true,
      detail: `HTTP ${status} answered ${type} carrying ${[...identifiers, ...messages].join(", ")}. An agent gets something to branch on and something to report.`,
    };
  }

  if (identifiers.length > 0 || messages.length > 0) {
    return {
      ...base,
      earned: 10,
      detail: `HTTP ${status} answered ${type} carrying ${[...identifiers, ...messages].join(", ")} — ${identifiers.length ? "an identifier with no human-readable message" : "a message with no code a client can branch on"}. RFC 9457 asks for both: a \`type\` or \`code\` to switch on and a \`title\`/\`detail\` to surface.`,
    };
  }

  return {
    ...base,
    earned: 7,
    detail: `HTTP ${status} answered parseable JSON carrying none of the conventional fields (${[...ERROR_IDENTIFIERS, ...ERROR_MESSAGES].join(", ")}). A caller gets a document it can parse and no statement of what failed.`,
  };
}

function checkRateLimitHeaders(landing: Landing | null, reason: string | null, request: string): ApiSurfaceCheck {
  const base: Base = {
    name: "API responses state the caller's remaining budget",
    points: 10,
    request,
    // Ours: the accepted header list, which is what dropping `Retry-After` from it
    // changed. The presence of a header is a fact; which headers count is not.
    source: AGENT_HTTP_THRESHOLD,
  };

  if (reason) return couldNotRun(base, reason);
  if (!landing) return couldNotRun(base, "there was no API base to probe");
  const errorProbe = landing.probe;
  if (!errorProbe.ok) {
    return errorProbe.blockedByRobots
      ? disallowed(base, errorProbe.url)
      : couldNotRun(base, `the probe request failed — ${errorProbe.reason}`);
  }
  if (unresolved(errorProbe)) {
    return couldNotRun(base, "the probe was still redirecting after every hop we follow, so we never read an API response");
  }

  const present = RATE_LIMIT_HEADERS.filter((header) => errorProbe.headers.get(header) !== null);

  return present.length > 0
    ? {
        ...base,
        passed: true,
        detail: `The response carries ${present.join(", ")}. An agent can see its budget and pace itself instead of backing off blindly or hammering until it is cut off.`,
      }
    : {
        ...base,
        passed: false,
        detail: `No RateLimit header family on this response (looked for ${RATE_LIMIT_HEADERS.join(", ")}). One request cannot prove they are absent from every endpoint — this is what the probed response returned. An agent that cannot read its remaining budget either backs off blindly or hammers until it is cut off.`,
      };
}

function checkVersioning(spec: Spec, base: Base): ApiSurfaceCheck {
  const servers = Array.isArray(spec.doc.servers) ? spec.doc.servers : [];
  const serverUrls = servers
    .filter((server): server is Record<string, unknown> => isRecord(server))
    .map((server) => (typeof server.url === "string" ? server.url : ""));
  const versionedServer = serverUrls.find((url) => /\/v\d+(\/|$)/i.test(url));
  const versionedPath = spec.operations.find((operation) => /\/v\d+(\/|$)/i.test(operation.path));
  // Named exactly, and in the path or the query — not "any parameter with the
  // word version in it". That looser rule passed our own spec on
  // `MCP-Protocol-Version`, a header carrying a third-party protocol revision
  // that no caller can use to pin THIS API. A check its author passes by
  // accident is worse than one it fails, and the scan that prompted #388 said
  // plainly: "No API versioning strategy found."
  const versionParameter = spec.operations.find((operation) =>
    operation.parameters.some(
      (parameter) =>
        isRecord(parameter) &&
        (parameter.in === "path" || parameter.in === "query") &&
        typeof parameter.name === "string" &&
        /^(api[-_]?)?version$/i.test(parameter.name),
    ),
  );

  if (versionedServer || versionedPath || versionParameter) {
    const where = versionedServer
      ? `the server URL (${versionedServer})`
      : versionedPath
        ? `the path (${versionedPath.path})`
        : `a declared version parameter on ${versionParameter!.label}`;
    return {
      ...base,
      passed: true,
      detail: `Versioned in ${where}. A client can pin to a version and find out when it is asked to move.`,
    };
  }

  const declared = isRecord(spec.doc.info) && typeof spec.doc.info.version === "string" ? spec.doc.info.version : null;
  return {
    ...base,
    passed: false,
    detail: `No version in any server URL or path, and no declared version parameter.${declared ? ` \`info.version\` says ${declared}, which documents the spec and is not something a caller can address.` : ""} An agent has no way to pin a version, so a breaking change reaches it as a runtime failure.`,
  };
}

/**
 * GraphQL: detection, reported and not priced.
 *
 * #388 asks for "a fully typed schema, and a documented cost or rate limit" when
 * a GraphQL endpoint is present. Neither is observable read-only: production
 * endpoints disable introspection as a matter of course, and a cost policy lives
 * in prose. So this reports what a GET to the conventional path returned and
 * stops, at zero points — the same rule that demoted the `Link`-header check in
 * the HTTP tier. Pricing a check we cannot evaluate would be the "silent pass"
 * #337 catalogued, wearing a different hat.
 */
function checkGraphql(landing: Landing): ApiSurfaceCheck {
  const graphql = landing.probe;
  const base: Base = {
    name: "GraphQL endpoint (informational)",
    points: 0,
    request: curl(landing.requested, { body: true, followed: landing.hops.length > 0 }),
    source: AGENT_HTTP_FACT,
  };

  if (!graphql.ok) {
    return graphql.blockedByRobots
      ? disallowed(base, graphql.url)
      : couldNotRun(base, `the probe request failed — ${graphql.reason}`);
  }

  // 405 and 400 are what a live GraphQL endpoint says to a bare GET, so they are
  // evidence of one rather than evidence against.
  // The landed path has to still be the GraphQL one. `/graphql` redirecting to
  // `/login?next=/graphql` answers 200, and reading that as a live endpoint is
  // how vercel.com was reported to have GraphQL it does not serve here.
  const stayedPut = new URL(landing.finalUrl).pathname.replace(/\/$/, "").endsWith(GRAPHQL_PATH);
  const responded = stayedPut && [200, 400, 405].includes(graphql.status);
  const where = landing.hops.length > 0 ? `${GRAPHQL_PATH} (landing on ${landing.finalUrl})` : GRAPHQL_PATH;
  return {
    ...base,
    // Absent, not failed. A ✗ beside a line that says "its absence is not a
    // defect" contradicts itself in the same row.
    ...(responded ? { passed: true } : { status: "not-applicable" as const }),
    detail: responded
      ? `A GET to ${where} answered HTTP ${graphql.status}, which is what a live endpoint says to a bare GET. Whether its schema is fully typed and its cost policy documented cannot be established read-only — introspection is normally disabled in production — so this is reported and not scored.`
      : `No GraphQL endpoint at ${where} (HTTP ${graphql.status})${landing.hops.length > 0 && !stayedPut ? " — the request was redirected away from the GraphQL path, so whatever answered was not it" : ""}. Not scored either way: most sites have none, and its absence is not a defect.`,
  };
}

// ── The four per-operation fractions, as data ─────────────────────────────────

/**
 * One fraction check, declared rather than written out.
 *
 * Four of these existed as four near-identical thirty-line blocks, each rebuilding
 * the same base object twice — once for the no-spec fallback and once inside the
 * body that had the spec. The parts that actually differ are the count and the
 * sentence, so those are the only parts left.
 */
type FractionCheck = {
  name: string;
  points: number;
  /**
   * Where the verdict gets its authority, per check rather than per module.
   *
   * Three of these four count something the spec either says or does not — an
   * `operationId`, a `description`, a `schema` on a parameter — and are facts
   * about the document. The fourth is judged against a rule of ours and says so.
   */
  source?: CheckSource;
  count: (spec: Spec) => { met: number; total: number; missing: string[] };
  /** What to say when the spec declares no operations at all. */
  nothingToCount: string;
  say: (met: number, total: number, missing: readonly string[]) => string;
};

const FRACTION_CHECKS: FractionCheck[] = [
  {
    // First, and worth the most: it is the line that started #388.
    name: "Every operation declares a typed response schema",
    points: 20,
    // Ours, not a fact: `describesPayload` is our rule for what makes a schema say
    // something, and it is the rule this whole fraction is judged against.
    source: AGENT_HTTP_THRESHOLD,
    count: (spec) => fraction(spec.operations, (operation) => hasTypedResponse(operation, spec.doc)),
    nothingToCount: "The spec declares no operations, so there is nothing to type.",
    say: (met, total, missing) =>
      `${met}/${total} typed response schemas.${missing.length ? ` Untyped: ${names(missing)}. An agent doing function calling against this spec knows what to call and does not know what comes back.` : " An agent can predict the shape of every successful response."}`,
  },
  {
    name: "Every operation has a unique operationId",
    points: 10,
    count: countOperationIds,
    nothingToCount: "The spec declares no operations, so there is nothing to name.",
    say: (met, total, missing) =>
      `${met}/${total} operationIds, unique.${missing.length ? ` Missing or duplicated: ${names(missing)}. A generated client names these itself, and two operations sharing an id silently keep one.` : " Every operation has a stable name a generated client can use."}`,
  },
  {
    name: "Every operation is described",
    points: 10,
    count: (spec) =>
      fraction(
        spec.operations,
        (operation) =>
          (typeof operation.op.description === "string" && operation.op.description.trim().length > 0) ||
          (typeof operation.op.summary === "string" && operation.op.summary.trim().length > 0),
      ),
    nothingToCount: "The spec declares no operations, so there is nothing to describe.",
    say: (met, total, missing) =>
      `${met}/${total} operations carry a description or summary.${missing.length ? ` Undescribed: ${names(missing)}. A model choosing between operations has only the name to go on.` : ""}`,
  },
  {
    name: "Every declared parameter is typed",
    points: 10,
    count: (spec) => fraction(spec.operations, hasTypedParameters),
    nothingToCount: "The spec declares no operations, so there are no parameters to type.",
    say: (met, total, missing) =>
      `${met}/${total} operations have every parameter typed.${missing.length ? ` Untyped parameters on: ${names(missing)}.` : " An operation with no parameters counts as typed, not as untyped."}`,
  },
];

function runFraction(check: FractionCheck, spec: Spec, base: Base): ApiSurfaceCheck {
  const { met, total, missing } = check.count(spec);
  if (total === 0) {
    return { ...base, status: "not-applicable", detail: check.nothingToCount };
  }
  return {
    ...base,
    earned: earnedFor(base.points, met, total),
    passed: met === total,
    detail: check.say(met, total, missing),
  };
}

// ── Entry point ───────────────────────────────────────────────────────────────

/**
 * Audit the API surface an agent would have to call.
 *
 * Request budget: one landing, up to seven discovery probes (five conventional
 * paths, plus whatever a `Link` header or an api-catalog advertises), one
 * error-shape probe and one GraphQL probe. All GET, all read-only, none
 * authenticated.
 */
export async function auditAgentApiSurface(url: string): Promise<Result<AgentApiSurfaceResult>> {
  try {
    validateUrl(url);

    const landing = await land(url);
    const origin = new URL(landing.finalUrl).origin;
    const { spec, unparsed, tried } = await findSpec(landing);

    const { base: apiBase, reason: baseReason } = spec
      ? apiBaseOf(spec, landing.finalUrl)
      : { base: null, reason: null };

    // Both probes are landed rather than fetched once, for the reason the HTTP
    // tier learned the hard way: a locale guard answers `/x` with a 308 to
    // `/en/x`, and reading the redirect as the answer reports "your errors are
    // text/plain" about a response that is not an error document at all.
    const probeUrl = apiBase ? `${apiBase}${PROBE_PATH}` : null;
    const [errorLanding, graphql] = await Promise.all([
      probeUrl ? land(probeUrl) : Promise.resolve(null),
      land(`${origin}${GRAPHQL_PATH}`),
    ]);

    const errorRequest = curl(probeUrl ?? `${origin}${PROBE_PATH}`, {
      body: true,
      followed: (errorLanding?.hops.length ?? 0) > 0,
    });

    /** The base every spec-gated check shares: same weight, same evidence, same source. */
    const gated = (name: string, points: number, source: CheckSource = AGENT_HTTP_FACT): Base => ({
      name,
      points,
      source,
      // The spec we read, the spec we could not read, or where one would live —
      // in that order, so the line always points at the document under discussion.
      request: curl(spec?.url ?? unparsed?.url ?? `${origin}${SPEC_PATHS[0]}`, { body: true }),
    });

    const checks: ApiSurfaceCheck[] = [
      checkDiscovery(spec, unparsed, tried),

      ...FRACTION_CHECKS.map((check) => {
        const base = gated(check.name, check.points, check.source);
        return specCheck(base, spec, unparsed, tried, (found) => runFraction(check, found, base));
      }),

      // Built once and passed to both halves. Two calls with the same arguments is
      // two places to keep in step, which is how a name and its weight drift apart.
      ((base) => specCheck(base, spec, unparsed, tried, (found) => checkVersioning(found, base)))(
        // Ours: `/v\d+/` and the accepted parameter names are patterns we chose,
        // and tightening them is what stopped this check passing our own spec on a
        // protocol-version header.
        gated("The API declares a version an agent can pin to", 10, AGENT_HTTP_THRESHOLD),
      ),

      // Both response-shape checks are gated on the spec the same way the fraction
      // checks are, and through the same helper: an unparsed spec makes them
      // `not-evaluated`, not `not-applicable`. Hand-rolling the gate here made a
      // YAML spec produce 25 points of "does not apply" for two questions we
      // simply never got to ask.
      specCheck(
        { name: "Errors come back as parseable JSON", points: 15, request: errorRequest, source: AGENT_HTTP_THRESHOLD },
        spec,
        unparsed,
        tried,
        () => checkErrorShape(errorLanding, baseReason, errorRequest),
      ),

      specCheck(
        {
          name: "API responses state the caller's remaining budget",
          points: 10,
          request: errorRequest,
          source: AGENT_HTTP_THRESHOLD,
        },
        spec,
        unparsed,
        tried,
        () => checkRateLimitHeaders(errorLanding, baseReason, errorRequest),
      ),

      checkGraphql(graphql),
    ];

    const { score, max, notApplicable, notEvaluated } = tally(checks);

    return success({
      url,
      specUrl: spec?.url ?? null,
      apiBase,
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

/**
 * Where the spec is, or where we looked for it. Informational, worth nothing.
 *
 * Not priced, and for the reason ADR-0025 records: "publishes an OpenAPI spec" is
 * a property of having an API at all, and a site with no API must not read as a
 * site with a failing one. The gate belongs in the other checks' `not-applicable`,
 * not in a zero here.
 */
function checkDiscovery(spec: Spec | null, unparsed: Unparsed | null, tried: readonly string[]): ApiSurfaceCheck {
  const base: Base = {
    name: "API description discovered (informational)",
    points: 0,
    request: curl(spec?.url ?? unparsed?.url ?? tried[0] ?? "", { body: true }),
    source: AGENT_HTTP_FACT,
  };

  if (spec) {
    const version = typeof spec.doc.openapi === "string" ? spec.doc.openapi : String(spec.doc.swagger);
    return {
      ...base,
      passed: true,
      detail: `Found at ${spec.url}: OpenAPI ${version}, ${spec.operations.length} operation${spec.operations.length === 1 ? "" : "s"}. Everything below is measured against it.`,
    };
  }

  if (unparsed) {
    return {
      ...base,
      passed: true,
      detail: `Found at ${unparsed.url}, and not read: ${unparsed.reason}. The checks below are marked not evaluated rather than not applicable — you have a spec, we could not measure it.`,
    };
  }

  return {
    ...base,
    // `not-applicable`, not `passed: false`: `render-check.ts` would print a red
    // cross next to a sentence saying this is not a failing site.
    status: "not-applicable",
    detail: `None found. Looked at: ${tried.join(", ") || "no candidate locations"}. Nothing below is scored, and a site with no API is not a site with a failing API.`,
  };
}
