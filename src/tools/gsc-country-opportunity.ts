import { type ToolMetadata, type InferSchema } from "xmcp";
import { defineGoogleTool } from "../lib/define-tool";
import { toolText } from "../lib/tool-result";
import { fetchRows, gscWindowSchema } from "../lib/google/gsc-tool-shape";
import { segmentShares } from "../lib/google/gsc-analysis";
import type { GoogleReader } from "../lib/google/reader";
import { withheld } from "../lib/render-list";

export const schema = { ...gscWindowSchema };

export const metadata: ToolMetadata = {
  name: "gsc_country_opportunity",
  description:
    "Where in the world the site is being seen, and where it is being seen without " +
    "being clicked. A country with impressions and no clicks is usually a language or " +
    "an intent mismatch rather than a ranking problem. Needs the Google login; without " +
    "it this Tool says so.",
  annotations: {
    title: "Compare performance by country",
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: true,
  },
};

/** Completes the sentence "Could not …" for every failure this Tool can return. */
const FAILURE_CONTEXT = "compare this site's performance by country";

const MAX_SHOWN = 20;

/** Below this share of impressions a country is noise rather than a market. */
const MIN_SHARE = 0.01;

export async function handler(args: InferSchema<typeof schema>, google: GoogleReader) {
  const { rows, header, footer } = await fetchRows(google.searchConsole, args, {
    dimensions: ["country"],
    rowLimit: 300,
    title: "PERFORMANCE BY COUNTRY",
  });

  const shares = segmentShares(rows);
  const lines = [...header];
  lines.push("");

  if (shares.length === 0) {
    lines.push("No country data in this window.");
    return toolText(lines.join("\n"));
  }

  lines.push(`Countries with impressions: ${shares.length}`);
  lines.push("");
  lines.push("country — impressions (share) / clicks / CTR / position");
  for (const share of shares.slice(0, MAX_SHOWN)) {
    lines.push(
      `  ${share.segment} — ${Math.round(share.totals.impressions)} ` +
        `(${(share.impressionShare * 100).toFixed(1)}%) / ${Math.round(share.totals.clicks)} / ` +
        `${(share.totals.ctr * 100).toFixed(2)}% / ${share.totals.position.toFixed(1)}`,
    );
  }
  lines.push(...withheld(shares.length, MAX_SHOWN));

  // Seen a lot, clicked rarely, and big enough to matter. Countries below the
  // share floor are excluded because a 100% CTR gap on nine impressions is
  // arithmetic rather than a market.
  const untapped = shares.filter(
    (share) => share.impressionShare >= MIN_SHARE && share.ctrRatio > 0 && share.ctrRatio < 0.5,
  );

  lines.push("");
  if (untapped.length === 0) {
    lines.push("No country of any size is converting far below the site's average.");
  } else {
    lines.push("=== SEEN, NOT CLICKED ===");
    for (const share of untapped) {
      lines.push(
        `${share.segment} — ${Math.round(share.totals.impressions)} impressions, ` +
          `CTR ${(share.ctrRatio * 100).toFixed(0)}% of the site's average`,
      );
    }
    lines.push("");
    lines.push("Google is showing the site to these people and they are not clicking. The usual");
    lines.push("cause is not rank: it is that the result is in the wrong language, prices in the");
    lines.push("wrong currency, or answers a question the searcher was not asking. Check what");
    lines.push("the title and description look like to somebody there before changing anything");
    lines.push("about the page itself. seo_hreflang_validator covers the language half.");
  }

  lines.push(...footer);
  return toolText(lines.join("\n"));
}

export default defineGoogleTool(
  FAILURE_CONTEXT,
  { toolName: "gsc_country_opportunity", domainOf: (args) => args.siteUrl ?? null },
  handler,
);
