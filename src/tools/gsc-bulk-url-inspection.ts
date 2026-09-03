import { z } from "zod";
import { type ToolMetadata, type InferSchema } from "xmcp";
import { defineGoogleTool } from "../lib/define-tool";
import { refreshable } from "../lib/with-cache";
import { toolText } from "../lib/tool-result";
import { resolveSiteUrl } from "../lib/google/property";
import { inspectUrlOnce } from "../lib/google/inspection-cache";
import { canonicalDisagrees, oneLine, summarise } from "../lib/google/inspection-report";
import { UpstreamApiError } from "../lib/upstream-api-error";
import type { GoogleReader } from "../lib/google/reader";

/**
 * How many URLs one call will inspect.
 *
 * A ceiling rather than a preference, and the reason is the rationing: Google
 * allows a fixed number of inspections per property per day. A caller asking for
 * five hundred URLs in one go can spend a quarter of a day's allowance on a
 * single Tool call, and the allowance does not come back.
 *
 * Clamped rather than refused, in both directions — a smaller batch is an
 * answer, an error is not.
 */
export const MAX_URLS = 50;

/** How many inspections run at once. Google rate-limits this API tightly. */
const CONCURRENCY = 5;

export const schema = {
  ...refreshable,
  urls: z
    .array(z.string().url())
    .describe(`The URLs to inspect. Up to ${MAX_URLS}; more than that is clamped, not refused.`),
  siteUrl: z
    .string()
    .optional()
    .describe(
      "The Search Console property these URLs belong to. Defaults to the first URL's " +
        "own domain, matched against the properties this account can read.",
    ),
};

export const metadata: ToolMetadata = {
  name: "gsc_bulk_url_inspection",
  description:
    "Inspect many URLs in Search Console at once and report which are indexed, which " +
    "are not, and where Google chose a different canonical. Google rations these " +
    "inspections per property per day, so a URL already inspected in this session is " +
    "not inspected again. Needs the Google login; without it this Tool says so.",
  annotations: {
    title: "Inspect many URLs in Search Console",
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: false,
    openWorldHint: true,
  },
};

/** Completes the sentence "Could not …" for every failure this Tool can return. */
const FAILURE_CONTEXT = "inspect these URLs in Search Console";

type Outcome =
  | { url: string; ok: true; summary: ReturnType<typeof summarise> }
  | { url: string; ok: false; reason: string };

/**
 * Inspect a batch, letting one URL's failure stand alone.
 *
 * `allSettled` rather than `all`, and it is the difference between a report and
 * nothing: one URL that 404s, or one that trips the daily quota, would otherwise
 * discard the other forty-nine inspections — which have already been *spent*
 * against the allowance. A failure per row is the honest shape.
 */
async function inspectAll(
  google: GoogleReader,
  property: string,
  urls: readonly string[],
): Promise<Outcome[]> {
  const outcomes: Outcome[] = [];

  for (let start = 0; start < urls.length; start += CONCURRENCY) {
    const batch = urls.slice(start, start + CONCURRENCY);
    const settled = await Promise.allSettled(
      batch.map((url) => inspectUrlOnce(google.searchConsole, property, url)),
    );

    settled.forEach((outcome, index) => {
      const url = batch[index];
      if (outcome.status === "fulfilled") {
        outcomes.push({ url, ok: true, summary: summarise(outcome.value) });
      } else {
        const error: unknown = outcome.reason;
        outcomes.push({
          url,
          ok: false,
          // Our own sentence where we have one; anything else is summarised
          // rather than forwarded, per `tool-failure.ts`.
          reason:
            error instanceof UpstreamApiError
              ? error.message
              : "the inspection did not complete (its cause has been logged)",
        });
      }
    });

    // A quota refusal will not fix itself within one call, and continuing would
    // spend nothing but time while producing forty more identical rows.
    if (outcomes.some((outcome) => !outcome.ok && outcome.reason.includes("429"))) break;
  }

  return outcomes;
}

