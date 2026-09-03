import { type ToolMetadata, type InferSchema } from "xmcp";
import { defineGoogleTool } from "../lib/define-tool";
import { toolText } from "../lib/tool-result";
import { fetchRows, gscWindowSchema, readAgain } from "../lib/google/gsc-tool-shape";
import { segmentShares, totalsOf } from "../lib/google/gsc-analysis";
import type { GoogleReader } from "../lib/google/reader";

export const schema = { ...gscWindowSchema };

export const metadata: ToolMetadata = {
  name: "gsc_serp_features_gap",
  description:
    "Compare what the site earns from plain results against what it earns from enhanced " +
    "ones — rich results, videos, FAQs — and say which enhancements it is not appearing " +
    "in at all. Answers 'what is on the results page that we are not part of'. Needs " +
    "the Google login; without it this Tool says so.",
  annotations: {
    title: "Compare enhanced against plain results",
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: true,
  },
};

/** Completes the sentence "Could not …" for every failure this Tool can return. */
const FAILURE_CONTEXT = "compare this site's search appearances";

/**
 * The appearances worth naming as absent.
 *
 * Google reports dozens, most of which apply to one kind of site — an
 * ordinary business has no business appearing in `Recipes`. This is the subset
 * an Operator can plausibly do something about, and the Tool says why each is
 * missing rather than listing it as a gap to close.
 */
const WORTH_MENTIONING: Array<{ name: string; needs: string }> = [
  { name: "FAQ rich results", needs: "FAQPage structured data, on a page that genuinely answers questions" },
  { name: "Videos", needs: "a video on the page, with VideoObject markup describing it" },
  { name: "Review snippet", needs: "Review or AggregateRating markup backed by real reviews" },
  { name: "Product snippets", needs: "Product markup with price and availability" },
  { name: "Breadcrumbs", needs: "BreadcrumbList markup matching the site's own navigation" },
  { name: "Sitelinks searchbox", needs: "a working site search and WebSite markup pointing at it" },
];

export async function handler(args: InferSchema<typeof schema>, google: GoogleReader) {
  const current = await fetchRows(google.searchConsole, args, {
    dimensions: ["searchAppearance"],
    rowLimit: 100,
    title: "SEARCH APPEARANCE GAPS",
  });

  // The property's own totals, for comparison. Asked separately rather than
  // summed from the rows above, because appearances overlap — one impression can
  // count under several — so adding them gives a number larger than the site's.
  const totalRows = await readAgain(google.searchConsole, current, { rowLimit: 1 });
  const whole = totalsOf(totalRows);

  const shares = segmentShares(current.rows);
  const present = new Set(shares.map((share) => share.segment.toLowerCase()));

  const lines = [...current.header];
  lines.push("");
  lines.push(
    `Whole property: ${Math.round(whole.clicks)} clicks, ${Math.round(whole.impressions)} ` +
      `impressions, ${(whole.ctr * 100).toFixed(2)}% CTR.`,
  );

  lines.push("");
  if (shares.length === 0) {
    lines.push("=== APPEARING IN ===");
    lines.push("Nothing beyond plain results.");
  } else {
    lines.push("=== APPEARING IN ===");
    for (const share of shares) {
      const better = whole.ctr > 0 ? share.totals.ctr / whole.ctr : 0;
      lines.push(
        `  ${share.segment} — ${Math.round(share.totals.impressions)} impressions, ` +
          `${(share.totals.ctr * 100).toFixed(2)}% CTR ` +
          `(${better >= 1 ? "+" : ""}${((better - 1) * 100).toFixed(0)}% against the property)`,
      );
    }
    lines.push("");
    lines.push("Appearances overlap — one impression can count under several — so these do not");
    lines.push("add up to the property total above, and are not meant to.");
  }

  const missing = WORTH_MENTIONING.filter(
    (feature) => ![...present].some((seen) => seen.includes(feature.name.toLowerCase().split(" ")[0])),
  );

  lines.push("");
  lines.push(`=== NOT APPEARING IN (${missing.length}) ===`);
  if (missing.length === 0) {
    lines.push("The site already appears in every enhancement this Tool tracks.");
  } else {
    // Framed as a precondition rather than a to-do list. Most of these are not
    // gaps: a site with nothing to review should not have review markup, and
    // Google penalises markup that does not match the page.
    lines.push("These are not a checklist. Each one requires the page to genuinely be the kind");
    lines.push("of thing it describes — markup that does not match the page is a manual action");
    lines.push("waiting to happen, not a missing feature.");
    lines.push("");
    for (const feature of missing) {
      lines.push(`  ${feature.name} — would need ${feature.needs}`);
    }
  }

  lines.push(...current.footer);
  return toolText(lines.join("\n"));
}

export default defineGoogleTool(
  FAILURE_CONTEXT,
  { toolName: "gsc_serp_features_gap", domainOf: (args) => args.siteUrl ?? null },
  handler,
);
