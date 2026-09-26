import { z } from "zod";
import { type ToolMetadata, type InferSchema } from "xmcp";
import { defineGoogleTool } from "../lib/define-tool";
import { toolText } from "../lib/tool-result";
import { withheld } from "../lib/render-list";
import { InvalidInputError } from "../lib/invalid-input-error";
import { ga4Window, ga4WindowSchema, resolveGa4Date } from "../lib/google/ga4-tool-shape";
import type { Ga4Annotation, Ga4Date, GoogleReader } from "../lib/google/reader";

export const schema = {
  ...ga4WindowSchema,
  days: z
    .number()
    .int()
    .positive()
    .optional()
    .describe(
      "Window length in days, ending yesterday, when no startDate is given. Default 28. " +
        "Pass a large number (e.g. 1000) to see every annotation on the property.",
    ),
};

export const metadata: ToolMetadata = {
  name: "ga4_annotations",
  description:
    "What does the Analytics property itself say happened, and when? Lists the " +
    "property's annotations — the notes people (and Google) pin to dates: a redesign, " +
    "a migration, a tracking change — newest first, within a window. Use it to line a " +
    "change up with a traffic shift found by gsc_detect_anomalies or ga4_run_report " +
    "before guessing at a cause. Needs the Google login; without it this Tool says so.",
  annotations: {
    title: "List Analytics annotations",
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: true,
  },
};

/** Completes the sentence "Could not …" for every failure this Tool can return. */
const FAILURE_CONTEXT = "list this Analytics property's annotations";

/** How many annotations to print before saying how many were withheld. */
const MAX_SHOWN = 100;

/** An annotation with its dates read into `YYYY-MM-DD`, or `null` where Google gave none. */
interface Dated {
  annotation: Ga4Annotation;
  start: string | null;
  end: string | null;
}

