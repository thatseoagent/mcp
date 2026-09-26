import { z } from "zod";
import { type ToolMetadata, type InferSchema } from "xmcp";
import { defineGoogleTool } from "../lib/define-tool";
import { DEFAULT_DAYS, ga4PropertySchema, ga4Window } from "../lib/google/ga4-tool-shape";
import { aiReferred, REFERRER_ONLY_CAVEAT } from "../lib/google/traffic-segments";
import type { GoogleReader } from "../lib/google/reader";
import { AI_CRAWLERS, type AiCrawlerPurpose } from "../lib/ai-crawlers";
import {
  ASSISTANT_OPERATORS,
  operatorForSource,
  type AssistantOperator,
} from "../lib/ai-assistant-operators";
import {
  NO_ROBOTS,
  parseRobots,
  USAGE_CATEGORIES,
  type RobotsRuleset,
} from "../lib/analyzers/robots-ruleset";
import { readWellKnown } from "../lib/well-known";
import { siteOrigin } from "../lib/url-match";
import { domainFromUrl } from "../lib/with-cache";
import { toolText } from "../lib/tool-result";
import { capped } from "../lib/render-list";
import { basisSection, notCheckedSection } from "../lib/render-basis";

export const schema = {
  ...ga4PropertySchema,
  site: z
    .string()
    .describe(
      "The site this GA4 property measures: `example.com` or `https://www.example.com`. " +
        "Its robots.txt is read from this origin.",
    ),
  days: z
    .number()
    .int()
    .min(7)
    .max(90)
    .optional()
    .describe("Lookback window in days. Default 28."),
};

export const metadata: ToolMetadata = {
  name: "site_ai_crawler_traffic",
  description:
    "Does the site's robots.txt stand between it and the AI assistants sending it visitors? " +
    "Reads robots.txt for every known AI crawler, grouped by what it is for — AI search, " +
    "user-requested fetches, training — and crosses it with AI-referred sessions per assistant " +
    "from GA4: flags a blocked search crawler for an assistant that is still referring, and says " +
    "when a block is only a training opt-out. Needs the Google login; without it this Tool says so.",
  annotations: {
    title: "Cross AI crawler rules with AI traffic",
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: true,
  },
};

/** Completes the sentence "Could not …" for every failure this Tool can return. */
const FAILURE_CONTEXT = "cross this site's AI crawler rules with its AI assistant traffic";

/** How each purpose is headed, in the order a reader should meet them. */
const PURPOSE_HEADINGS: ReadonlyArray<[AiCrawlerPurpose, string]> = [
  ["search", "AI search (build the index an assistant's answers cite from)"],
  ["user-fetch", "Fetches on a user's request"],
  ["training", "Model training (blocking these is the training opt-out)"],
  ["control-token", "Control tokens (not crawlers; they govern how fetched content is used)"],
];

/** How many unjoined AI sources to print. */
const MAX_UNJOINED = 10;

/** What robots.txt says about one token, or `null` when the file was not read. */
type Access = { state: "blocked" | "restricted" | "allowed"; patterns: string[] };

function accessFor(rules: RobotsRuleset, token: string): Access {
  const patterns = rules.restrictionsFor(token);
  if (rules.blocksEntirely(token)) return { state: "blocked", patterns };
  return { state: patterns.length > 0 ? "restricted" : "allowed", patterns };
}

function describeAccess(access: Access): string {
  if (access.state === "blocked") return "BLOCKED";
  if (access.state === "restricted") {
    return `allowed at the root, restricted by ${access.patterns.length} Disallow pattern(s)`;
  }
  return "allowed";
}

function joinTokens(tokens: readonly string[]): string {
  return tokens.join(", ");
}

/**
 * The Content-Signal preferences a file states to one token, as a line, or `null`.
 *
 * Reported beside the access rule because it is the easiest thing in the file to
 * misread as one: a preference about how fetched content may be used, blocking
 * nothing.
 */
