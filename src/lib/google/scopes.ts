/**
 * What the server asks Google for, and what stops working without each one.
 *
 * The reasons are not documentation decoration. An Operator is about to see a
 * consent screen listing permissions over their own search and analytics data,
 * and the honest thing is to have told them beforehand what each one buys —
 * #17 makes that a documentation requirement and this is where the sentences
 * live, so the login command, the docs and the consent screen cannot disagree.
 *
 * **Both are read-only, and that is a design constraint rather than a default.**
 * Search Console offers `webmasters` (read and write), which would let this
 * server submit sitemaps and request indexing. Nothing here needs to and nothing
 * here should: an Operator granting access to look at their data has not agreed
 * to have it changed, and a read-only token cannot be turned into a write by a
 * later bug or a later Tool.
 */

export interface Scope {
  url: string;
  /** The Google product, as the Operator knows it. */
  product: string;
  /** What becomes impossible without it, in Tool terms. */
  withoutIt: string;
}

export const GOOGLE_SCOPES: readonly Scope[] = [
  {
    url: "https://www.googleapis.com/auth/webmasters.readonly",
    product: "Search Console",
    withoutIt:
      "every gsc_* Tool refuses, and run_site_audit cannot produce a Full Report — " +
      "no impressions, clicks, positions, index coverage or URL inspection.",
  },
  {
    url: "https://www.googleapis.com/auth/analytics.readonly",
    product: "Analytics (GA4)",
    withoutIt:
      "every ga4_* Tool refuses, including ga4_ai_traffic, which is the only way to " +
      "see visits arriving from AI assistants.",
  },
] as const;

/** The scope strings, in the order the consent screen will list them. */
export const SCOPE_URLS: readonly string[] = GOOGLE_SCOPES.map((scope) => scope.url);

/**
 * The scopes, written out for a person about to authorize.
 *
 * Returned as lines rather than printed, so the login command owns where they go
 * and this module owns what they say.
 */
export function describeScopes(): string[] {
  const lines = ["This asks Google for read-only access to:"];
  for (const scope of GOOGLE_SCOPES) {
    lines.push("");
    lines.push(`  ${scope.product}  (${scope.url})`);
    lines.push(`    Without it: ${scope.withoutIt}`);
  }
  lines.push("");
  lines.push(
    "Read-only in both cases. This server never submits a sitemap, requests indexing,",
  );
  lines.push("or writes anything to your Google account.");
  return lines;
}
