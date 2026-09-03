import { type ToolMetadata, type InferSchema } from "xmcp";
import { defineGoogleTool } from "../lib/define-tool";
import { toolText } from "../lib/tool-result";
import { fetchRows, gscWindowSchema } from "../lib/google/gsc-tool-shape";
import { keyOf } from "../lib/google/gsc-analysis";
import type { GoogleReader } from "../lib/google/reader";

export const schema = { ...gscWindowSchema };

export const metadata: ToolMetadata = {
  name: "gsc_detect_featured_snippets",
  description:
    "Find queries where the site may hold the featured snippet, and queries sitting " +
    "just below one where it might be taken. Search Console does not report snippets " +
    "directly, so this is inference from position and CTR and says so throughout. " +
    "Needs the Google login; without it this Tool says so.",
  annotations: {
    title: "Look for featured snippets",
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: true,
  },
};

/** Completes the sentence "Could not …" for every failure this Tool can return. */
const FAILURE_CONTEXT = "look for featured snippets for this site";

/**
 * What the inference rests on, and it is genuinely an inference.
 *
 * Search Console has no featured-snippet dimension. What it has is position and
 * CTR, and a snippet shows up in them as a result sitting at or near rank 1 with
 * a CTR far above what rank 1 normally earns — because the snippet is above the
 * results and takes the click before anything else can.
 *
 * `HOLDING_CTR` is not a published figure. It is well above a typical rank-1 CTR
 * and deliberately conservative: a false "you hold the snippet" is worse than a
 * missed one, because it tells an Operator to stop working on something.
 */
const HOLDING_POSITION = 1.5;
const HOLDING_CTR = 0.35;

/** Just below the snippet, seen a lot, and clicked far less than rank 2 should be. */
const CONTENDER_MIN_POSITION = 1.5;
const CONTENDER_MAX_POSITION = 5;
const CONTENDER_MAX_CTR = 0.08;
const CONTENDER_MIN_IMPRESSIONS = 100;

export async function handler(args: InferSchema<typeof schema>, google: GoogleReader) {
  const { rows, header, footer } = await fetchRows(google.searchConsole, args, {
    dimensions: ["query"],
    title: "FEATURED SNIPPETS, INFERRED",
  });

  const holding = rows
    .filter((row) => row.position <= HOLDING_POSITION && row.ctr >= HOLDING_CTR)
    .sort((a, b) => b.clicks - a.clicks);

  const contenders = rows
    .filter(
      (row) =>
        row.position > CONTENDER_MIN_POSITION &&
        row.position <= CONTENDER_MAX_POSITION &&
        row.ctr <= CONTENDER_MAX_CTR &&
        row.impressions >= CONTENDER_MIN_IMPRESSIONS,
    )
    .sort((a, b) => b.impressions - a.impressions);

  const lines = [...header];
  lines.push("");
  lines.push("Search Console has no featured-snippet dimension, so nothing below is Google");
  lines.push("telling us anything. It is inference from position and CTR: a snippet sits above");
  lines.push("the results and takes the click, so holding one looks like rank 1 with a CTR far");
  lines.push("higher than rank 1 normally earns, and being under one looks like a good rank");
  lines.push("with almost no clicks. Verify any of these by searching for the query yourself.");

  lines.push("");
  lines.push(`=== POSSIBLY HOLDING (${holding.length}) ===`);
  if (holding.length === 0) {
    lines.push("No query in this window shows the pattern.");
  } else {
    lines.push(
      `Position at or under ${HOLDING_POSITION} with CTR at or over ${(HOLDING_CTR * 100).toFixed(0)}%.`,
    );
    for (const row of holding.slice(0, 20)) {
      lines.push(
        `  ${keyOf(row)} — position ${row.position.toFixed(1)}, ${(row.ctr * 100).toFixed(1)}% CTR, ` +
          `${row.clicks} clicks`,
      );
    }
    if (holding.length > 20) lines.push(`  ... and ${holding.length - 20} more`);
  }

  lines.push("");
  lines.push(`=== POSSIBLY UNDER SOMEBODY ELSE'S (${contenders.length}) ===`);
  if (contenders.length === 0) {
    lines.push("No query in this window shows that pattern either.");
  } else {
    lines.push(
      `Position ${CONTENDER_MIN_POSITION} to ${CONTENDER_MAX_POSITION}, at least ` +
        `${CONTENDER_MIN_IMPRESSIONS} impressions, CTR at or under ` +
        `${(CONTENDER_MAX_CTR * 100).toFixed(0)}%.`,
    );
    for (const row of contenders.slice(0, 20)) {
      lines.push(
        `  ${keyOf(row)} — position ${row.position.toFixed(1)}, ${(row.ctr * 100).toFixed(1)}% CTR, ` +
          `${row.impressions} impressions`,
      );
    }
    if (contenders.length > 20) lines.push(`  ... and ${contenders.length - 20} more`);
    lines.push("");
    lines.push("Ranking well and being ignored has other causes than a snippet — an ad block, a");
    lines.push("map, a video carousel, or a query nobody actually wanted an answer to. Look at");
    lines.push("the results page before rewriting the content.");
  }

  lines.push(...footer);
  return toolText(lines.join("\n"));
}

export default defineGoogleTool(
  FAILURE_CONTEXT,
  { toolName: "gsc_detect_featured_snippets", domainOf: (args) => args.siteUrl ?? null },
  handler,
);