function usagePreferenceLine(rules: RobotsRuleset, token: string): string | null {
  const stated = rules.usagePreferencesFor(token);
  const parts = USAGE_CATEGORIES.filter((c) => stated[c] !== undefined).map((c) => `${c}=${stated[c]}`);
  if (parts.length === 0) return null;
  return (
    `Content-Signal stated to ${token}: ${parts.join(", ")} — a usage preference, not an ` +
    "access rule; it blocks nothing and binds only crawlers that choose to honour it."
  );
}

/**
 * One assistant, read against the rules and its referrals.
 *
 * Returns the lines to print and whether any of them is a risk. Every sentence
 * that says what blocking a crawler does quotes the operator — the table in
 * `ai-assistant-operators.ts` carries the quotation and the URL — because the
 * consequence is theirs to state, not ours to predict.
 */
function readAssistant(
  entry: AssistantOperator,
  rules: RobotsRuleset | null,
  sessions: number,
): { lines: string[]; risks: number } {
  const lines: string[] = [];
  let risks = 0;

  if (entry.inference) lines.push(`  (Inference: ${entry.inference})`);

  if (rules === null) {
    lines.push("  Rules: not checked — robots.txt could not be read, so nothing is said here");
    lines.push("  about whether its crawlers are allowed.");
    lines.push(`  Docs: ${entry.docs.join(" ")}`);
    return { lines, risks };
  }

  const search = entry.search.map((token) => ({ token, access: accessFor(rules, token) }));
  const userFetch = entry.userFetch.map((token) => ({ token, access: accessFor(rules, token) }));
  const training = entry.training.map((token) => ({ token, access: accessFor(rules, token) }));
  const controls = entry.answerControls.map((token) => ({ token, access: accessFor(rules, token) }));

  for (const { token, access } of search) lines.push(`  Search crawler ${token}: ${describeAccess(access)}`);
  for (const { token, access } of controls) lines.push(`  Answer control ${token}: ${describeAccess(access)}`);
  for (const { token, access } of userFetch) lines.push(`  On a user's request, ${token}: ${describeAccess(access)}`);
  for (const { token, access } of training) lines.push(`  Training crawler ${token}: ${describeAccess(access)}`);
  for (const token of entry.search) {
    const preference = usagePreferenceLine(rules, token);
    if (preference) lines.push(`  ${preference}`);
  }

  const searchBlocked = search.filter((s) => s.access.state === "blocked").map((s) => s.token);
  const searchRestricted = search.filter((s) => s.access.state === "restricted");
  const controlsBlocked = controls.filter((c) => c.access.state === "blocked").map((c) => c.token);
  const userBlocked = userFetch.filter((u) => u.access.state === "blocked").map((u) => u.token);
  const trainingBlocked = training.filter((t) => t.access.state === "blocked").map((t) => t.token);

  if (searchBlocked.length > 0 && sessions > 0) {
    risks++;
    lines.push(
      `  RISK: ${joinTokens(searchBlocked)} is blocked while ${entry.assistant} sent ` +
        `${Math.round(sessions)} session(s) in this window. ${entry.searchBlockEffect}`,
    );
    lines.push(
      "  The referrals can still come from answers built before the block, navigational links",
    );
    lines.push(
      "  or user-requested fetches; as those go stale, citations may drop. A risk read off two",
    );
    lines.push("  facts side by side, not a measured decline.");
  } else if (searchBlocked.length > 0) {
    lines.push(
      `  Reading: ${joinTokens(searchBlocked)} is blocked and ${entry.assistant} sent no referrals ` +
        "in this window — the two agree. Allowing it is what would make the site citable there; " +
        `whether it would be cited, robots.txt does not decide. ${entry.searchBlockEffect}`,
    );
  }

  for (const { token, access } of searchRestricted) {
    lines.push(
      `  Reading: ${token} may fetch the site root but not paths matching ` +
        `${access.patterns.slice(0, 5).join(", ")}${access.patterns.length > 5 ? " (and others)" : ""}. ` +
        "Pages under those paths cannot enter the index its answers cite from.",
    );
  }

  if (controlsBlocked.length > 0) {
    if (sessions > 0) risks++;
    lines.push(
      `  ${sessions > 0 ? "RISK" : "Reading"}: ${joinTokens(controlsBlocked)} is blocked` +
        (sessions > 0 ? ` while ${entry.assistant} sent ${Math.round(sessions)} session(s).` : ".") +
        (entry.answerControlEffect ? ` ${entry.answerControlEffect}` : ""),
    );
  }

  if (userBlocked.length > 0) {
    lines.push(
      entry.userFetchRobotsNote
        ? `  Reading: ${joinTokens(userBlocked)} is blocked, but ${entry.userFetchRobotsNote} ` +
            "The rule may not be obeyed."
        : `  Reading: ${joinTokens(userBlocked)} is blocked, so a person asking ${entry.assistant} ` +
            "to read one of these pages is refused. The operator says it honours robots.txt for it.",
    );
  }

  if (trainingBlocked.length > 0 && searchBlocked.length === 0 && controlsBlocked.length === 0) {
    lines.push(
      `  Reading: training opt-out only. ${entry.operator} documents ${joinTokens(trainingBlocked)} ` +
        `as a training crawler separate from ${joinTokens(entry.search)}, so blocking it does not ` +
        `affect whether ${entry.assistant}'s answers can cite the site.`,
    );
  }

  const nothingBlocked =
    searchBlocked.length === 0 &&
    searchRestricted.length === 0 &&
    controlsBlocked.length === 0 &&
    userBlocked.length === 0 &&
    trainingBlocked.length === 0;
  if (nothingBlocked) {
    lines.push(
      sessions > 0
        ? "  Reading: crawlable and referring. Nothing in robots.txt stands between this assistant and the site."
        : "  Reading: everything allowed and no referrals in this window. Not a problem by itself — " +
            "being crawlable makes a page citable, not cited, and visits that carried no referrer " +
            "are not counted here.",
    );
  }

  lines.push(`  Docs: ${entry.docs.join(" ")}`);
  return { lines, risks };
}

