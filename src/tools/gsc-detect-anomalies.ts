import { type ToolMetadata, type InferSchema } from "xmcp";
import { defineGoogleTool } from "../lib/define-tool";
import { toolText } from "../lib/tool-result";
import { fetchRows, gscWindowSchema, whatTheseRowsAre } from "../lib/google/gsc-tool-shape";
import { anomalies, MIN_DAYS_FOR_ANOMALY, totalsOf } from "../lib/google/gsc-analysis";
import type { GoogleReader } from "../lib/google/reader";

export const schema = { ...gscWindowSchema };

export const metadata: ToolMetadata = {
  name: "gsc_detect_anomalies",
  description:
    "Find days in the window whose click count does not look like the rest of it — " +
    "spikes and drops worth explaining. Uses a plain standard-deviation test and says " +
    "so, because anything cleverer needs assumptions about seasonality that one window " +
    "cannot support. Needs the Google login; without it this Tool says so.",
  annotations: {
    title: "Find unusual days in Search Console",
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: true,
  },
};

/** Completes the sentence "Could not …" for every failure this Tool can return. */
const FAILURE_CONTEXT = "look for unusual days in this site's search data";

export async function handler(args: InferSchema<typeof schema>, google: GoogleReader) {
  const { rows, header } = await fetchRows(google.searchConsole, args, {
    dimensions: ["date"],
    rowLimit: 400,
    title: "UNUSUAL DAYS",
  });

  const lines = [...header];
  lines.push("");

  if (rows.length < MIN_DAYS_FOR_ANOMALY) {
    // Not "no anomalies". A mean over four days is not a baseline, and reporting
    // a clean result from one would be a confident answer built on nothing.
    lines.push(
      `Not enough days to say. This window has ${rows.length}; the test needs at least ` +
        `${MIN_DAYS_FOR_ANOMALY} to have a baseline worth comparing against.`,
    );
    lines.push("Widen the window with `days` and ask again.");
    return toolText(lines.join("\n"));
  }

  const totals = totalsOf(rows);
  const mean = totals.clicks / rows.length;
  const found = anomalies(rows);

  lines.push(`Average day: ${mean.toFixed(1)} clicks across ${rows.length} days.`);
  lines.push("");

  if (found.length === 0) {
    lines.push("No day in this window is more than two standard deviations from that average.");
    lines.push("");
    lines.push("A flat window can mean a stable site or a window too short to contain the event");
    lines.push("you are looking for. It is not evidence that nothing happened.");
    lines.push(...whatTheseRowsAre(rows.length, 400));
    return toolText(lines.join("\n"));
  }

  lines.push(`Days that stand out: ${found.length}`);
  lines.push("");
  for (const day of found) {
    const direction = day.deviations > 0 ? "above" : "below";
    lines.push(
      `  ${day.date} — ${day.clicks} clicks, ${Math.abs(day.deviations).toFixed(1)} deviations ${direction} average`,
    );
  }

  lines.push("");
  lines.push("=== BEFORE READING ANYTHING INTO THESE ===");
  lines.push("A standard-deviation test knows nothing about weekends, holidays, or a campaign");
  lines.push("you ran. The most common 'anomaly' in any window is a Sunday. Check the dates");
  lines.push("against what you know happened before treating one as a Google event.");

  lines.push(...whatTheseRowsAre(rows.length, 400));
  return toolText(lines.join("\n"));
}

export default defineGoogleTool(
  FAILURE_CONTEXT,
  { toolName: "gsc_detect_anomalies", domainOf: (args) => args.siteUrl ?? null },
  handler,
);
