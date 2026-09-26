/**
 * Which schema.org types can become which of Google's rich results — our
 * mapping, not Google's.
 *
 * ── Why the mapping has to be ours ──
 *
 * URL Inspection reports what it detected as `richResultsResult.detectedItems[]`,
 * each with a `richResultType` that the API reference describes only as "Rich
 * Results type", with no list of values
 * (https://developers.google.com/webmaster-tools/v1/urlInspection.index/UrlInspectionResult).
 * In practice they are the names of Search Console's enhancement reports —
 * "Breadcrumbs", "Product snippets", "Merchant listings", "Review snippets" —
 * but that is observed, not documented, and Google renames and retires them.
 *
 * So the comparison is by keyword, case-insensitively: a detected type counts
 * as `Product` when its name contains "product" or "merchant". A type Google
 * reports that no keyword here matches is listed as "not mapped" and compared
 * with nothing, rather than guessed at. The schema side follows the feature list
 * in Google's search gallery
 * (https://developers.google.com/search/docs/appearance/structured-data/search-gallery),
 * read 2026-09-24.
 *
 * ── Retired, and declared anyway ──
 *
 * FAQ and HowTo markup is still on a great many pages. Google shows the FAQ rich
 * result "only … for well-known, authoritative government and health websites",
 * and its page says Search Console stopped reporting it from January 2026
 * (https://developers.google.com/search/docs/appearance/structured-data/faqpage);
 * HowTo is listed as no longer shown. A page declaring either with no rich result
 * detected is the expected outcome, and saying so is the difference between a
 * finding and a false one.
 */
import { isRecord } from "./type-guards";
import type { UrlInspection } from "./google/reader";

interface Mapping {
  /** schema.org types, any of which can produce the rich result. */
  schemaTypes: readonly string[];
  /** Words that identify the rich result in a `richResultType`, lowercase. */
  keywords: readonly string[];
  /**
   * Recognise the rich result when Google reports it, but never expect it.
   *
   * For markup a site ships on every page while Google reports its result for
   * one or none, or for markup nested inside another type's result:
   * `Organization` sits in the template of most sites, and Google's
   * logo result belongs to the site rather than to each page carrying it. Saying
   * "declared, not detected" on every such page would be ten findings about one
   * sitewide choice that is not wrong.
   */
  recogniseOnly?: true;
}

const MAPPINGS: readonly Mapping[] = [
  { schemaTypes: ["BreadcrumbList"], keywords: ["breadcrumb"] },
  { schemaTypes: ["Product", "ProductGroup"], keywords: ["product", "merchant"] },
  // Recognised only: a rating is usually nested in a Product or a Recipe, and
  // Google shows its stars inside that type's result rather than as a review
  // snippet of its own, so expecting one would flag every rated product.
  { schemaTypes: ["Review", "AggregateRating"], keywords: ["review"], recogniseOnly: true },
  { schemaTypes: ["Recipe"], keywords: ["recipe"] },
  { schemaTypes: ["VideoObject"], keywords: ["video"] },
  { schemaTypes: ["Event"], keywords: ["event"] },
  { schemaTypes: ["JobPosting"], keywords: ["job"] },
  { schemaTypes: ["Organization", "Corporation", "OnlineStore", "NGO"], keywords: ["logo", "organization"], recogniseOnly: true },
  { schemaTypes: ["LocalBusiness"], keywords: ["local business"], recogniseOnly: true },
  { schemaTypes: ["QAPage"], keywords: ["q&a", "q & a", "qa page"] },
  { schemaTypes: ["ProfilePage"], keywords: ["profile"] },
  { schemaTypes: ["DiscussionForumPosting", "SocialMediaPosting"], keywords: ["discussion"] },
  { schemaTypes: ["Dataset"], keywords: ["dataset"] },
  { schemaTypes: ["Course"], keywords: ["course"] },
  { schemaTypes: ["SoftwareApplication", "MobileApplication", "WebApplication"], keywords: ["software"] },
  { schemaTypes: ["Movie"], keywords: ["movie"] },
  { schemaTypes: ["VacationRental"], keywords: ["vacation"] },
  { schemaTypes: ["MathSolver"], keywords: ["math"] },
];

/** Types whose rich result Google no longer shows to most sites. See the header. */
export const RETIRED_TYPES: Readonly<Record<string, string>> = {
  FAQPage:
    "Google shows FAQ rich results only for well-known, authoritative government and health " +
    "sites, and stopped reporting them in Search Console from January 2026",
  HowTo: "Google no longer shows HowTo rich results",
};

/** Does this detected rich result name match this mapping? */
function matches(richResultType: string, mapping: Mapping): boolean {
  const name = richResultType.toLowerCase();
  return mapping.keywords.some((keyword) => name.includes(keyword));
}

/**
 * The schema types that can produce this detected rich result, or `null` when
 * our mapping has nothing for it — which is "not compared", not "no markup".
 */
export function schemaTypesFor(richResultType: string): readonly string[] | null {
  const found = MAPPINGS.filter((mapping) => matches(richResultType, mapping));
  return found.length > 0 ? found.flatMap((mapping) => mapping.schemaTypes) : null;
}

/**
 * Is a rich result worth expecting from this declared type, by our mapping?
 *
 * False for a type we do not map, and for the sitewide types marked
 * `recogniseOnly` above.
 */
export function expectsRichResult(schemaType: string): boolean {
  return MAPPINGS.some((mapping) => !mapping.recogniseOnly && mapping.schemaTypes.includes(schemaType));
}

/** Would this detected rich result be the one this declared type produces? */
export function producedBy(richResultType: string, schemaType: string): boolean {
  return MAPPINGS.some((mapping) => mapping.schemaTypes.includes(schemaType) && matches(richResultType, mapping));
}

export interface RichResultIssue {
  /** `ERROR` or `WARNING`, or `null` when Google did not say. */
  severity: string | null;
  message: string;
}

export interface DetectedRichResult {
  type: string;
  /** Every issue on every item of this type, flattened. */
  issues: RichResultIssue[];
}

/**
 * What URL Inspection detected, with each item's issues.
 *
 * `inspection-report.ts` reads the type names for the other Tools and stops
 * there; this reads the issues too, because "markup there, rich result withheld"
 * is exactly what `site_schema_detection_gap` exists to find. Every field is
 * optional in Google's shape and treated so.
 */
export function detectedRichResults(inspection: UrlInspection): DetectedRichResult[] {
  const result = isRecord(inspection.inspectionResult) ? inspection.inspectionResult : {};
  const rich = isRecord(result.richResultsResult) ? result.richResultsResult : {};
  const detected = Array.isArray(rich.detectedItems) ? rich.detectedItems : [];

  const out: DetectedRichResult[] = [];
  for (const item of detected) {
    if (!isRecord(item) || typeof item.richResultType !== "string" || item.richResultType.length === 0) continue;
    const issues: RichResultIssue[] = [];
    for (const entry of Array.isArray(item.items) ? item.items : []) {
      if (!isRecord(entry) || !Array.isArray(entry.issues)) continue;
      for (const issue of entry.issues) {
        if (!isRecord(issue)) continue;
        const message = typeof issue.issueMessage === "string" && issue.issueMessage.length > 0
          ? issue.issueMessage
          : "an issue Google did not describe";
        issues.push({ severity: typeof issue.severity === "string" ? issue.severity : null, message });
      }
    }
    out.push({ type: item.richResultType, issues });
  }
  return out;
}
