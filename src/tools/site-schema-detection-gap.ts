import { z } from "zod";
import { type ToolMetadata, type InferSchema } from "xmcp";
import { defineGoogleTool } from "../lib/define-tool";
import { toolText } from "../lib/tool-result";
import { fetchRows, gscWindowSchema } from "../lib/google/gsc-tool-shape";
import type { GoogleReader } from "../lib/google/reader";
import { busiest, inspectPages, readPages, sampleNote, SAMPLE_SIZE } from "../lib/google/busiest-pages";
import { getSchemaTypes } from "../lib/analyzers/json-ld-graph";
import type { ParsedPage } from "../lib/analyzers/parsed-page";
import {
  detectedRichResults,
  expectsRichResult,
  producedBy,
  RETIRED_TYPES,
  schemaTypesFor,
} from "../lib/rich-result-types";
import { capped } from "../lib/render-list";
import { basisSection, notCheckedSection, type NotChecked } from "../lib/render-basis";

/** Pages compared when the caller does not say. */
const DEFAULT_PAGES = 10;

/**
 * The most one call inspects. Twenty, as `busiest-pages.ts` settled for the
 * other inspecting Tools: enough to see a pattern, cheap against the day's
 * allowance.
 */
const MAX_PAGES = SAMPLE_SIZE;

/** How many rows any one list prints before it says how many it withheld. */
const MAX_SHOWN = 25;

export const schema = {
  ...gscWindowSchema,
  pages: z
    .number()
    .int()
    .optional()
    .describe(
      `How many of the site's busiest pages (by impressions) to compare. Default ` +
        `${DEFAULT_PAGES}, at most ${MAX_PAGES}. Each one spends a URL Inspection, which Google ` +
        `rations per property per day.`,
    ),
};

export const metadata: ToolMetadata = {
  name: "site_schema_detection_gap",
  description:
    "For the site's busiest pages, the structured data each page declares today against the " +
    "rich results Google's URL Inspection detected on its last crawl: markup declared with no " +
    "rich result detected, rich results Google detected with issues, and rich results Google " +
    "still reports that the live page no longer declares. Spends one URL Inspection per page. " +
    "Needs the Google login; without it this Tool says so.",
  annotations: {
    title: "Compare declared schema with detected rich results",
    readOnlyHint: true,
    destructiveHint: false,
    // Each run can spend inspections, which Google rations.
    idempotentHint: false,
    openWorldHint: true,
  },
};

/** Completes the sentence "Could not …" for every failure this Tool can return. */
const FAILURE_CONTEXT = "compare this site's declared structured data with the rich results Google detected";

/**
 * Every type the page declares, in JSON-LD and in microdata.
 *
 * Microdata counts because Google reads it: a product marked up with `itemtype`
 * produces a rich result as surely as one in JSON-LD, and leaving it out would
 * report that rich result as "no longer declared". JSON-LD types come from every
 * `@type` anywhere in the graph, nested ones included, which is what a rich
 * result needs — a rating inside a product counts.
 */
