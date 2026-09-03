import { type ToolMetadata, type InferSchema } from "xmcp";
import { defineGoogleTool } from "../lib/define-tool";
import { refreshable } from "../lib/with-cache";
import { toolText } from "../lib/tool-result";
import type { GoogleReader } from "../lib/google/reader";

export const schema = {
  ...refreshable,
};

export const metadata: ToolMetadata = {
  name: "ga4_list_properties",
  description:
    "List the Google Analytics properties this account can read, with the account " +
    "each belongs to. Start here: every other ga4_* Tool needs a property id. " +
    "Needs the Google login; without it this Tool says so.",
  annotations: {
    title: "List Analytics properties",
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: true,
  },
};

/** Completes the sentence "Could not …" for every failure this Tool can return. */
const FAILURE_CONTEXT = "list your Analytics properties";

export async function handler(_args: InferSchema<typeof schema>, google: GoogleReader) {
  const properties = await google.analytics.listProperties();
  const lines: string[] = ["=== ANALYTICS PROPERTIES ==="];

  if (properties.length === 0) {
    lines.push("");
    lines.push("This Google account can read no Analytics properties.");
    lines.push("");
    lines.push("If you expected some, check that the login used the account they belong to —");
    lines.push("re-run the login command to switch accounts. Note that Analytics access is");
    lines.push("granted per property, so an account that owns the Search Console property does");
    lines.push("not necessarily hold the Analytics one.");
    return toolText(lines.join("\n"));
  }

  lines.push(`Properties: ${properties.length}`);

  // Grouped by account, because a consultancy account holds properties belonging
  // to different clients and a flat list of display names does not say which.
  const byAccount = new Map<string, typeof properties>();
  for (const property of properties) {
    const account = property.account ?? "(no account name)";
    byAccount.set(account, [...(byAccount.get(account) ?? []), property]);
  }

  for (const [account, owned] of byAccount) {
    lines.push("");
    lines.push(`${account}`);
    for (const property of owned) {
      lines.push(`  ${property.name} — ${property.displayName}`);
    }
  }

  lines.push("");
  lines.push("=== USING THESE ===");
  lines.push("Pass the numeric id, or the whole `properties/123456789`, to the other ga4_*");
  lines.push("Tools. Both are accepted.");

  return toolText(lines.join("\n"));
}

export default defineGoogleTool(
  FAILURE_CONTEXT,
  { toolName: "ga4_list_properties", domainOf: () => null },
  handler,
);
