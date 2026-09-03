/**
 * Rendering one sitemap's record, shared by the two sitemap Tools.
 *
 * ── The counts are strings, and that is Google's doing ──
 *
 * `submitted`, `indexed`, `warnings` and `errors` all arrive as strings from the
 * Search Console API. Comparing them as numbers without converting is how
 * `"9" > "10"` becomes true, so the conversion happens here once rather than at
 * each reader's discretion.
 *
 * ── An absent count is not zero ──
 *
 * Google omits `contents` for a sitemap it has not downloaded yet, and omits
 * `indexed` for one it is still processing. Printing `0 indexed` in either case
 * reports a sitemap Google has not looked at as a sitemap Google rejected. Both
 * are said as "not reported yet" instead, which is also the honest answer to
 * "why is this number missing".
 */
import type { Sitemap } from "./reader";

function count(value: string | undefined): number | null {
  if (value === undefined) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function orNotReported(value: number | null, unit: string): string {
  return value === null ? `not reported yet` : `${value} ${unit}`;
}

/** One sitemap, as lines. */
export function renderSitemap(sitemap: Sitemap): string[] {
  const lines: string[] = [];

  lines.push(sitemap.path ?? "(no path reported)");
  if (sitemap.isSitemapsIndex) {
    // Worth saying: an index's own counts describe its children collectively,
    // and an Operator comparing it against one child's numbers is comparing
    // different things.
    lines.push("  This is a sitemap index; the counts below cover the sitemaps it lists.");
  }
  lines.push(`  Type: ${sitemap.type ?? "not reported"}`);
  lines.push(`  Last submitted: ${sitemap.lastSubmitted ?? "not reported"}`);
  lines.push(
    `  Last downloaded by Google: ${sitemap.lastDownloaded ?? "never — Google has not fetched it yet"}`,
  );

  if (sitemap.isPending) {
    lines.push("  Google has this sitemap queued and has not processed it yet.");
  }

  const warnings = count(sitemap.warnings);
  const errors = count(sitemap.errors);
  lines.push(`  Warnings: ${orNotReported(warnings, "")}`.trimEnd());
  lines.push(`  Errors: ${orNotReported(errors, "")}`.trimEnd());
  if (errors !== null && errors > 0) {
    lines.push("  Errors mean Google could not read part of this sitemap; open it in Search");
    lines.push("  Console to see which lines.");
  }

  const contents = sitemap.contents ?? [];
  if (contents.length === 0) {
    lines.push("  URL counts: not reported yet — Google reports these once it has processed the file.");
    return lines;
  }

  for (const entry of contents) {
    const submitted = count(entry.submitted);
    const indexed = count(entry.indexed);
    lines.push(
      `  ${entry.type ?? "urls"}: ${orNotReported(submitted, "submitted")}, ${orNotReported(indexed, "indexed")}`,
    );

    // The comparison an Operator actually wants, and only where both numbers
    // exist. A ratio computed against a missing `indexed` would report a healthy
    // sitemap as entirely unindexed.
    if (submitted !== null && indexed !== null && submitted > 0) {
      const share = Math.round((indexed / submitted) * 100);
      lines.push(`    ${share}% of what this sitemap declares is indexed.`);
      if (share < 50) {
        lines.push(
          "    Under half. That is worth looking at, though it is not automatically a fault:",
        );
        lines.push(
          "    a sitemap listing pages that redirect, are noindex, or duplicate each other will",
        );
        lines.push("    read like this and the sitemap is what needs fixing, not the pages.");
      }
    }
  }

  return lines;
}
