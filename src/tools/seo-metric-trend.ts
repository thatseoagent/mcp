import { z } from "zod";
import { type ToolMetadata, type InferSchema } from "xmcp";
import { defineCachedTool } from "../lib/define-tool";
import { refreshable } from "../lib/with-cache";
import { toolText } from "../lib/tool-result";
import { persistenceStatus } from "../lib/db/runtime";
import { findSite, NoDatabaseError } from "../lib/sites";
import { InvalidInputError } from "../lib/invalid-input-error";
import {
  METRICS,
  metricsWithHistory,
  movementOf,
  readMonths,
  type Movement,
} from "../lib/metric-history";
import { withheld } from "../lib/render-list";

export const schema = {
  ...refreshable,
  domain: z.string().describe("The Site to read history for, e.g. `example.com`."),
  metric: z
    .string()
    .optional()
    .describe(
      `One metric key, e.g. 'gsc.clicks'. Omit for every metric this Site has history ` +
        `for. Known keys: ${METRICS.map((m) => m.key).join(", ")}.`,
    ),
  months: z
    .boolean()
    .optional()
    .describe("Show the monthly rollups instead of individual runs. Better for a long view."),
};

export const metadata: ToolMetadata = {
  name: "seo_metric_trend",
  description:
    "Read a Site's history back: how its search clicks, impressions, position, " +
    "sessions, AI traffic and scores have moved across audit runs, or month by month. " +
    "Only shows what run_site_audit has recorded, so a Site with one run has no trend " +
    "yet. Needs the database; without one this Tool says so.",
  annotations: {
    title: "Read a Site's metric history",
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
};

/** Completes the sentence "Could not …" for every failure this Tool can return. */
const FAILURE_CONTEXT = "read this Site's metric history";

/** How many individual readings to print per metric. */
const MAX_POINTS = 12;

function renderMovement(movement: Movement): string[] {
  const lines: string[] = [];
  const { metric, points, latest, previous, change, improved } = movement;

  lines.push("");
  lines.push(`=== ${metric.label} (${metric.key}) ===`);

  const answered = points.filter((point) => point.value !== null);
  if (answered.length === 0) {
    // Rows exist and none of them answered. Distinct from having no history at
    // all, and the distinction is the reason the reader should retry rather than
    // conclude anything.
    lines.push("Recorded, but no run has managed to measure it. Nothing to trend yet.");
    return lines;
  }

  lines.push(`Latest: ${latest}`);
  if (change === null) {
    lines.push("No earlier reading to compare against — this is the first one that answered.");
  } else {
    const sign = change >= 0 ? "+" : "";
    const direction = change === 0 ? "unchanged" : improved ? "better" : "worse";
    lines.push(`Previous: ${previous} — ${sign}${change.toFixed(2)}, ${direction}`);
    if (metric.direction === "down-is-better") {
      // The one place a bare arrow lies. A rising average position is a site
      // moving *down* the results page.
      lines.push("(Lower is better for this one, so a fall is an improvement.)");
    }
  }

  lines.push("");
  for (const point of points.slice(0, MAX_POINTS)) {
    const value = point.value === null ? "not measured on this run" : String(point.value);
    const grade = point.grade ? ` (${point.grade})` : "";
    lines.push(`  ${point.at.toISOString().slice(0, 10)} — ${value}${grade}`);
  }
  if (points.length > MAX_POINTS) {
    lines.push(...withheld(points.length, MAX_POINTS, { noun: "earlier readings" }));
  }

  return lines;
}

export async function handler({ domain, metric, months }: InferSchema<typeof schema>) {
  const status = persistenceStatus();
  if (!status.available) {
    throw new NoDatabaseError(status.reason ?? "persistence is unavailable");
  }

  const site = findSite(domain);
  if (!site) {
    // Not registered is a different thing from having no history, and the fix
    // differs: one is a Tool call away, the other is time.
    throw new InvalidInputError(
      `${domain} is not a registered Site, so there is no history for it. Run ` +
        `run_site_audit on it — that registers it and records the first set of numbers.`,
    );
  }

  const lines: string[] = ["=== METRIC HISTORY ==="];
  lines.push(`Site: ${site.domain}`);

  if (months) {
    const rollups = readMonths(site.id);
    lines.push("");
    if (rollups.length === 0) {
      lines.push("No months recorded yet. run_site_audit builds these as it runs.");
      return toolText(lines.join("\n"));
    }

    lines.push(`=== BY MONTH (${rollups.length}) ===`);
    for (const month of rollups) {
      lines.push("");
      // How many runs the month is built from, said every time: a month from one
      // audit and a month from four are not comparable, and nothing else in the
      // output would reveal which this is.
      lines.push(`${month.month} — built from ${month.readings} run(s)`);
      for (const [key, summary] of Object.entries(month.metrics)) {
        const definition = METRICS.find((candidate) => candidate.key === key);
        lines.push(
          `  ${definition?.label ?? key}: last ${summary.last}, low ${summary.min}, high ${summary.max}`,
        );
      }
    }
    return toolText(lines.join("\n"));
  }

  const wanted = metric ? [metric] : metricsWithHistory(site.id);

  if (wanted.length === 0) {
    lines.push("");
    lines.push("Nothing has been recorded for this Site yet.");
    lines.push("");
    lines.push("run_site_audit records a set of numbers on every run. One run gives a baseline");
    lines.push("and no trend; the comparison starts with the second.");
    return toolText(lines.join("\n"));
  }

  const movements = wanted
    .map((key) => movementOf(site.id, key))
    .filter((movement): movement is Movement => movement !== null);

  if (movements.length === 0) {
    throw new InvalidInputError(
      `"${metric}" is not a metric this server records. Known keys: ` +
        `${METRICS.map((m) => m.key).join(", ")}.`,
    );
  }

  for (const movement of movements) lines.push(...renderMovement(movement));

  return toolText(lines.join("\n"));
}

export default defineCachedTool(
  FAILURE_CONTEXT,
  { toolName: "seo_metric_trend", domainOf: (args) => args.domain ?? null, ttlMs: 60_000 },
  handler,
);
