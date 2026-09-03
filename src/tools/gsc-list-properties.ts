import { z } from "zod";
import { type ToolMetadata, type InferSchema } from "xmcp";
import { defineGoogleTool } from "../lib/define-tool";
import { refreshable } from "../lib/with-cache";
import { toolText } from "../lib/tool-result";
import type { GoogleReader, GscProperty } from "../lib/google/reader";

export const schema = {
  ...refreshable,
};

export const metadata: ToolMetadata = {
  name: "gsc_list_properties",
  description:
    "List the Search Console properties this Google account can read, with the " +
    "permission level on each and whether it is a Domain Property or a URL-Prefix " +
    "Property. Start here: every other gsc_* Tool needs one of these identifiers. " +
    "Needs the Google login; without it this Tool says so.",
  annotations: {
    title: "List Search Console properties",
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: true,
  },
};

/** Completes the sentence "Could not …" for every failure this Tool can return. */
const FAILURE_CONTEXT = "list your Search Console properties";

/**
 * What a permission level means for the Tools.
 *
 * Google's own words are `siteOwner`, `siteFullUser`, `siteRestrictedUser` and
 * `siteUnverifiedUser`, and only the last one is a real gate — but "restricted"
 * genuinely does withhold some reports, so an Operator seeing empty results
 * needs to know which level they hold rather than concluding their site has no
 * data.
 */
const PERMISSION_NOTES: Record<string, string> = {
  siteOwner: "full access",
  siteFullUser: "full access",
  siteRestrictedUser: "restricted — some reports return less than an owner sees",
  siteUnverifiedUser: "not verified — no data can be read for this property",
};

/**
 * Which kind of property this is, said explicitly.
 *
 * `CONTEXT.md` is firm that a Domain Property and a URL-Prefix Property are not
 * the same thing and the words are not interchangeable. The practical difference
 * is what an Operator is choosing between: a Domain Property covers every
 * subdomain and both schemes, a URL-Prefix Property covers exactly its prefix.
 * A reader who picks the wrong one gets a report about a smaller site than they
 * meant.
 */
function describeKind(siteUrl: string): string {
  return siteUrl.startsWith("sc-domain:")
    ? "Domain Property — covers every subdomain and both http and https"
    : "URL-Prefix Property — covers only URLs starting with this prefix";
}

/**
 * The handler, exported so it can be tested against `fakeGoogleReader()`.
 *
 * This is the shape #9 exists to establish: the reader arrives as an argument,
 * so a test needs an object literal rather than a Google account, a project and
 * a verified property.
 */
export async function handler(_args: InferSchema<typeof schema>, google: GoogleReader) {
  const properties = await google.searchConsole.listProperties();
  const lines: string[] = ["=== SEARCH CONSOLE PROPERTIES ==="];

  if (properties.length === 0) {
    // Not an error, and not silence either. An account with no properties is a
    // definite answer, and the next step is in Search Console rather than here.
    lines.push("");
    lines.push("This Google account can read no Search Console properties.");
    lines.push("");
    lines.push("Add and verify the site at https://search.google.com/search-console, then");
    lines.push("re-run this Tool. If you expected properties here, check that the login used");
    lines.push("the account that owns them — re-run the login command to switch accounts.");
    return toolText(lines.join("\n"));
  }

  lines.push(`Readable properties: ${properties.length}`);

  const usable = properties.filter((p) => p.permissionLevel !== "siteUnverifiedUser");
  if (usable.length !== properties.length) {
    // Said up front rather than left to be inferred from the list: an Operator
    // whose only property is unverified would otherwise read the count above as
    // good news.
    lines.push(
      `Of those, ${usable.length} can actually return data; the rest are unverified.`,
    );
  }

  for (const property of properties) {
    lines.push("");
    lines.push(`${property.siteUrl}`);
    lines.push(`  Kind: ${describeKind(property.siteUrl)}`);
    lines.push(
      `  Permission: ${property.permissionLevel} — ${
        PERMISSION_NOTES[property.permissionLevel] ?? "unrecognised level; treat with caution"
      }`,
    );
  }

  lines.push("");
  lines.push("=== USING THESE ===");
  lines.push("Pass the identifier exactly as printed above to the other gsc_* Tools.");
  lines.push("A Domain Property identifier starts with `sc-domain:` and is not a URL.");

  return toolText(lines.join("\n"));
}

export default defineGoogleTool(
  FAILURE_CONTEXT,
  {
    toolName: "gsc_list_properties",
    // No domain: this Tool is about the account, not about one Site. Keyed on its
    // arguments alone, which is what makes two calls in a turn share one request.
    domainOf: () => null,
  },
  handler,
);

export type { GscProperty };