export async function handler(
  { propertyId, startDate, endDate, days }: InferSchema<typeof schema>,
  google: GoogleReader,
) {
  const window = ga4Window({ propertyId, startDate, endDate, days }, {
    title: "ANALYTICS ANNOTATIONS",
  });

  // The property's time zone, because the window is GA4's relative form —
  // `28daysAgo`, `yesterday` — and the filtering happens here rather than at
  // Google. Resolved in UTC it would be off by a day for half the planet, which
  // for a one-day annotation is the difference between listed and not.
  // `getProperty` is also the read that says whether the property is readable
  // at all, so a refusal arrives from it and propagates, as ADR-0003 wants.
  const details = await google.analyticsAdmin.getProperty(window.property);
  const from = resolveGa4Date(window.startDate, details.timeZone);
  const to = resolveGa4Date(window.endDate, details.timeZone);
  if (!from) throw windowError("startDate", window.startDate);
  if (!to) throw windowError("endDate", window.endDate);

  const all = await google.analyticsAdmin.listAnnotations(window.property);
  const dated = all.map(readDates);

  const undated = dated.filter((entry) => entry.start === null);
  const inWindow = dated
    .filter((entry): entry is Dated & { start: string; end: string } => entry.start !== null && entry.end !== null)
    // Overlap rather than containment: a three-day rollout that began before the
    // window is still something that was happening inside it.
    .filter((entry) => entry.start <= to.date && entry.end >= from.date)
    // Newest first, by when the change ended and then when it began, because the
    // reader is walking back from a shift they already found.
    .sort((a, b) => b.end.localeCompare(a.end) || b.start.localeCompare(a.start));
  const outside = dated.length - undated.length - inWindow.length;

  const lines: string[] = [...window.header];
  lines.push(`Dates resolved to ${from.date} to ${to.date}, in the time zone ${from.timeZone}.`);
  if (from.timeZone === "UTC" && details.timeZone !== "UTC") {
    lines.push(
      "Google did not report a time zone this server could use for the property, so relative " +
        "dates were read in UTC and an annotation on the window's first or last day may be off by one.",
    );
  }
  lines.push("");

  if (all.length === 0) {
    // A real answer. Said as a fact about the property, because "none" is the
    // usual state and does not mean nothing changed on the site.
    lines.push("This property has no annotations at all, in this window or any other.");
    lines.push("");
    lines.push("That is common: annotations are notes somebody has to write, and most properties");
    lines.push("have none. It says nothing about whether the site changed — only that nobody");
    lines.push("recorded a change in Analytics. Ask the site's owner, or check a deploy log.");
    return toolText(lines.join("\n"));
  }

  if (inWindow.length === 0) {
    lines.push("No annotations fall in this window.");
  } else {
    lines.push(`Annotations in this window: ${inWindow.length} (newest first)`);
    lines.push("");
    for (const entry of inWindow.slice(0, MAX_SHOWN)) lines.push(...renderAnnotation(entry));
    lines.push(...withheld(inWindow.length, MAX_SHOWN, { noun: "annotations in this window", indent: "" }));
  }

  // The count of what the window left out, so a short list is not read as the
  // property's whole history.
  if (outside > 0) {
    lines.push("");
    lines.push(
      `${outside} more annotation${outside === 1 ? "" : "s"} on this property fall${outside === 1 ? "s" : ""} ` +
        "outside this window. Widen it with `startDate` or `days` to see them.",
    );
  }
  if (undated.length > 0) {
    lines.push("");
    lines.push(
      `${undated.length} annotation${undated.length === 1 ? " has" : "s have"} no date Google reported, ` +
        "so could not be placed in any window and are not listed.",
    );
  }

  lines.push("");
  lines.push("How to use these: an annotation dated near a shift in gsc_detect_anomalies or in a");
  lines.push("ga4_run_report trend is a candidate explanation worth checking first. It is a note");
  lines.push("somebody wrote, not evidence that the change caused the shift — the two lining up");
  lines.push("in time is where the inquiry starts, not where it ends. Search Console reports days");
  lines.push("in Pacific Time and GA4 in the property's time zone, so allow a day either side.");

  return toolText(lines.join("\n"));
}

function renderAnnotation(entry: Dated & { start: string; end: string }): string[] {
  const { annotation, start, end } = entry;
  const when = start === end ? start : `${start} to ${end}`;
  const who = annotation.systemGenerated ? "written by Google" : "added on the property";
  const lines = [`${when} — ${annotation.title?.trim() || "(untitled)"} (${who})`];
  if (annotation.description?.trim()) lines.push(`    ${annotation.description.trim()}`);
  return lines;
}

/**
 * The dates Google set, as `YYYY-MM-DD`.
 *
 * Google sets exactly one of `annotationDate` and `annotationDateRange`. A
 * single day is a range of one, so the rest of the file has one shape to reason
 * about. A range with one end missing is read as that one day rather than
 * dropped.
 */
function readDates(annotation: Ga4Annotation): Dated {
  const single = formatDate(annotation.annotationDate);
  if (single) return { annotation, start: single, end: single };

  const start = formatDate(annotation.annotationDateRange?.startDate);
  const end = formatDate(annotation.annotationDateRange?.endDate);
  return { annotation, start: start ?? end, end: end ?? start };
}

function formatDate(date: Ga4Date | undefined): string | null {
  if (!date?.year || !date.month || !date.day) return null;
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${date.year}-${pad(date.month)}-${pad(date.day)}`;
}

function windowError(argument: string, value: string): InvalidInputError {
  return new InvalidInputError(
    `\`${argument}\` is "${value}", which is not a date this Tool can read. Use YYYY-MM-DD, ` +
      "`today`, `yesterday` or GA4's relative form, e.g. `28daysAgo`.",
  );
}

export default defineGoogleTool(
  FAILURE_CONTEXT,
  { toolName: "ga4_annotations", domainOf: () => null },
  handler,
);
