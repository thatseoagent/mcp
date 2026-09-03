import { z } from "zod";
import { type ToolMetadata, type InferSchema } from "xmcp";
import { defineGoogleTool } from "../lib/define-tool";
import { toolText } from "../lib/tool-result";
import { fetchRows, gscWindowSchema, whatTheseRowsAre } from "../lib/google/gsc-tool-shape";
import { DEFAULT_QUICK_WINS, quickWins } from "../lib/google/gsc-analysis";
import type { GoogleReader } from "../lib/google/reader";

export const schema = {
  ...gscWindowSchema,
  minImpressions: z
    .number()
    .int()
    .optional()
    .describe(`Ignore queries seen fewer times than this. Default ${DEFAULT_QUICK_WINS.minImpressions}.`),
  maxCtr: z
    .number()
    .optional()
    .describe(`Only queries below this CTR, as a percentage. Default ${DEFAULT_QUICK_WINS.maxCtr}.`),
};

export const metadata: ToolMetadata = {
  name: "gsc_detect_quick_wins",
  description:
    "Find queries the site is already being seen for, sitting just below the fold, and " +
    "not being clicked — the ones where a better title and description usually help " +
    "more than a ranking effort would. Needs the Google login; without it this Tool " +
    "says so.",
  annotations: {
    title: "Find quick wins in Search Console",
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: true,
  },
};

/** Completes the sentence "Could not …" for every failure this Tool can return. */
const FAILURE_CONTEXT = "find quick wins for this site";

/** How many to print. */
const MAX_SHOWN = 25;

export async function handler(args: InferSchema<typeof schema>, google: GoogleReader) {
  const { rows, header } = await fetchRows(google.searchConsole, args, {
    dimensions: ["query"],
    title: "QUICK WINS",
  });

  const config = {
    ...DEFAULT_QUICK_WINS,
    minImpressions: args.minImpressions ?? DEFAULT_QUICK_WINS.minImpressions,
    maxCtr: args.maxCtr ?? DEFAULT_QUICK_WINS.maxCtr,
  };
  const found = quickWins(rows, config);

  const lines = [...header];
  lines.push("");
  lines.push(
    `Looking for: at least ${config.minImpressions} impressions, CTR at or below ` +
      `${config.maxCtr}%, position between ${config.positionMin} and ${config.positionMax}.`,
  );
  lines.push(
    "Every one of those numbers is ours rather than Google's. The shape being looked for is",
  );
  lines.push("a query already being seen, just below the fold, that nobody clicks — usually a");
  lines.push("title problem rather than a ranking problem.");

  lines.push("");
  if (found.length === 0) {
    lines.push("No queries in this window match that shape.");
    lines.push("");
    lines.push("That is not a verdict on the site. It can mean the pages that rank are already");
    lines.push("earning their clicks, or that the window is too short for anything to clear the");
    lines.push("impression floor. Lower `minImpressions`, or widen the window, before reading");
    lines.push("anything into it.");
    lines.push(...whatTheseRowsAre(rows.length));
    return toolText(lines.join("\n"));
  }

  const potential = found.reduce((sum, win) => sum + win.potentialClicks, 0);
  lines.push(`Found: ${found.length}`);
  lines.push(
    `If every one reached ${config.targetCtr}% CTR they would add about ${potential} clicks ` +
      `over this window.`,
  );
  lines.push(
    "That figure is a floor built on a modest target, not a forecast — nothing here knows " +
      "whether a better title will actually earn the click.",
  );

  lines.push("");
  lines.push("query — impressions / clicks / CTR / position / clicks it could add");
  for (const win of found.slice(0, MAX_SHOWN)) {
    lines.push(
      `  ${win.query} — ${win.impressions} / ${win.clicks} / ${(win.ctr * 100).toFixed(2)}% / ` +
        `${win.position.toFixed(1)} / +${win.potentialClicks}`,
    );
  }
  if (found.length > MAX_SHOWN) {
    lines.push(`  ... and ${found.length - MAX_SHOWN} more`);
  }

  lines.push(...whatTheseRowsAre(rows.length));
  return toolText(lines.join("\n"));
}

export default defineGoogleTool(
  FAILURE_CONTEXT,
  { toolName: "gsc_detect_quick_wins", domainOf: (args) => args.siteUrl ?? null },
  handler,
);
