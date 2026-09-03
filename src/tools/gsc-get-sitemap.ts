import { z } from "zod";
import { type ToolMetadata, type InferSchema } from "xmcp";
import { defineGoogleTool } from "../lib/define-tool";
import { refreshable } from "../lib/with-cache";
import { toolText } from "../lib/tool-result";
import { withPropertyFallback } from "../lib/google/property";
import { renderSitemap } from "../lib/google/sitemap-report";
import type { GoogleReader } from "../lib/google/reader";

export const schema = {
  ...refreshable,
  siteUrl: z
    .string()
    .describe("The Search Console property, or just the domain."),
  feedpath: z
    .string()
    .url()
    .describe(
      "The full URL of the sitemap, exactly as gsc_list_sitemaps prints it — " +
        "for example https://example.com/sitemap.xml",
    ),
};

export const metadata: ToolMetadata = {
  name: "gsc_get_sitemap",
  description:
    "Read Search Console's record of one sitemap: when it was last submitted and " +
    "downloaded, how many URLs it declares, how many are indexed, and its warnings " +
    "and errors. Read-only: this never submits a sitemap. Needs the Google login; " +
    "without it this Tool says so.",
  annotations: {
    title: "Read one Search Console sitemap",
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: true,
  },
};

/** Completes the sentence "Could not …" for every failure this Tool can return. */
const FAILURE_CONTEXT = "read this sitemap's record in Search Console";

export async function handler(
  { siteUrl, feedpath }: InferSchema<typeof schema>,
  google: GoogleReader,
) {
  const { result: sitemap, siteUrl: property } = await withPropertyFallback(
    google.searchConsole,
    siteUrl,
    (resolved) => google.searchConsole.getSitemap(resolved, feedpath),
  );

  const lines: string[] = ["=== SITEMAP ==="];
  lines.push(`Property: ${property}`);
  lines.push("");
  lines.push(...renderSitemap(sitemap));

  lines.push("");
  lines.push("=== NOTE ===");
  lines.push("These are Search Console's own figures, not a fresh read of the file. To check");
  lines.push("what the sitemap currently contains, fetch it directly.");

  return toolText(lines.join("\n"));
}

export default defineGoogleTool(
  FAILURE_CONTEXT,
  { toolName: "gsc_get_sitemap", domainOf: (args) => args.siteUrl ?? null },
  handler,
);
