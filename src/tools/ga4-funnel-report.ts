import { z } from "zod";
import { type ToolMetadata, type InferSchema } from "xmcp";
import { defineGoogleTool } from "../lib/define-tool";
import { toolText } from "../lib/tool-result";
import { withheld } from "../lib/render-list";
import { InvalidInputError } from "../lib/invalid-input-error";
import { quotaNotes, readReport, reportBasis, type ReportTable } from "../lib/google/ga4-report";
import { basisSection } from "../lib/render-basis";
import { ga4Window, ga4WindowSchema } from "../lib/google/ga4-tool-shape";
import type { GoogleReader } from "../lib/google/reader";

/** GA4's own bounds on a funnel: fewer than two steps is not a funnel, and it takes at most ten. */
const MIN_STEPS = 2;
const MAX_STEPS = 10;

export const schema = {
  ...ga4WindowSchema,
  steps: z
    .array(
      z.object({
        name: z.string().describe("What to call this step in the output, e.g. 'Pricing page'."),
        eventName: z
          .string()
          .describe("The GA4 event a user must fire to reach this step, e.g. 'page_view' or 'sign_up'."),
        pagePathPrefix: z
          .string()
          .optional()
          .describe("Only count the event on pages whose path starts with this, e.g. '/pricing'."),
      }),
    )
    .describe(
      `The funnel, in order: ${MIN_STEPS} to ${MAX_STEPS} steps, each one event and optionally one ` +
        "page path prefix. Use ga4_key_events or ga4_run_report with the eventName dimension to find " +
        "the event names this property actually collects.",
    ),
  isOpenFunnel: z
    .boolean()
    .optional()
    .describe(
      "Open funnel: a user may enter at any step. Closed (the default): only users who did step 1 " +
        "count, which is what 'of the people who landed, how many signed up' means.",
    ),
  breakdownDimension: z
    .string()
    .optional()
    .describe("One GA4 dimension to break every step down by, e.g. 'deviceCategory' or 'sessionDefaultChannelGroup'."),
};

export const metadata: ToolMetadata = {
  name: "ga4_funnel_report",
  description:
    "Of the people who did step 1, how many went on to each next step, and where did " +
    "the rest drop off? Runs a GA4 funnel of 2 to 10 steps — each an event, optionally " +
    "on a page path — and returns users, completion rate and abandonments per step, " +
    "optionally broken down by one dimension. Uses Google's v1alpha funnel API. Needs " +
    "the Google login; without it this Tool says so.",
  annotations: {
    title: "Run an Analytics funnel",
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: true,
  },
};

/** Completes the sentence "Could not …" for every failure this Tool can return. */
const FAILURE_CONTEXT = "run this Analytics funnel";

/** Rows to print before saying how many were withheld. A breakdown multiplies them. */
const MAX_ROWS_SHOWN = 60;

export async function handler(
  { propertyId, startDate, endDate, steps, isOpenFunnel, breakdownDimension }: InferSchema<typeof schema>,
  google: GoogleReader,
) {
  validateSteps(steps);

  const window = ga4Window({ propertyId, startDate, endDate }, { title: "ANALYTICS FUNNEL" });

  const report = await google.analytics.runFunnelReport({
    property: window.property,
    dateRanges: [window.dateRange],
    steps,
    isOpenFunnel: isOpenFunnel ?? false,
    breakdownDimension,
  });

  // The funnel table is a report like any other as far as its headers, rows and
  // metadata go, so it goes through the same reader — which is what makes a
  // sampled funnel say it was sampled, in the same sentence a sampled report uses.
  const table = readReport(report.funnelTable ?? {});

  const lines: string[] = [...window.header];
  lines.push(
    `Funnel: ${isOpenFunnel ? "open — a user may enter at any step" : "closed — only users who did step 1 are counted"}`,
  );
  if (breakdownDimension) lines.push(`Broken down by: ${breakdownDimension}`);
  lines.push("Steps asked for:");
  steps.forEach((step, index) => {
    const where = step.pagePathPrefix ? ` on pages starting ${step.pagePathPrefix}` : "";
    lines.push(`  ${index + 1}. ${step.name} — event ${step.eventName}${where}`);
  });
  lines.push("");
  if (table.rows.length === 0) {
    // An answer about this funnel in this window. Said so nobody concludes the
    // property collects nothing: the commonest cause is an event name that does
    // not match what the site sends.
    lines.push("No users entered this funnel in the window.");
    lines.push("");
    lines.push("That is a fact about these steps and dates. Most often the first step's event name");
    lines.push("or path prefix does not match what this property collects — event names are exact");
    lines.push("and case-sensitive. Check them with ga4_run_report (dimension eventName) before");
    lines.push("concluding nobody took this path.");
  } else {
    lines.push(...renderFunnel(table, steps.length, Boolean(breakdownDimension) || Boolean(isOpenFunnel)));
  }

  const quota = quotaNotes(report.propertyQuota, "Funnel");
  if (quota.length > 0) lines.push("", ...quota);

  lines.push(
    ...basisSection(reportBasis(table), {
      read: [
        "Read through Google's Data API v1alpha funnel method, which Google publishes as an",
        "alpha: its shape and its numbers' definitions may change without a version bump.",
      ],
      limits: [
        "A funnel counts users, not sessions. Google states the property's data retention",
        "setting 'only affects explorations and funnel reports', so a window older than the",
        "property's event data retention (see ga4_setup_audit) comes back short or empty.",
      ],
    }),
  );

  return toolText(lines.join("\n"));
}

