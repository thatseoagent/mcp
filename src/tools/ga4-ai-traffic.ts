import { z } from "zod";
import { type ToolMetadata, type InferSchema } from "xmcp";
import { defineGoogleTool } from "../lib/define-tool";
import { DEFAULT_DAYS, ga4PropertySchema, ga4Window } from "../lib/google/ga4-tool-shape";
import { toolText } from "../lib/tool-result";
import { AI_REFERRER_HOSTS } from "../lib/google/ai-referrers";
import {
  aiReferred,
  REFERRER_ONLY_CAVEAT,
  type AiSource,
} from "../lib/google/traffic-segments";
import type { GoogleReader } from "../lib/google/reader";
import { capped } from "../lib/render-list";
import { basisSection } from "../lib/render-basis";

export const schema = {
  ...ga4PropertySchema,
  days: z
    .number()
    .int()
    .min(7)
    .max(90)
    .optional()
    .describe("Lookback window in days. Default 28. Compared against the window before it."),
};

export const metadata: ToolMetadata = {
  name: "ga4_ai_traffic",
  description:
    "How much traffic arrives from AI assistants — ChatGPT, Perplexity, Claude, " +
    "Gemini, Copilot and the rest — which sources send it, which pages they land on, " +
    "and whether it is growing. No other Tool here answers this. Needs the Google " +
    "login; without it this Tool says so.",
  annotations: {
    title: "Read AI assistant traffic",
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: true,
  },
};

/** Completes the sentence "Could not …" for every failure this Tool can return. */
const FAILURE_CONTEXT = "read AI assistant traffic for this Analytics property";

/** How many landing pages to print. */
const MAX_PAGES = 15;

function percent(value: number): string {
  return `${value.toFixed(2)}%`;
}

/**
 * `12 users`, or `up to 12 users` when the figure is two rows added together.
 *
 * Said rather than rounded away: a source Google began classifying partway
 * through the window arrives under both mediums, and one person who came back
 * on both sides of the change is in both rows.
 */
function describeUsers(source: AiSource): string {
  const users = Math.round(source.users ?? 0);
  return source.usersUpperBound ? `up to ${users} users` : `${users} users`;
}

/** `+31%`, `-12%`, or a note that there is nothing to compare against. */
function describeChange(now: number, before: number): string {
  if (before === 0) {
    return now > 0 ? "new — nothing in the previous window" : "nothing in either window";
  }
  const change = ((now - before) / before) * 100;
  const sign = change >= 0 ? "+" : "";
  return `${sign}${change.toFixed(0)}% against the previous window (${before})`;
}

export async function handler(
  { propertyId, days }: InferSchema<typeof schema>,
  google: GoogleReader,
) {
  const span = days ?? DEFAULT_DAYS;
  const window = ga4Window({ propertyId, days: span }, {
    title: `AI ASSISTANT TRAFFIC (last ${span} days)`,
  });

  // GA4's relative dates, not dates computed here — `ga4-tool-shape.ts` carries
  // the timezone reasoning for the current window, and this is the comparison.
  // The arithmetic is the trap: both ends are inclusive, so running the current
  // period from `days` ago to *today* while the comparison ran exactly `days`
  // made the current window a day longer and inflated every delta.
  const previous = { startDate: `${span * 2}daysAgo`, endDate: `${span + 1}daysAgo` };

  // By source with users, by landing page, and the previous window: users are
  // read at the source's own grain, for the reason `traffic-segments.ts` gives.
  const ai = await aiReferred(google, window, {
    byLanding: true,
    withUsers: true,
    compareWith: previous,
  });
  const landings = ai.landings ?? { pages: [], unattributed: 0 };
  const before = ai.previous ?? { sessions: 0, bySource: new Map<string, number>() };

  const lines: string[] = [...window.header];

  // Sampling, thresholding and truncation apply to every figure here, and to
  // an empty answer most of all — a thresholded report can be empty because
  // GA4 withheld the rows. So the basis section closes both answers, and it is
  // the one place a reader looks for them in every Tool.
  const basis = basisSection({
    read: [`Hosts on the supplementary list: ${AI_REFERRER_HOSTS.join(", ")}.`],
    caveats: ai.caveats,
    limits: REFERRER_ONLY_CAVEAT,
  });

  if (ai.sources.length === 0) {
    lines.push("");
    lines.push("No AI assistant traffic in this window.");
    lines.push("");
    lines.push('GA4 classified nothing as its "AI Assistant" channel, and no referral arrived');
    lines.push("from a host on the supplementary list this Tool keeps.");
    lines.push("");
    lines.push("That is a measurement, not a verdict on the site. It can mean AI engines are");
    lines.push("not citing you yet; it can also mean they cite you and readers arrive without a");
    lines.push("referrer, which is common — an assistant that summarises your page rather than");
    lines.push("linking to it sends no visit at all. seo_geo_score and ai_visibility_score look");
    lines.push("at whether the content is set up to be cited, which is the half this cannot see.");
    lines.push(...basis);
    return toolText(lines.join("\n"));
  }

  // GA4's own total, never a sum of rows: see `siteSessions`.
  const siteSessions = ai.siteSessions ?? 0;

  lines.push("");
  lines.push("=== SUMMARY ===");
  lines.push(`AI sessions: ${Math.round(ai.sessions)}`);
  lines.push(
    siteSessions > 0
      ? `Share of all sessions: ${percent((ai.sessions / siteSessions) * 100)} of ${Math.round(siteSessions)}`
      : "Share of all sessions: not available — GA4 reported no site total for this window",
  );
  lines.push(`Change: ${describeChange(ai.sessions, before.sessions)}`);

  if (ai.fromHostList > 0) {
    // Google's answer and ours are not the same claim, and a report that mixed
    // them owes the reader the difference.
    lines.push("");
    lines.push(
      `Of those, ${Math.round(ai.fromHostList)} session(s) were counted by this Tool's own host list ` +
        `rather than by Google's classification. Google moves recognised assistants into its ` +
        `"AI Assistant" channel; the list covers engines it has not recognised yet.`,
    );
  }

  lines.push("");
  lines.push(`=== BY SOURCE (${ai.sources.length}) ===`);
  for (const source of ai.sources) {
    lines.push(
      `  ${source.source} — ${Math.round(source.sessions)} sessions, ${describeUsers(source)}` +
        ` — ${describeChange(source.sessions, before.bySource.get(source.source) ?? 0)}`,
    );
    if (source.fromHostList === source.sessions) {
      lines.push("    (counted by this Tool's host list, not by Google's own classification)");
    } else if (source.fromHostList > 0) {
      lines.push(
        `    (${Math.round(source.fromHostList)} of these counted by this Tool's host list; ` +
          "the rest by Google's own classification)",
      );
    }
  }

  if (landings.pages.length > 0 || landings.unattributed > 0) {
    lines.push("");
    lines.push(`=== LANDING PAGES (${landings.pages.length}) ===`);
    lines.push("Where AI assistants are sending people. These are the pages being cited.");
    lines.push(
      ...capped(
        landings.pages.map(({ page, sessions }) => `${page} — ${Math.round(sessions)} sessions`),
        MAX_PAGES,
      ),
    );
    if (landings.unattributed > 0) {
      lines.push(
        `  (${Math.round(landings.unattributed)} AI-referred session(s) had no landing page GA4 could name ` +
          "and are on no page above.)",
      );
    }
  }

  lines.push(...basis);

  return toolText(lines.join("\n"));
}

export default defineGoogleTool(
  FAILURE_CONTEXT,
  { toolName: "ga4_ai_traffic", domainOf: () => null },
  handler,
);