function declaredTypes(page: ParsedPage): Set<string> {
  const types = getSchemaTypes(page.schemas);
  page.$("[itemscope][itemtype]").each((_, element) => {
    for (const itemtype of (page.$(element).attr("itemtype") ?? "").split(/\s+/)) {
      const type = itemtype.replace(/^https?:\/\/schema\.org\//, "").trim();
      if (type) types.add(type);
    }
  });
  return types;
}

export async function handler(args: InferSchema<typeof schema>, google: GoogleReader) {
  const fetched = await fetchRows(google.searchConsole, args, {
    dimensions: ["page"],
    title: "DECLARED SCHEMA AGAINST DETECTED RICH RESULTS",
  });
  const chosen = busiest(fetched, { by: "impressions", count: args.pages, max: MAX_PAGES, default: DEFAULT_PAGES });
  const pages = chosen.pages;

  const lines = [...fetched.header];
  lines.push("");

  if (pages.length === 0) {
    lines.push("No pages with impressions in this window, so nothing was inspected and no page was read.");
    lines.push(...fetched.footer);
    return toolText(lines.join("\n"));
  }

  // Google first: a refusal should stop the Tool before it reads the site.
  const inspections = await inspectPages(
    google.searchConsole,
    fetched.property,
    pages.map((page) => page.url),
  );
  const read = await readPages(pages.map((page) => page.url));

  const declaredNotDetected: string[] = [];
  const retiredDeclared: string[] = [];
  const withIssues: string[] = [];
  const noLongerDeclared: string[] = [];
  const unmapped = new Map<string, number>();
  // Marked by which side is missing, because the two cost the comparison
  // different things: a page Google did not answer for is in no list, and a
  // page we could not read is still in Google's issues list.
  const notChecked: NotChecked[] = [];
  const neverCrawled: string[] = [];

  lines.push(`Pages compared: ${pages.length} of ${chosen.reported}, the busiest by impressions.`);
  lines.push("");
  lines.push("=== PER PAGE ===");

  pages.forEach((entry, index) => {
    const inspected = inspections[index];
    const site = read[index];
    lines.push(`${entry.url} — ${entry.impressions} impressions`);

    // Without Google's side there is nothing to compare the declared markup
    // with, in either direction, so the page is reported and left out of every
    // list below rather than counted as "declared, not detected".
    if (!inspected.ok) {
      lines.push("  Google detected: not checked — the reason is under NOT CHECKED below.");
      notChecked.push({ subject: `${entry.url} (not inspected)`, reason: inspected.reason });
      return;
    }

    const detected = detectedRichResults(inspected.inspection);
    const lastCrawl = inspected.summary.index.lastCrawlTime;

    const detectedLabel = detected.length > 0 ? detected.map((item) => item.type).join(", ") : "none";
    lines.push(
      `  Google detected: ${detectedLabel}` +
        (lastCrawl ? ` (last crawl ${lastCrawl.slice(0, 10)})` : " (Google reports no crawl of this URL)"),
    );

    // Google's side stands on its own: issues are issues whether or not we
    // could read the page.
    for (const item of detected) {
      const errors = item.issues.filter((issue) => issue.severity === "ERROR").length;
      if (item.issues.length === 0) continue;
      withIssues.push(
        `${entry.url} — ${item.type}: ${item.issues.length} issue(s)` +
          (errors > 0 ? `, ${errors} ERROR (Google: an item with an ERROR cannot appear as a rich result)` : "") +
          `; ${[...new Set(item.issues.map((issue) => issue.message))].slice(0, 3).join("; ")}`,
      );
    }

    if (!site.ok) {
      lines.push("  Declared: not checked — the reason is under NOT CHECKED below.");
      notChecked.push({ subject: `${entry.url} (not read)`, reason: site.reason });
      return;
    }

    const declared = declaredTypes(site.page);
    lines.push(`  Declared: ${declared.size > 0 ? [...declared].sort().join(", ") : "none"}`);

    for (const type of declared) {
      if (RETIRED_TYPES[type]) {
        retiredDeclared.push(`${entry.url} — ${type}: ${RETIRED_TYPES[type]}.`);
        continue;
      }
      if (!expectsRichResult(type)) continue;
      if (detected.some((item) => producedBy(item.type, type))) continue;
      // With no crawl on record there is nothing Google could have detected, and
      // counting the page as "declared, not detected" would blame the markup for
      // a crawl that has not happened.
      if (!lastCrawl) {
        if (!neverCrawled.includes(entry.url)) neverCrawled.push(entry.url);
        continue;
      }
      declaredNotDetected.push(`${entry.url} — ${type}`);
    }

    for (const item of detected) {
      const producers = schemaTypesFor(item.type);
      if (producers === null) {
        unmapped.set(item.type, (unmapped.get(item.type) ?? 0) + 1);
        continue;
      }
      if (producers.some((type) => declared.has(type))) continue;
      noLongerDeclared.push(
        `${entry.url} — Google detected ${item.type}` +
          (lastCrawl ? ` on ${lastCrawl.slice(0, 10)}` : "") +
          `; the live page declares none of ${producers.join(", ")}`,
      );
    }
  });

  const section = (heading: string, rows: string[], empty: string, explain: string[] = []) => {
    lines.push("");
    lines.push(`=== ${heading} (${rows.length}) ===`);
    if (rows.length === 0) {
      lines.push(empty);
      return;
    }
    lines.push(...explain);
    lines.push(...capped(rows, MAX_SHOWN));
  };

  section(
    "DECLARED, NO RICH RESULT DETECTED",
    declaredNotDetected,
    "Every type we map to a rich result was matched by one Google detected, on the pages read.",
    [
      "Markup a rich result can come from, on a page Google has crawled, with no such rich result",
      "detected. Either the markup is missing a required field, it was added after the last",
      "crawl, or Google chose not to use it — the Rich Results Test says which of the first two.",
    ],
  );
  section(
    "RICH RESULTS WITH ISSUES",
    withIssues,
    "Google reported no issue on any rich result it detected on these pages.",
  );
  section(
    "DETECTED BY GOOGLE, NO LONGER DECLARED",
    noLongerDeclared,
    "Every rich result Google detected is backed by markup the live page still declares.",
    [
      "Google's record is from its last crawl. Markup removed since then will drop out when it",
      "recrawls — deliberate if the markup was removed on purpose, a regression if a template",
      "change took it out.",
    ],
  );
  if (retiredDeclared.length > 0) {
    section("DECLARED, RICH RESULT RETIRED", retiredDeclared, "", [
      "No rich result is expected from these, so their absence above is not a finding.",
    ]);
  }

  if (unmapped.size > 0) {
    lines.push("");
    lines.push(
      `Not compared: ${[...unmapped.entries()].map(([type, count]) => `${type} (${count})`).join(", ")} — ` +
        "rich result types Google reported that our mapping does not cover.",
    );
  }
  if (neverCrawled.length > 0) {
    lines.push("");
    lines.push(
      `${neverCrawled.length} page(s) declare markup but Google reports no crawl of them, so there ` +
        `was nothing to detect yet: ${neverCrawled.join(", ")}`,
    );
  }
  // The sample's own list of failed inspections is not printed: every one of
  // them is already in `notChecked`, with what it cost this comparison.
  const sample = sampleNote({ reported: chosen.reported, chosen: pages.length, by: chosen.by, inspected: inspections });
  lines.push(
    ...notCheckedSection(notChecked, {
      noun: "pages",
      note:
        "A page not inspected is in no list above: neither side of the comparison was made for it. " +
        "A page not read had its declared markup left unchecked, so it appears only in the issues " +
        "list, which is Google's side.",
    }),
  );
  lines.push(
    ...basisSection(fetched.basis, sample, {
      read: [],
      limits: [
        "The pairing of schema.org types to rich result types is ours: Google documents no list of " +
          "the rich result names URL Inspection returns, so they are matched by keyword. Sitewide " +
          "markup (Organization, LocalBusiness) and nested ratings are recognised when Google reports " +
          "them but never expected. Google's side is the indexed version, not a live test.",
      ],
    }),
  );
  return toolText(lines.join("\n"));
}

export default defineGoogleTool(
  FAILURE_CONTEXT,
  { toolName: "site_schema_detection_gap", domainOf: (args) => args.siteUrl ?? null },
  handler,
);
