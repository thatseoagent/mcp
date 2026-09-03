import { z } from "zod";
import { type ToolMetadata, type InferSchema } from "xmcp";
import { defineGoogleTool } from "../lib/define-tool";
import { refreshable } from "../lib/with-cache";
import { toolText } from "../lib/tool-result";
import { resolveSiteUrl } from "../lib/google/property";
import { inspectUrlOnce } from "../lib/google/inspection-cache";
import { canonicalDisagrees, summarise } from "../lib/google/inspection-report";
import type { GoogleReader } from "../lib/google/reader";
import { capped } from "../lib/render-list";

export const schema = {
  ...refreshable,
  url: z.string().url().describe("The exact URL to inspect, as Google would crawl it"),
  siteUrl: z
    .string()
    .optional()
    .describe(
      "The Search Console property the URL belongs to. Defaults to the URL's own " +
        "domain, matched against the properties this account can read.",
    ),
};

export const metadata: ToolMetadata = {
  name: "gsc_inspect_url",
  description:
    "Ask Google what it knows about one URL: whether it is indexed, which canonical " +
    "Google chose, when it was last crawled, what robots.txt and the indexing " +
    "directives say, and any rich results detected. Note that Google rations these " +
    "inspections per property per day. Needs the Google login; without it this Tool " +
    "says so.",
  annotations: {
    title: "Inspect a URL in Search Console",
    readOnlyHint: true,
    destructiveHint: false,
    // Not idempotent: Google's answer changes as it recrawls, and the call spends
    // one of a rationed daily allowance.
    idempotentHint: false,
    openWorldHint: true,
  },
};

/** Completes the sentence "Could not …" for every failure this Tool can return. */
const FAILURE_CONTEXT = "inspect this URL in Search Console";

/** How many referring URLs to print. */
const MAX_REFERRERS_SHOWN = 10;

/** `null` reads as a blank column; say what it means instead. */
function orNotReported(value: string | null): string {
  return value ?? "not reported by Google";
}

export async function handler(
  { url, siteUrl }: InferSchema<typeof schema>,
  google: GoogleReader,
) {
  // The URL's own domain when the caller did not name a property, which is what
  // an agent handed a URL will do. Resolution is against the properties the
  // account holds, so a wrong guess produces a list of what is available rather
  // than a 404 from Google.
  const property = await resolveSiteUrl(google.searchConsole, siteUrl ?? url);
  const inspection = await inspectUrlOnce(google.searchConsole, property, url);
  const summary = summarise(inspection);

  const lines: string[] = ["=== URL INSPECTION ==="];
  lines.push(`URL: ${url}`);
  lines.push(`Property: ${property}`);

  lines.push("");
  lines.push("=== INDEXING ===");
  lines.push(`Verdict: ${orNotReported(summary.index.verdict)}`);
  lines.push(`Coverage: ${orNotReported(summary.index.coverageState)}`);
  lines.push(`robots.txt: ${orNotReported(summary.index.robotsTxtState)}`);
  lines.push(`Indexing directives: ${orNotReported(summary.index.indexingState)}`);
  lines.push(`Last crawled: ${orNotReported(summary.index.lastCrawlTime)}`);

  lines.push("");
  lines.push("=== CANONICAL ===");
  lines.push(`Declared by the page: ${orNotReported(summary.index.userCanonical)}`);
  lines.push(`Chosen by Google: ${orNotReported(summary.index.googleCanonical)}`);
  if (canonicalDisagrees(summary.index)) {
    // The most useful thing an inspection says, and the most often misread: a
    // page reported as indexed under someone else's canonical is not the page
    // appearing in results.
    lines.push("");
    lines.push("Google chose a different canonical from the one this page declares.");
    lines.push("That means this URL is not the one appearing in results — the chosen canonical");
    lines.push("is. Check that the two pages really are duplicates, and that this page's");
    lines.push("canonical, internal links and sitemap entry all point at the same URL.");
  }

  lines.push("");
  lines.push("=== OTHER CHECKS ===");
  lines.push(`Mobile usability: ${orNotReported(summary.mobileVerdict)}`);
  lines.push(`Rich results: ${orNotReported(summary.richResultsVerdict)}`);
  if (summary.richResultTypes.length > 0) {
    lines.push(`Detected types: ${summary.richResultTypes.join(", ")}`);
  }

  if (summary.index.referringUrls.length > 0) {
    lines.push("");
    lines.push("=== HOW GOOGLE REACHED IT ===");
    // The withheld count was missing here, which is the drift `render-list.ts`
    // exists to stop: ten referring URLs printed with no count, so a reader could
    // not tell whether Google reported ten or three hundred.
    lines.push(
      ...capped(
        summary.index.referringUrls.map((referrer) => `- ${referrer}`),
        MAX_REFERRERS_SHOWN,
        { noun: "referring URL(s) Google recorded" },
      ),
    );
  }

  lines.push("");
  lines.push("=== NOTE ===");
  lines.push("This is Google's own record, not a fresh crawl. A change made in the last few");
  lines.push("days may not be reflected yet, and 'not reported' means Google did not answer");
  lines.push("that part — never that the check passed.");

  return toolText(lines.join("\n"));
}

export default defineGoogleTool(
  FAILURE_CONTEXT,
  { toolName: "gsc_inspect_url", domainOf: (args) => args.siteUrl ?? args.url ?? null },
  handler,
);
