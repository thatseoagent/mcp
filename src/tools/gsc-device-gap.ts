import { type ToolMetadata, type InferSchema } from "xmcp";
import { defineGoogleTool } from "../lib/define-tool";
import { toolText } from "../lib/tool-result";
import { fetchRows, gscWindowSchema } from "../lib/google/gsc-tool-shape";
import { segmentShares } from "../lib/google/gsc-analysis";
import type { GoogleReader } from "../lib/google/reader";

export const schema = { ...gscWindowSchema };

export const metadata: ToolMetadata = {
  name: "gsc_device_gap",
  description:
    "Compare how the site performs on mobile, desktop and tablet: where the " +
    "impressions are, and whether each device converts them at the same rate. A " +
    "device carrying most of the impressions and clicking at half the rate is the " +
    "finding to look for. Needs the Google login; without it this Tool says so.",
  annotations: {
    title: "Compare performance by device",
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: true,
  },
};

/** Completes the sentence "Could not …" for every failure this Tool can return. */
const FAILURE_CONTEXT = "compare this site's performance by device";

/**
 * How far a segment's CTR may sit from the site's before it is worth a sentence.
 *
 * Ours, and loose on purpose. Device CTR differs for reasons that are not
 * defects — mobile results carry more ads and more SERP features above the
 * organic ones — so a small gap is the normal state of the web rather than
 * something to fix.
 */
const NOTABLE_RATIO = 0.7;

export async function handler(args: InferSchema<typeof schema>, google: GoogleReader) {
  const { rows, header, footer } = await fetchRows(google.searchConsole, args, {
    dimensions: ["device"],
    rowLimit: 10,
    title: "PERFORMANCE BY DEVICE",
  });

  const shares = segmentShares(rows);
  const lines = [...header];
  lines.push("");

  if (shares.length === 0) {
    lines.push("No device data in this window.");
    return toolText(lines.join("\n"));
  }

  lines.push("device — impressions (share) / clicks / CTR / position");
  for (const share of shares) {
    lines.push(
      `  ${share.segment} — ${Math.round(share.totals.impressions)} ` +
        `(${(share.impressionShare * 100).toFixed(1)}%) / ${Math.round(share.totals.clicks)} / ` +
        `${(share.totals.ctr * 100).toFixed(2)}% / ${share.totals.position.toFixed(1)}`,
    );
  }

  const weak = shares.filter(
    (share) => share.ctrRatio > 0 && share.ctrRatio < NOTABLE_RATIO && share.impressionShare > 0.1,
  );

  lines.push("");
  if (weak.length === 0) {
    lines.push("No device converts markedly worse than the site as a whole.");
  } else {
    lines.push("=== WORTH LOOKING AT ===");
    for (const share of weak) {
      lines.push(
        `${share.segment}: ${(share.impressionShare * 100).toFixed(0)}% of impressions, and its ` +
          `CTR is ${(share.ctrRatio * 100).toFixed(0)}% of the site's.`,
      );
    }
    lines.push("");
    lines.push("Some of that gap is the web rather than the site: mobile results carry more ads");
    lines.push("and more features above the organic ones, so a mobile CTR below desktop is the");
    lines.push("normal state. What is worth checking is the position column — if the ranks are");
    lines.push("similar and the CTR is not, the difference is in what the result looks like");
    lines.push("rather than where it sits.");
  }

  lines.push(...footer);
  return toolText(lines.join("\n"));
}

export default defineGoogleTool(
  FAILURE_CONTEXT,
  { toolName: "gsc_device_gap", domainOf: (args) => args.siteUrl ?? null },
  handler,
);