/**
 * Refuse a funnel GA4 would refuse, in the caller's vocabulary.
 *
 * Checked before anything is read, because Google's answer to a one-step funnel
 * is a 400 that says nothing about steps.
 */
function validateSteps(steps: Array<{ name: string; eventName: string }>): void {
  if (steps.length < MIN_STEPS) {
    throw new InvalidInputError(
      `\`steps\` has ${steps.length} step${steps.length === 1 ? "" : "s"}; a funnel needs at least ` +
        `${MIN_STEPS}. For a single event's count use ga4_run_report with the eventName dimension.`,
    );
  }
  if (steps.length > MAX_STEPS) {
    throw new InvalidInputError(
      `\`steps\` has ${steps.length} steps; GA4 funnels take at most ${MAX_STEPS}.`,
    );
  }
  steps.forEach((step, index) => {
    if (!step.name.trim() || !step.eventName.trim()) {
      throw new InvalidInputError(
        `Step ${index + 1} in \`steps\` needs both a \`name\` and an \`eventName\`.`,
      );
    }
  });
}

/**
 * The funnel table, as lines.
 *
 * Columns are found by header name rather than position: the table is v1alpha,
 * and a breakdown adds a dimension column that moves everything after it. A
 * column Google did not return is printed as "not reported" rather than as a
 * number nobody measured.
 */
function renderFunnel(table: ReportTable, stepCount: number, noEndToEnd: boolean): string[] {
  const dimension = (name: string) => table.dimensions.indexOf(name);
  const metric = (name: string) => table.metrics.indexOf(name);

  const stepColumn = dimension("funnelStepName");
  const breakdownColumns = table.dimensions
    .map((name, index) => ({ name, index }))
    .filter((column) => column.index !== stepColumn);
  const usersColumn = metric("activeUsers");
  const rateColumn = metric("funnelStepCompletionRate");
  const abandonColumn = metric("funnelStepAbandonments");

  const header = ["step", ...breakdownColumns.map((column) => column.name), "users", "completion rate", "abandonments"];
  const lines = [header.join(" | "), "-".repeat(Math.min(header.join(" | ").length, 80))];

  const valueAt = (values: number[], raw: string[], index: number) =>
    index >= 0 && raw[index] !== undefined && raw[index] !== "" ? values[index] ?? null : null;

  table.rows.slice(0, MAX_ROWS_SHOWN).forEach((row, rowIndex) => {
    const raw = table.rawRows[rowIndex]?.metrics ?? [];
    const stepName = stepColumn >= 0 ? row.dimensions[stepColumn] || "(unnamed step)" : "(unnamed step)";
    const users = valueAt(row.metrics, raw, usersColumn);
    const rate = valueAt(row.metrics, raw, rateColumn);
    const abandonments = valueAt(row.metrics, raw, abandonColumn);
    // Google numbers its step names ("3. Sign up"). On the last step there is
    // no next step to complete to, so its 0% is a definition, not a drop-off.
    const isLast = Number(/^(\d+)\./.exec(stepName)?.[1]) === stepCount;

    lines.push(
      [
        stepName,
        ...breakdownColumns.map((column) => row.dimensions[column.index] ?? ""),
        users === null ? "not reported" : String(users),
        isLast ? "— (last step)" : rate === null ? "not reported" : `${(rate * 100).toFixed(1)}%`,
        abandonments === null ? "not reported" : String(abandonments),
      ].join(" | "),
    );
  });
  lines.push(...withheld(table.rows.length, MAX_ROWS_SHOWN, { noun: "rows of the funnel table", indent: "" }));

  lines.push("");
  lines.push("Completion rate: of the users at this step, the share who reached the next one.");
  lines.push("Abandonments: users at this step who did not reach the next one.");

  // End to end, only for a closed funnel with one row per step to read it from.
  // With a breakdown the rows are per segment, and summing them is a different
  // number; in an open funnel the last step's users need not have done the first.
  if (!noEndToEnd && usersColumn >= 0 && table.rows.length >= 2) {
    const first = table.rows[0]?.metrics[usersColumn] ?? 0;
    const last = table.rows[table.rows.length - 1]?.metrics[usersColumn] ?? 0;
    if (first > 0) {
      lines.push(
        `End to end: ${last} of ${first} users who reached the first step reached the last ` +
          `(${((last / first) * 100).toFixed(1)}%).`,
      );
    }
  }

  return lines;
}

export default defineGoogleTool(
  FAILURE_CONTEXT,
  { toolName: "ga4_funnel_report", domainOf: () => null },
  handler,
);
