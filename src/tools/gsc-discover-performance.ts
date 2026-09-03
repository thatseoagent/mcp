import { type ToolMetadata, type InferSchema } from "xmcp";
import { defineGoogleTool } from "../lib/define-tool";
import { toolText } from "../lib/tool-result";
import { fetchRows, gscWindowSchema, whatTheseRowsAre } from "../lib/google/gsc-tool-shape";
import { keyOf, totalsOf } from "../lib/google/gsc-analysis";
import type { GoogleReader } from "../lib/google/reader";

export const schema = { ...gscWindowSchema };

export const metadata: ToolMetadata = {
  name: "gsc_discover_performance",
  description:
    "How the site does in Google Discover — the feed, not search. Discover has no " +
    "queries and no ranking: it is Google deciding to show a page to somebody who was " +
    "not looking for it, so the numbers move for reasons no keyword report explains. " +
    "Needs the Google login; without it this Tool says so.",
  annotations: {
    title: "Read Google Discover performance",
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: true,
  },
};

/** Completes the sentence "Could not …" for every failure this Tool can return. */
const FAILURE_CONTEXT = "read this site's Discover performance";

const MAX_SHOWN = 25;

export async function handler(args: InferSchema<typeof schema>, google: GoogleReader) {
  const { rows, header } = await fetchRows(google.searchConsole, args, {
    dimensions: ["page"],
    // The one Tool here that is not about `web`. Discover is a separate surface
    // with its own rows, and asking for it is the whole point.
    type: "discover",
    rowLimit: 1_000,
    title: "GOOGLE DISCOVER",
  });

  const lines = [...header];
  lines.push("");

  if (rows.length === 0) {
    lines.push("No Discover data for this property in this window.");
    lines.push("");
    lines.push("Most sites have none, and that is not a fault. Discover surfaces pages Google");
    lines.push("thinks somebody will want to read without having searched for it, which in");
    lines.push("practice means news, timely writing and strongly visual pages. A property with");
    lines.push("no Discover rows has simply never been picked, and there is no setting that");
    lines.push("changes that.");
    return toolText(lines.join("\n"));
  }

  const totals = totalsOf(rows);
  lines.push(`Clicks: ${Math.round(totals.clicks)}`);
  lines.push(`Impressions: ${Math.round(totals.impressions)}`);
  lines.push(`CTR: ${(totals.ctr * 100).toFixed(2)}%`);
  lines.push(`Pages surfaced: ${rows.length}`);

  lines.push("");
  lines.push("page — impressions / clicks / CTR");
  const ranked = [...rows].sort((a, b) => b.clicks - a.clicks);
  for (const row of ranked.slice(0, MAX_SHOWN)) {
    lines.push(
      `  ${keyOf(row)} — ${row.impressions} / ${row.clicks} / ${(row.ctr * 100).toFixed(2)}%`,
    );
  }
  if (ranked.length > MAX_SHOWN) lines.push(`  ... and ${ranked.length - MAX_SHOWN} more`);

  lines.push("");
  lines.push("=== READING THESE ===");
  lines.push("There is no position column, and that is not an omission: Discover is a feed, so");
  lines.push("nothing is ranked. Impressions arrive in bursts when Google picks a page up and");
  lines.push("stop when it moves on, so a fall here is usually the end of a burst rather than");
  lines.push("anything done to the site. Comparing Discover week to week is mostly noise;");
  lines.push("comparing which *pages* get picked up is not.");

  lines.push(...whatTheseRowsAre(rows.length, 1_000));
  return toolText(lines.join("\n"));
}

export default defineGoogleTool(
  FAILURE_CONTEXT,
  { toolName: "gsc_discover_performance", domainOf: (args) => args.siteUrl ?? null },
  handler,
);
