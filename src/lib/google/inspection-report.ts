/**
 * Reading Google's inspection result, which is a nest of optional verdicts.
 *
 * Shared by `gsc_inspect_url` and `gsc_bulk_url_inspection` so the two cannot
 * disagree about what "indexed" means — the retired product had them phrase the
 * same verdict differently, and an Operator comparing one URL against a batch
 * had no way to tell whether the wording difference was a data difference.
 *
 * Everything Google returns here is optional, and the absences are meaningful.
 * `verdict` missing is not `FAIL`; it is a check that did not run, and reporting
 * it as a failure invents a defect in someone's site.
 */
import { isRecord } from "../type-guards";
import type { UrlInspection } from "./reader";

export interface IndexStatus {
  /** `PASS`, `PARTIAL`, `FAIL`, `NEUTRAL`, or `null` when Google did not say. */
  verdict: string | null;
  coverageState: string | null;
  robotsTxtState: string | null;
  indexingState: string | null;
  lastCrawlTime: string | null;
  googleCanonical: string | null;
  userCanonical: string | null;
  /** Present when the page was reached through a redirect or an AMP pairing. */
  referringUrls: string[];
}

export interface InspectionSummary {
  index: IndexStatus;
  mobileVerdict: string | null;
  richResultsVerdict: string | null;
  /** Rich result types Google detected, which is what a snippet can show. */
  richResultTypes: string[];
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

export function summarise(inspection: UrlInspection): InspectionSummary {
  const result = isRecord(inspection.inspectionResult) ? inspection.inspectionResult : {};
  const index = isRecord(result.indexStatusResult) ? result.indexStatusResult : {};
  const mobile = isRecord(result.mobileUsabilityResult) ? result.mobileUsabilityResult : {};
  const rich = isRecord(result.richResultsResult) ? result.richResultsResult : {};

  const detected = Array.isArray(rich.detectedItems) ? rich.detectedItems : [];
  const richResultTypes = detected
    .map((item) => (isRecord(item) ? text(item.richResultType) : null))
    .filter((value): value is string => value !== null);

  const referring = Array.isArray(index.referringUrls) ? index.referringUrls : [];

  return {
    index: {
      verdict: text(index.verdict),
      coverageState: text(index.coverageState),
      robotsTxtState: text(index.robotsTxtState),
      indexingState: text(index.indexingState),
      lastCrawlTime: text(index.lastCrawlTime),
      googleCanonical: text(index.googleCanonical),
      userCanonical: text(index.userCanonical),
      referringUrls: referring.map(String),
    },
    mobileVerdict: text(mobile.verdict),
    richResultsVerdict: text(rich.verdict),
    richResultTypes,
  };
}

/**
 * Is Google's chosen canonical a different page from the one declared?
 *
 * The single most useful thing an inspection says, and the one an Operator most
 * often misreads: a page that is "indexed" under a canonical pointing somewhere
 * else is not the page in the results. Only stated when both values are known —
 * comparing against a missing value would report a disagreement that has not
 * been established.
 */
export function canonicalDisagrees(index: IndexStatus): boolean {
  if (!index.googleCanonical || !index.userCanonical) return false;
  return index.googleCanonical !== index.userCanonical;
}

/**
 * One line summarising a URL, for a batch.
 *
 * Deliberately says "not reported" rather than leaving a blank: in a list of
 * fifty URLs a blank column reads as a value of zero or as a pass.
 */
export function oneLine(url: string, summary: InspectionSummary): string {
  const verdict = summary.index.verdict ?? "not reported";
  const coverage = summary.index.coverageState ?? "no coverage state";
  const canonical = canonicalDisagrees(summary.index) ? " — canonical differs from declared" : "";
  return `  [${verdict}] ${url} — ${coverage}${canonical}`;
}