export async function handler(
  { urls, siteUrl }: InferSchema<typeof schema>,
  google: GoogleReader,
) {
  const requested = urls ?? [];
  // De-duplicated before clamping, so a list that repeats a URL does not lose a
  // different one to the ceiling.
  const unique = [...new Set(requested)];
  const chosen = unique.slice(0, MAX_URLS);

  const lines: string[] = ["=== BULK URL INSPECTION ==="];

  if (chosen.length === 0) {
    lines.push("");
    lines.push("No URLs were given, so nothing was inspected.");
    return toolText(lines.join("\n"));
  }

  const property = await resolveSiteUrl(google.searchConsole, siteUrl ?? chosen[0]);
  const outcomes = await inspectAll(google, property, chosen);

  lines.push(`Property: ${property}`);
  lines.push(`Inspected: ${outcomes.length} of ${unique.length} URL(s) given`);
  if (unique.length !== requested.length) {
    lines.push(`(${requested.length - unique.length} duplicate(s) in the list were collapsed.)`);
  }
  if (unique.length > MAX_URLS) {
    lines.push(
      `Only the first ${MAX_URLS} were inspected. Google rations inspections per property ` +
        `per day, so the rest were left rather than spent — ask again for them if you want them.`,
    );
  }

  const answered = outcomes.filter((outcome) => outcome.ok);
  const failed = outcomes.filter((outcome) => !outcome.ok);

  const indexed = answered.filter((outcome) => outcome.ok && outcome.summary.index.verdict === "PASS");
  const notIndexed = answered.filter(
    (outcome) => outcome.ok && outcome.summary.index.verdict !== "PASS",
  );
  const canonicalIssues = answered.filter(
    (outcome) => outcome.ok && canonicalDisagrees(outcome.summary.index),
  );

  lines.push("");
  lines.push("=== SUMMARY ===");
  lines.push(`Indexed: ${indexed.length}`);
  lines.push(`Not indexed, or not reported as indexed: ${notIndexed.length}`);
  lines.push(`Canonical differs from the one declared: ${canonicalIssues.length}`);
  if (failed.length > 0) {
    // Kept apart from "not indexed" on purpose. A URL we could not ask about is
    // not a URL Google declined to index, and merging the two would report a
    // network problem as an indexing problem.
    lines.push(`Could not be inspected on this run: ${failed.length}`);
  }

  if (notIndexed.length > 0) {
    lines.push("");
    lines.push(`=== NOT INDEXED (${notIndexed.length}) ===`);
    for (const outcome of notIndexed) {
      if (outcome.ok) lines.push(oneLine(outcome.url, outcome.summary));
    }
  }

  if (canonicalIssues.length > 0) {
    lines.push("");
    lines.push(`=== CANONICAL DISAGREEMENTS (${canonicalIssues.length}) ===`);
    lines.push("These URLs are not the ones appearing in results; the chosen canonical is.");
    for (const outcome of canonicalIssues) {
      if (!outcome.ok) continue;
      lines.push(`  ${outcome.url}`);
      lines.push(`    declared: ${outcome.summary.index.userCanonical}`);
      lines.push(`    Google chose: ${outcome.summary.index.googleCanonical}`);
    }
  }

  if (indexed.length > 0) {
    lines.push("");
    lines.push(`=== INDEXED (${indexed.length}) ===`);
    for (const outcome of indexed) {
      if (outcome.ok) lines.push(oneLine(outcome.url, outcome.summary));
    }
  }

  if (failed.length > 0) {
    lines.push("");
    lines.push(`=== NOT EVALUATED (${failed.length}) ===`);
    lines.push("These are questions that did not get asked, not answers about the URLs.");
    for (const outcome of failed) {
      if (!outcome.ok) lines.push(`  ${outcome.url} — ${outcome.reason}`);
    }
  }

  return toolText(lines.join("\n"));
}

export default defineGoogleTool(
  FAILURE_CONTEXT,
  { toolName: "gsc_bulk_url_inspection", domainOf: (args) => args.siteUrl ?? null },
  handler,
);
