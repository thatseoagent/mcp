import { z } from "zod";
import { type ToolMetadata, type InferSchema } from "xmcp";
import {
  lookupWebRisk,
  THREAT_TYPES,
  WEB_RISK_KEY_REQUIREMENT,
  type ThreatType,
  type WebRiskVerdict,
} from "../lib/web-risk";
import { validateUrl } from "../lib/http-client";
import { InvalidInputError } from "../lib/invalid-input-error";
import { defineTool } from "../lib/define-tool";
import { toolText } from "../lib/tool-result";

/** Google's per-request unit is one URL; ten is a reading depth, stated here. */
const MAX_URLS = 10;

export const schema = {
  url: z
    .string()
    .url()
    .describe("The site's homepage, or any URL on it. Its homepage is always looked up"),
  urls: z
    .array(z.string().url())
    .max(MAX_URLS - 1)
    .optional()
    .describe(
      `Up to ${MAX_URLS - 1} more URLs to look up besides the homepage — pages on the site, ` +
        "or pages it links out to. Default: the homepage alone",
    ),
};

export const metadata: ToolMetadata = {
  name: "web_risk_check",
  description:
    "Check whether Google lists a site's homepage, and up to nine other URLs, as malware, " +
    "phishing (social engineering) or unwanted software, through Google's Web Risk API. " +
    "Search Console's Security Issues report has no API, so this is the only programmatic " +
    "way to see what it would show; \"not flagged\" means not on Google's lists at the moment " +
    "of lookup. " +
    `Needs ${WEB_RISK_KEY_REQUIREMENT.variable} with the Web Risk API enabled on a Google Cloud ` +
    "project that has billing (100,000 lookups a month are free); without it this Tool returns " +
    "an error saying so.",
  annotations: {
    title: "Check Google's unsafe-site lists",
    readOnlyHint: true,
    destructiveHint: false,
    // A lookup reads a list; asking twice asks the same question. The lists
    // themselves change, which is why the answer is never cached — see below.
    idempotentHint: true,
    openWorldHint: true,
  },
};

/** Completes the sentence "Could not …" for every failure this Tool can return. */
const FAILURE_CONTEXT = "look these URLs up on Google's Web Risk lists";

/** Google's list names, as a person reads them. */
const LIST_NAMES: Record<ThreatType, string> = {
  MALWARE: "malware",
  SOCIAL_ENGINEERING: "social engineering (phishing, deceptive pages)",
  UNWANTED_SOFTWARE: "unwanted software",
  SOCIAL_ENGINEERING_EXTENDED_COVERAGE: "social engineering, extended coverage",
};

/**
 * The homepage first, then the rest in the order given, each once.
 *
 * Deduplicated on the parsed URL so `https://a.com` and `https://a.com/` are
 * one lookup. The cap is checked after that, since a caller who repeats the
 * homepage in `urls` has not asked for eleven.
 */
function urlsToCheck(url: string, extra: readonly string[]): string[] {
  const homepage = new URL("/", url).toString();
  const seen = new Set<string>();
  const out: string[] = [];
  for (const candidate of [homepage, ...extra]) {
    validateUrl(candidate);
    const normalised = new URL(candidate).toString();
    if (seen.has(normalised)) continue;
    seen.add(normalised);
    out.push(normalised);
  }
  if (out.length > MAX_URLS) {
    throw new InvalidInputError(
      `urls: at most ${MAX_URLS} URLs can be looked up in one call, the homepage included; ` +
        `${out.length} were given.`,
    );
  }
  return out;
}

