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
    .describe(
      "The Search Console property, or just the domain. A bare domain is matched " +
        "against the properties this account can read.",
    ),
};

export const metadata: ToolMetadata = {
  name: "gsc_list_sitemaps",
  description:
    "List the sitemaps Search Console knows about for a property, with when each was " +
    "last submitted and last downloaded, how many URLs it declares, how many are " +
    "indexed, and its warning and error counts. Read-only: this never submits a " +
    "sitemap. Needs the Google login; without it this Tool says so.",
  annotations: {
    title: "List Search Console sitemaps",
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: true,
  },
};

/** Completes the sentence "Could not …" for every failure this Tool can return. */
const FAILURE_CONTEXT = "list the sitemaps for this site";

export async function handler({ siteUrl }: InferSchema<typeof schema>, google: GoogleReader) {
  const { result: sitemaps, siteUrl: property } = await withPropertyFallback(
    google.searchConsole,
    siteUrl,
    (resolved) => google.searchConsole.listSitemaps(resolved),
  );

  const lines: string[] = ["=== SEARCH CONSOLE SITEMAPS ==="];
  lines.push(`Property: ${property}`);

  if (sitemaps.length === 0) {
    // A property with no sitemap is a real finding, and a mild one: Google
    // discovers pages by crawling links too. Said as a fact with a consequence
    // rather than as an error.
    lines.push("");
    lines.push("Search Console has no sitemaps for this property.");
    lines.push("");
    lines.push("That is not fatal — Google finds pages by following links — but a sitemap is");
    lines.push("how you tell it about pages nothing links to, and it is the only way to compare");
    lines.push("what you published against what got indexed. Submit one in Search Console, or");
    lines.push("declare it in robots.txt with a `Sitemap:` line, which this server can check");
    lines.push("with seo_robots_validator.");
    return toolText(lines.join("\n"));
  }

  lines.push(`Sitemaps: ${sitemaps.length}`);

  for (const sitemap of sitemaps) {
    lines.push("");
    lines.push(...renderSitemap(sitemap));
  }

  return toolText(lines.join("\n"));
}

export default defineGoogleTool(
  FAILURE_CONTEXT,
  { toolName: "gsc_list_sitemaps", domainOf: (args) => args.siteUrl ?? null },
  handler,
);