export async function handler(
  { propertyId, site, days }: InferSchema<typeof schema>,
  google: GoogleReader,
) {
  const span = days ?? DEFAULT_DAYS;
  const origin = siteOrigin(site);
  const window = ga4Window({ propertyId, days: span }, {
    title: `AI CRAWLER RULES AGAINST AI TRAFFIC (last ${span} days)`,
  });

  // GA4 first and alone. A refusal is the whole answer, and reading a stranger's
  // robots.txt for a report that will not be delivered is a request for nothing.
  const ai = await aiReferred(google, window);

  // Three states, from the module that exists to keep them apart. `absent` is an
  // answer — no file, no rules, every crawler allowed. `unavailable` is not, and
  // reading it as "allowed" is the mistake `well-known.ts` records making.
  const robots = await readWellKnown(origin, "/robots.txt");
  const rules: RobotsRuleset | null =
    robots.outcome === "found"
      ? parseRobots(robots.text)
      : robots.outcome === "absent"
        ? NO_ROBOTS
        : null;

  const byAssistant = new Map<string, { sessions: number; fromHostList: number }>();
  const unjoined = new Map<string, number>();
  const total = ai.sessions;
  for (const source of ai.sources) {
    const entry = operatorForSource(source.source);
    if (!entry) {
      unjoined.set(source.source, source.sessions);
      continue;
    }
    const current = byAssistant.get(entry.assistant) ?? { sessions: 0, fromHostList: 0 };
    current.sessions += source.sessions;
    current.fromHostList += source.fromHostList;
    byAssistant.set(entry.assistant, current);
  }

  const lines: string[] = [...window.header];
  lines.push(`Site: ${origin}`);
  if (robots.outcome === "found") {
    lines.push(`robots.txt: read from ${origin}/robots.txt`);
  } else if (robots.outcome === "absent") {
    lines.push(
      `robots.txt: none (HTTP ${robots.status}), so nothing is disallowed to any crawler.`,
    );
  } else {
    lines.push(`robots.txt: NOT CHECKED — ${robots.reason}. Every rule below is not checked.`);
  }

  const readings = ASSISTANT_OPERATORS.map((entry) => {
    const traffic = byAssistant.get(entry.assistant) ?? { sessions: 0, fromHostList: 0 };
    return { entry, traffic, ...readAssistant(entry, rules, traffic.sessions) };
  });
  const risks = readings.reduce((sum, r) => sum + r.risks, 0);

  lines.push("");
  lines.push("=== SUMMARY ===");
  lines.push(`AI-referred sessions in the window: ${Math.round(total)}`);
  if (total === 0) {
    lines.push(
      'GA4 classified nothing as its "AI Assistant" channel, and no referral arrived from a host',
    );
    lines.push("on the supplementary list. That is a measurement of referred visits, not a verdict.");
  }
  lines.push(
    rules === null
      ? "Risks flagged: not checked — robots.txt could not be read."
      : `Risks flagged: ${risks}`,
  );

  lines.push("");
  lines.push("=== ROBOTS.TXT, BY WHAT EACH CRAWLER IS FOR ===");
  if (rules === null) {
    lines.push("Not checked — the reason is under NOT CHECKED below.");
  } else {
    for (const [purpose, heading] of PURPOSE_HEADINGS) {
      const crawlers = AI_CRAWLERS.filter((c) => c.purpose === purpose);
      if (crawlers.length === 0) continue;
      lines.push(`${heading}:`);
      for (const crawler of crawlers) {
        lines.push(`  ${crawler.name} (${crawler.description}): ${describeAccess(accessFor(rules, crawler.name))}`);
      }
    }
  }

  lines.push("");
  lines.push("=== BY ASSISTANT ===");
  for (const { entry, traffic, lines: assistantLines } of readings) {
    lines.push("");
    const hostList =
      traffic.fromHostList > 0
        ? ` (${Math.round(traffic.fromHostList)} counted by the host list rather than Google's classification)`
        : "";
    lines.push(
      `${entry.assistant} (${entry.operator}) — ${Math.round(traffic.sessions)} AI-referred session(s)${hostList}`,
    );
    lines.push(...assistantLines);
  }

  if (unjoined.size > 0) {
    lines.push("");
    lines.push(`=== AI SOURCES NOT JOINED TO A CRAWLER (${unjoined.size}) ===`);
    const ranked = [...unjoined.entries()].sort((a, b) => b[1] - a[1]);
    lines.push(
      ...capped(
        ranked.map(([source, sessions]) => `${source} — ${Math.round(sessions)} session(s)`),
        MAX_UNJOINED,
        { noun: "sources" },
      ),
    );
    lines.push("No crawler behind these assistants' answers is documented in a way this Tool could");
    lines.push("verify, so their robots.txt rules are left uncrossed rather than guessed at.");
  }

  // Said at the top and in every section it empties, and listed here as well,
  // because this is the heading a reader scans for what was not checked.
  if (robots.outcome === "unavailable") {
    lines.push(
      ...notCheckedSection([
        { subject: `${origin}/robots.txt`, reason: `${robots.reason}, so no crawler's rules were read` },
      ]),
    );
  }

  lines.push(
    ...basisSection({
      read: [],
      caveats: ai.caveats,
      limits: [
        ...REFERRER_ONLY_CAVEAT,
        "robots.txt is read as it stands today; the referrals span the whole window, so a rule",
        "changed during it is compared against traffic from before the change too.",
      ],
    }),
  );

  return toolText(lines.join("\n"));
}

export default defineGoogleTool(
  FAILURE_CONTEXT,
  { toolName: "site_ai_crawler_traffic", domainOf: ({ site }) => domainFromUrl({ url: site }) },
  handler,
);
