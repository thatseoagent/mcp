import { type ToolMetadata, type InferSchema } from "xmcp";
import { defineGoogleTool } from "../lib/define-tool";
import { toolText } from "../lib/tool-result";
import {
  fetchRows,
  gscWindowSchema,
  readPrecedingWindow,
} from "../lib/google/gsc-tool-shape";
import { biggestMovers, compareWindows } from "../lib/google/gsc-analysis";
import type { GoogleReader } from "../lib/google/reader";
import { withheld } from "../lib/render-list";

export const schema = { ...gscWindowSchema };

export const metadata: ToolMetadata = {
  name: "gsc_detect_trends",
  description:
    "Compare this window against the one immediately before it and report which " +
    "queries moved most, up and down. The comparison window is exactly the same " +
    "length, so the change is real rather than an artefact of one window being " +
    "longer. Needs the Google login; without it this Tool says so.",
  annotations: {
    title: "Compare two windows in Search Console",
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: true,
  },
};

/** Completes the sentence "Could not …" for every failure this Tool can return. */
const FAILURE_CONTEXT = "compare this site's search performance across two windows";

const MAX_SHOWN = 15;

/** `+12` / `-3`, so a reader does not have to work out the sign. */
function signed(value: number): string {
  return `${value >= 0 ? "+" : ""}${Math.round(value)}`;
}

export async function handler(args: InferSchema<typeof schema>, google: GoogleReader) {
  const current = await fetchRows(google.searchConsole, args, {
    dimensions: ["query"],
    title: "TRENDS",
  });

  const previous = await readPrecedingWindow(google.searchConsole, current, {
    dimensions: ["query"],
  });

  const movements = compareWindows(current.rows, previous.rows);
  const movers = biggestMovers(movements);

  const lines = [...current.header];
  lines.push(previous.line);
  lines.push("");

  if (movers.length === 0) {
    lines.push("No query in either window has enough clicks for a change to mean anything.");
    lines.push(...current.footer);
    return toolText(lines.join("\n"));
  }

  const up = movers.filter((movement) => movement.clicksChange > 0);
  const down = movers.filter((movement) => movement.clicksChange < 0);

  lines.push(`Queries that gained clicks: ${up.length}`);
  lines.push(`Queries that lost clicks: ${down.length}`);

  const render = (heading: string, list: typeof movers) => {
    if (list.length === 0) return;
    lines.push("");
    lines.push(`=== ${heading} ===`);
    for (const movement of list.slice(0, MAX_SHOWN)) {
      // Position is only printed when both windows had one. A query that just
      // appeared has no earlier rank, and subtracting from zero would report it
      // as having fallen from the top of page one.
      const rank = Number.isNaN(movement.positionChange)
        ? movement.before.impressions === 0
          ? " (new in this window)"
          : " (gone from this window)"
        : `, position ${movement.now.position.toFixed(1)} from ${movement.before.position.toFixed(1)}`;
      lines.push(
        `  ${movement.key} — ${signed(movement.clicksChange)} clicks ` +
          `(${Math.round(movement.now.clicks)} from ${Math.round(movement.before.clicks)})${rank}`,
      );
    }
    lines.push(...withheld(list.length, MAX_SHOWN));
  };

  render(`BIGGEST GAINS (${up.length})`, up);
  render(`BIGGEST LOSSES (${down.length})`, down);

  lines.push("");
  lines.push("=== READING THESE ===");
  lines.push("A query missing from one window is not necessarily a query with no traffic:");
  lines.push("Search Console withholds queries it considers personal and does not report every");
  lines.push("impression. Treat 'new' and 'gone' as changes in what was reported.");

  lines.push(...current.footer);
  return toolText(lines.join("\n"));
}

export default defineGoogleTool(
  FAILURE_CONTEXT,
  { toolName: "gsc_detect_trends", domainOf: (args) => args.siteUrl ?? null },
  handler,
);