function renderFlagged(verdict: Extract<WebRiskVerdict, { flagged: true }>): string[] {
  const lines = [`  ${verdict.url}`];
  lines.push(
    verdict.threatTypes.length > 0
      ? `    On: ${verdict.threatTypes.map((type) => LIST_NAMES[type]).join("; ")}`
      : "    On: a list this Tool does not recognise by name — Google matched it all the same",
  );

  const onlyExtended =
    verdict.threatTypes.length > 0 &&
    verdict.threatTypes.every((type) => type === "SOCIAL_ENGINEERING_EXTENDED_COVERAGE");
  if (onlyExtended) {
    lines.push(
      "    Only on the extended-coverage list, which Google says it categorises with lower",
      "    confidence and a slightly higher chance of a false positive; browsers may not show a",
      "    warning for it. Still worth investigating, but not the same finding as the main lists.",
    );
  }

  lines.push(
    verdict.expireTime
      ? `    Google says this match holds until ${verdict.expireTime}; look it up again after that.`
      : "    Google gave no expiry for this match.",
  );
  return lines;
}

/**
 * Not wrapped in the Tool cache, and that is a condition of the API rather than
 * a preference: a match comes with an `expireTime` and Google's reference says
 * "Clients must not cache this response past this timestamp to avoid false
 * positives." The Tool cache holds an answer for a fixed time per Tool, which
 * cannot follow a per-response expiry, so any fixed TTL would sooner or later
 * serve a stale "flagged" — or a stale "not flagged" for a site that was
 * listed since. Every call is a fresh lookup, and there is no `force_refresh`
 * because there is nothing to bypass.
 */
export async function handler({ url, urls }: InferSchema<typeof schema>) {
  const targets = urlsToCheck(url, urls ?? []);

  // One after another rather than all at once. They are all to the same Google
  // host, so the pacing ledger would serialise them anyway, and a failure part
  // way through is a failure of the whole call: a list with some URLs missing
  // is the partial result ADR-0003 forbids.
  const verdicts: WebRiskVerdict[] = [];
  for (const target of targets) verdicts.push(await lookupWebRisk(target));

  const flagged = verdicts.filter(
    (v): v is Extract<WebRiskVerdict, { flagged: true }> => v.flagged,
  );
  const clean = verdicts.filter((v) => !v.flagged);

  const lines = [
    "=== GOOGLE WEB RISK LOOKUP ===",
    "",
    `Looked up: ${targets.length} URL${targets.length === 1 ? "" : "s"}, at ${new Date().toISOString()}`,
    `Lists asked: ${THREAT_TYPES.map((type) => LIST_NAMES[type]).join("; ")}`,
    "",
    flagged.length === 0
      ? `Verdict: none of the ${targets.length} URL${targets.length === 1 ? " is" : "s is"} on Google's lists.`
      : `Verdict: ${flagged.length} of ${targets.length} URL${targets.length === 1 ? " is" : "s are"} on Google's lists.`,
  ];

  if (flagged.length > 0) {
    lines.push("", `=== FLAGGED (${flagged.length}) ===`, "");
    for (const verdict of flagged) lines.push(...renderFlagged(verdict));
    lines.push(
      "",
      "Search Console's Security Issues report (https://search.google.com/search-console/security-issues)",
      "is where Google explains a listing on a property you own and where a review is requested",
      "once it is fixed.",
    );
  }

  if (clean.length > 0) {
    lines.push("", `=== NOT FLAGGED (${clean.length}) ===`, "");
    for (const verdict of clean) lines.push(`  ${verdict.url}`);
  }

  lines.push(
    "",
    "=== HOW TO READ THIS ===",
    "",
    "- \"Not flagged\" means the URL was not on Google's lists at the moment of lookup. It is not a",
    "  security audit of the site, and Google itself says \"some risky sites may not be identified,",
    "  and some safe sites may be classified in error.\"",
    "- Search Console's Security Issues report has no API, so looking each URL up on the lists",
    "  behind it is the only programmatic way to see what that report would show. The report is",
    "  about the whole property and carries Google's reasons; this reads one URL at a time.",
    "- Web Risk is used rather than Safe Browsing because Google licenses the Safe Browsing API",
    "  for non-commercial use only and points commercial use here.",
    "- Google's Web Risk terms say these results must not be redistributed.",
    `- Not cached: every call is a fresh lookup, one per URL (${targets.length} this time), counted`,
    "  against the project's 100,000 free lookups a month.",
  );

  return toolText(lines.join("\n"));
}

export default defineTool(FAILURE_CONTEXT, handler);
