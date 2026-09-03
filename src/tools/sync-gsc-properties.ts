import { z } from "zod";
import { type ToolMetadata, type InferSchema } from "xmcp";
import { defineGoogleTool } from "../lib/define-tool";
import { refreshable } from "../lib/with-cache";
import { toolText } from "../lib/tool-result";
import { accessFor, type PropertyAccess } from "../lib/google/property-access";
import { listSites, registerSite, rememberGoogleProperty, NoDatabaseError } from "../lib/sites";
import { persistenceStatus } from "../lib/db/runtime";
import type { GoogleReader, Ga4Property } from "../lib/google/reader";

export const schema = {
  ...refreshable,
  domains: z
    .array(z.string())
    .optional()
    .describe(
      "Domains to register as Sites before checking, e.g. ['example.com']. Already " +
        "registered domains are left alone. Omit to check the Sites already registered.",
    ),
};

export const metadata: ToolMetadata = {
  name: "sync_gsc_properties",
  description:
    "Register domains as Sites and ask Google which of them a Full Report is possible " +
    "for: which Search Console property covers each, and whether this account can " +
    "actually read it. Access is checked against Google on every run rather than " +
    "remembered, so gaining or losing access in Search Console shows up here without " +
    "any other step. Needs the Google login; without it this Tool says so.",
  annotations: {
    title: "Register Sites and check Google access",
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: true,
  },
};

/** Completes the sentence "Could not …" for every failure this Tool can return. */
const FAILURE_CONTEXT = "register these Sites and check their Google access";

/**
 * The Analytics property whose display name mentions this domain, if one does.
 *
 * A guess, and labelled as one wherever it is printed. GA4 has no property
 * identifier that carries a domain — a property is a number and a name somebody
 * typed — so there is nothing to match on but that name. It is offered as a
 * suggestion rather than stored as a link, because a wrong guess silently
 * attached to a Site would send every later report at the wrong property.
 */
function suggestGa4(domain: string, properties: readonly Ga4Property[]): Ga4Property | null {
  const needle = domain.toLowerCase();
  return (
    properties.find((property) => property.displayName.toLowerCase().includes(needle)) ?? null
  );
}

function describe(state: PropertyAccess["state"]): string {
  return state === "granted"
    ? "Full Report available"
    : state === "unverified"
      ? "property found, not verified"
      : "no property";
}

export async function handler({ domains }: InferSchema<typeof schema>, google: GoogleReader) {
  const status = persistenceStatus();
  if (!status.available) {
    // Registering a Site is a write, and there is nowhere to write it. Said
    // before anything is asked of Google, so an Operator is not told about
    // properties for Sites that were never recorded.
    throw new NoDatabaseError(status.reason ?? "persistence is unavailable");
  }

  for (const domain of domains ?? []) registerSite(domain);

  const sites = listSites();
  const lines: string[] = ["=== SITES AND GOOGLE ACCESS ==="];

  if (sites.length === 0) {
    lines.push("");
    lines.push("No Sites are registered yet.");
    lines.push("");
    lines.push("Pass `domains` to register some — sync_gsc_properties(domains: ['example.com'])");
    lines.push("— or run run_site_audit on a domain, which registers it as a side effect.");
    return toolText(lines.join("\n"));
  }

  // One request for the whole list, however many Sites there are. Read fresh on
  // every run and never stored: an Operator who gained or lost access in Search
  // Console sees it here without doing anything else.
  const [gscProperties, ga4Properties] = await Promise.all([
    google.searchConsole.listProperties(),
    // Analytics is a suggestion rather than a check, so its failure must not
    // take down the Search Console answer, which is the one this Tool is about.
    google.analytics.listProperties().catch(() => [] as Ga4Property[]),
  ]);

  lines.push(`Sites registered: ${sites.length}`);
  lines.push(`Search Console properties this account can read: ${gscProperties.length}`);

  const results = sites.map((site) => ({ site, access: accessFor(site.domain, gscProperties) }));

  const granted = results.filter((result) => result.access.state === "granted");
  const unverified = results.filter((result) => result.access.state === "unverified");
  const absent = results.filter((result) => result.access.state === "absent");

  lines.push("");
  lines.push("=== SUMMARY ===");
  lines.push(`Full Report available: ${granted.length}`);
  lines.push(`Property found but unverified: ${unverified.length}`);
  lines.push(`No matching property: ${absent.length}`);

  for (const { site, access } of results) {
    // The pointer is refreshed, including being cleared when the property went
    // away. Storing a stale identifier would send the next report at a property
    // this account no longer holds.
    rememberGoogleProperty(site.domain, { gscSiteUrl: access.siteUrl });

    lines.push("");
    lines.push(`${site.domain} — ${describe(access.state)}`);
    if (access.siteUrl) {
      lines.push(`  Search Console: ${access.siteUrl} (${access.permissionLevel})`);
    }
    lines.push(`  ${access.explanation}`);

    const ga4 = suggestGa4(site.domain, ga4Properties);
    if (ga4) {
      lines.push(`  Analytics, possibly: ${ga4.name} — "${ga4.displayName}"`);
      lines.push("  Matched on the property's display name, which is a guess: GA4 identifies a");
      lines.push("  property by a number, not by a domain. Confirm it before relying on it.");
    }
  }

  lines.push("");
  lines.push("=== HOW THIS WAS DECIDED ===");
  lines.push("Every line above was answered by asking Google just now. Nothing about access is");
  lines.push("stored, so a property you verify or lose after this run will be reflected the");
  lines.push("next time any Tool asks — you do not need to re-run this.");

  return toolText(lines.join("\n"));
}

export default defineGoogleTool(
  FAILURE_CONTEXT,
  {
    toolName: "sync_gsc_properties",
    domainOf: () => null,
    // Deliberately short. This Tool's whole claim is that it reflects access as
    // it is now, and an hour-old cached answer would contradict that on the one
    // run an Operator makes right after fixing their verification.
    ttlMs: 30_000,
  },
  handler,
);
