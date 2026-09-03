/**
 * Security headers analyzer.
 * Audits HTTP security headers and provides scoring.
 */

import { type Result, success, failure } from "../type-guards";
import { tally, type Scorable, type ScoreStatus } from "./scored-checks";
import { fetchHeaders, validateUrl } from "../http-client";

export interface SecurityHeaders {
  strictTransportSecurity: string | null;
  contentSecurityPolicy: string | null;
  xFrameOptions: string | null;
  xContentTypeOptions: string | null;
  referrerPolicy: string | null;
  permissionsPolicy: string | null;
  xXssProtection: string | null;
}

/**
  * Deliberately NOT extending `Scorable`: this type says `score`/`maxScore` where
  * `Scorable` says `earned`/`points`, and renaming those two fields would rewrite a
  * stored Section shape to change nothing that matters — the trade-off
  * `scored-checks.ts` already made when it declined to unify the four label fields.
  * What it does take is the vocabulary, so a header whose question this transport
  * cannot answer has somewhere to say so.
  */
export interface SecurityCheck {
  header: string;
  present: boolean;
  value: string | null;
  score: number;
  maxScore: number;
  recommendation: string;
  /**
   * Why this header has no score, when it has none. See `scored-checks.ts`.
   *
   * Set by HSTS over plain `http://`, where RFC 6797 forbids the site to send the
   * header and requires the browser to ignore it — so charging 20 of 94 points
   * plus a CRITICAL for the refusal was scoring a site for a question nobody
   * managed to ask. The scheme arrives as `secureTransport`.
   *
   * **A check with a `status` keeps its `maxScore`.** It used to zero both fields
   * to leave the fraction, which worked — the totals were a `reduce` over them —
   * but it also destroyed the only record that the check was worth 20, so the
   * report printed a score out of 74 and could not say what the missing 20 were.
   * The exclusion is this field's job now, and the totals respect it.
   */
  status?: ScoreStatus;
}

export interface SecurityHeadersResult {
  url: string;
  headers: SecurityHeaders;
  score: number;
  maxScore: number;
  /** Points belonging to headers this transport cannot be asked about. */
  notApplicable: number;
  /** Points belonging to headers that could not be evaluated on this run. */
  notEvaluated: number;
  grade: "A+" | "A" | "B" | "C" | "D" | "F";
  checks: SecurityCheck[];
  recommendations: string[];
}

/**
 * Analyze security headers for a URL.
 * Returns Result type for explicit error handling.
 */
export async function analyzeSecurityHeaders(
  url: string
): Promise<Result<SecurityHeadersResult>> {
  try {
    validateUrl(url);

  // Security headers are server configuration and arrive with any response, so
  // a 404 is still fully answerable. Refusing it declined a question we could
  // answer; the page's content is not the subject here.
  const { headers, finalUrl } = await fetchHeaders(url, undefined, true);

  // The scheme of the response we actually read, after redirects — not of the URL we
  // were handed. A site on http:// that redirects to https:// is the common case, and
  // it is the case where the requested scheme would be wrong.
  //
  // `validateUrl` admits http:// (`parsed.protocol.startsWith("http")`) and the SSRF
  // guard allows both schemes, so an http-only site reaches these checks routinely.
  const secureTransport = new URL(finalUrl).protocol === "https:";

  // Extract security headers
  const securityHeaders: SecurityHeaders = {
    strictTransportSecurity: headers.get("strict-transport-security"),
    contentSecurityPolicy: headers.get("content-security-policy"),
    xFrameOptions: headers.get("x-frame-options"),
    xContentTypeOptions: headers.get("x-content-type-options"),
    referrerPolicy: headers.get("referrer-policy"),
    permissionsPolicy: headers.get("permissions-policy"),
    xXssProtection: headers.get("x-xss-protection"),
  };

  // Perform checks
  const checks = performSecurityChecks(securityHeaders, secureTransport);

  // Two `reduce`s became one `tally`, because the arithmetic of a three-state
  // check is the one thing `scored-checks.ts` exists to own. `SecurityCheck` is
  // still not a `Scorable` — see its comment — so the field names are mapped
  // here, at one call site, rather than by rewriting a stored Section shape.
  const { score, max: maxScore, notApplicable, notEvaluated } = tally(
    checks.map((check) => ({
      points: check.maxScore,
      earned: check.score,
      status: check.status,
    })),
  );

  // Calculate grade
  const percentage = maxScore > 0 ? (score / maxScore) * 100 : 0;
  const grade = calculateGrade(percentage);

  // Generate recommendations
  const recommendations = generateRecommendations(checks, securityHeaders);

  return success({
    url,
    headers: securityHeaders,
    score,
    maxScore,
    notApplicable,
    notEvaluated,
    grade,
    checks,
    recommendations,
  });
  } catch (error) {
    const err = error instanceof Error ? error : new Error(String(error));
    return failure(err);
  }
}

/**
 * Perform security header checks.
 */
/**
 * Exported for the test that pins every check's ceiling to one figure.
 *
 * The three checks with a ladder derive their maximum from the awards, while the
 * absent-header path still states it as a constant. If the two ever disagree, a
 * site is graded against a different denominator depending on whether it sends
 * the header at all — which is the drift this whole shape exists to stop.
 */
export function performSecurityChecks(
  headers: SecurityHeaders,
  /**
   * Whether the response was read over HTTPS.
   *
   * Defaults to `true` so the ladders behave as they always did for every caller
   * that has no scheme to offer — the tests pin ceilings, not transports.
   */
  secureTransport = true,
): SecurityCheck[] {
  const checks: SecurityCheck[] = [];

  // 1. Strict-Transport-Security (HSTS)
  checks.push(checkHSTS(headers.strictTransportSecurity, secureTransport));

  // 2. Content-Security-Policy (CSP)
  checks.push(checkCSP(headers.contentSecurityPolicy));

  // 3. X-Frame-Options
  checks.push(checkXFrameOptions(headers.xFrameOptions));

  // 4. X-Content-Type-Options
  checks.push(checkXContentTypeOptions(headers.xContentTypeOptions));

  // 5. Referrer-Policy
  checks.push(checkReferrerPolicy(headers.referrerPolicy));

  // 6. Permissions-Policy
  checks.push(checkPermissionsPolicy(headers.permissionsPolicy));

  // 7. X-XSS-Protection (deprecated but still checked)
  checks.push(checkXXssProtection(headers.xXssProtection));

  return checks;
}

/**
 * Check HSTS header.
 *
 * The one check in this module with a transport precondition, and it is normative at
 * MUST level in both directions. RFC 6797 §7.2: "An HSTS Host MUST NOT include the
 * STS header field in HTTP responses conveyed over non-secure transport." §8.1: "If
 * an HTTP response is received over insecure transport, the UA MUST ignore any
 * present STS header field(s)."
 *
 * So on a plain-http:// URL this used to demand a header the site is forbidden to
 * send and every browser is required to ignore, and price the refusal at 20 of 94
 * points plus a red CRITICAL — a fifth of the grade for obeying the spec. The
 * implementation guide in `security-tools.ts` already printed "requires HTTPS"; the
 * fact was in the file and not in the arithmetic (#337).
 *
 * Not applicable rather than not evaluated: the answer is settled and deterministic,
 * and will stay settled until the site moves to HTTPS — which is what the detail says
 * to do, since that is the actual finding here and it is bigger than a header.
 *
 * CSP, X-Frame-Options and Referrer-Policy are deliberately NOT gated: CSP3 states no
 * secure-transport precondition and matches insecure origins to secure ones on
 * purpose, and MDN gives no transport condition for the other two. Permissions-Policy
 * is the near miss — the four features we score are all secure-context-only, so
 * restricting them over http changes nothing in practice — but the header is
 * answerable and does real work for features we do not check, so mootness is not
 * inapplicability and it stays scored.
 */
function checkHSTS(value: string | null, secureTransport: boolean): SecurityCheck {
  const maxScore = 20;

  if (!secureTransport) {
    return {
      header: "Strict-Transport-Security",
      present: !!value,
      value,
      // `maxScore` stays 20. `status` is what takes the check out of both sides
      // now, and keeping the ceiling is what lets the report name the 20 points
      // it set aside. Zeroing them did the arithmetic and lost the fact.
      score: 0,
      maxScore,
      status: "not-applicable",
      recommendation:
        "N/A over plain HTTP: RFC 6797 forbids sending HSTS over an insecure connection and requires browsers to ignore it. Move the site to HTTPS — then this header becomes both possible and important.",
    };
  }

  if (!value) {
    return {
      header: "Strict-Transport-Security",
      present: false,
      value: null,
      score: 0,
      maxScore,
      recommendation: "Add HSTS header to enforce HTTPS connections",
    };
  }

  // Check for max-age
  const maxAgeMatch = value.match(/max-age=(\d+)/);
  const maxAge = maxAgeMatch ? parseInt(maxAgeMatch[1], 10) : 0;

  // Check for includeSubDomains
  const hasIncludeSubDomains = value.includes("includeSubDomains");

  // Check for preload
  const hasPreload = value.includes("preload");

  // Ceiling derived from the awards, not declared beside them. The three checks
  // with a ladder each used to carry a literal `maxScore` maintained by hand,
  // and one of them (Permissions-Policy) had drifted to a figure no page could
  // reach.
  const awards: Scorable[] = [
    { points: 10, earned: 10 }, // having HSTS at all
    { points: 5, earned: maxAge >= 31536000 ? 5 : maxAge >= 15768000 ? 3 : 0 },
    { points: 3, earned: hasIncludeSubDomains ? 3 : 0 },
    { points: 2, earned: hasPreload ? 2 : 0 },
  ];
  const { score, max: earnedMax } = tally(awards);

  return {
    header: "Strict-Transport-Security",
    present: true,
    value,
    score,
    maxScore: earnedMax,
    recommendation:
      score < maxScore
        ? "Improve HSTS: use max-age=31536000; includeSubDomains; preload"
        : "HSTS properly configured",
  };
}

/**
 * Check CSP header.
 */
function checkCSP(value: string | null): SecurityCheck {
  const maxScore = 25;

  if (!value) {
    return {
      header: "Content-Security-Policy",
      present: false,
      value: null,
      score: 0,
      maxScore,
      recommendation: "Add CSP header to prevent XSS and injection attacks",
    };
  }

  const awards: Scorable[] = [
    { points: 15, earned: 15 }, // having a CSP at all
    { points: 3, earned: value.includes("default-src") ? 3 : 0 },
    { points: 2, earned: value.includes("script-src") ? 2 : 0 },
    { points: 3, earned: value.includes("object-src 'none'") ? 3 : 0 },
    { points: 2, earned: value.includes("base-uri") ? 2 : 0 },
  ];
  const { score: awarded, max: earnedMax } = tally(awards);

  // Unsafe directives are a penalty, not a missing award: a policy that permits
  // inline script is worse than one that omits the directive, so it can drop
  // below the base. Floored at zero, never above the ceiling.
  const penalty =
    (value.includes("'unsafe-inline'") ? 5 : 0) + (value.includes("'unsafe-eval'") ? 5 : 0);
  const score = Math.max(0, awarded - penalty);

  return {
    header: "Content-Security-Policy",
    present: true,
    value,
    score,
    maxScore: earnedMax,
    recommendation:
      value.includes("'unsafe-inline'") || value.includes("'unsafe-eval'")
        ? "Remove 'unsafe-inline' and 'unsafe-eval' from CSP"
        : "CSP configured",
  };
}

/**
 * Check X-Frame-Options header.
 */
function checkXFrameOptions(value: string | null): SecurityCheck {
  const maxScore = 15;

  if (!value) {
    return {
      header: "X-Frame-Options",
      present: false,
      value: null,
      score: 0,
      maxScore,
      recommendation:
        "Add X-Frame-Options: DENY or SAMEORIGIN to prevent clickjacking",
    };
  }

  const normalizedValue = value.toUpperCase();
  const score =
    normalizedValue === "DENY" || normalizedValue === "SAMEORIGIN"
      ? maxScore
      : 10;

  return {
    header: "X-Frame-Options",
    present: true,
    value,
    score,
    maxScore,
    recommendation:
      score === maxScore
        ? "X-Frame-Options properly configured"
        : "Use DENY or SAMEORIGIN for X-Frame-Options",
  };
}

/**
 * Check X-Content-Type-Options header.
 */
function checkXContentTypeOptions(value: string | null): SecurityCheck {
  const maxScore = 10;

  if (!value) {
    return {
      header: "X-Content-Type-Options",
      present: false,
      value: null,
      score: 0,
      maxScore,
      recommendation:
        "Add X-Content-Type-Options: nosniff to prevent MIME sniffing",
    };
  }

  const score = value.toLowerCase() === "nosniff" ? maxScore : 5;

  return {
    header: "X-Content-Type-Options",
    present: true,
    value,
    score,
    maxScore,
    recommendation:
      score === maxScore
        ? "X-Content-Type-Options properly configured"
        : "Set to 'nosniff'",
  };
}

/**
 * Check Referrer-Policy header.
 */
function checkReferrerPolicy(value: string | null): SecurityCheck {
  const maxScore = 10;

  if (!value) {
    return {
      header: "Referrer-Policy",
      present: false,
      value: null,
      score: 0,
      maxScore,
      recommendation:
        "Add Referrer-Policy header (recommended: strict-origin-when-cross-origin)",
    };
  }

  const goodPolicies = [
    "no-referrer",
    "strict-origin",
    "strict-origin-when-cross-origin",
  ];
  const score = goodPolicies.includes(value.toLowerCase()) ? maxScore : 5;

  return {
    header: "Referrer-Policy",
    present: true,
    value,
    score,
    maxScore,
    recommendation:
      score === maxScore
        ? "Referrer-Policy properly configured"
        : "Use strict-origin-when-cross-origin or stricter",
  };
}

/**
 * Check Permissions-Policy header.
 */
function checkPermissionsPolicy(value: string | null): SecurityCheck {
  // 5 for the header + 1 per restricted feature. Was 10, which no page could reach.
  const maxScore = 9;

  if (!value) {
    return {
      header: "Permissions-Policy",
      present: false,
      value: null,
      score: 0,
      maxScore,
      recommendation:
        "Add Permissions-Policy to control browser features (e.g., geolocation, camera)",
    };
  }

  const restrictedFeatures = [
    "geolocation",
    "camera",
    "microphone",
    "payment",
  ];

  // 5 for having the header, 1 per restricted feature: nine points in total.
  // The declared ceiling was 10, so a page that restricted every feature scored
  // 9 out of 10 and could not be told what the missing point was for. That is
  // what a hand-maintained maximum next to a hand-maintained ladder does.
  const awards: Scorable[] = [
    { points: 5, earned: 5 },
    ...restrictedFeatures.map((feature) => ({
      points: 1,
      earned: value.includes(`${feature}=()`) ? 1 : 0,
    })),
  ];
  const { score, max: earnedMax } = tally(awards);

  return {
    header: "Permissions-Policy",
    present: true,
    value,
    score,
    maxScore: earnedMax,
    recommendation:
      score === maxScore
        ? "Permissions-Policy configured"
        : "Restrict more features in Permissions-Policy",
  };
}

/**
 * Check X-XSS-Protection header (deprecated but still checked).
 */
function checkXXssProtection(value: string | null): SecurityCheck {
  const maxScore = 5; // Lower score as it's deprecated

  if (!value) {
    return {
      header: "X-XSS-Protection",
      present: false,
      value: null,
      score: 0,
      maxScore,
      recommendation:
        "X-XSS-Protection is deprecated. Use CSP instead for XSS protection.",
    };
  }

  // Prefer "0" (disabled) or "1; mode=block"
  const score =
    value === "0" || value === "1; mode=block" ? maxScore : maxScore / 2;

  return {
    header: "X-XSS-Protection",
    present: true,
    value,
    score,
    maxScore,
    recommendation:
      "X-XSS-Protection is deprecated. Modern browsers use CSP instead.",
  };
}

/**
 * Calculate letter grade from percentage.
 */
function calculateGrade(percentage: number): "A+" | "A" | "B" | "C" | "D" | "F" {
  if (percentage >= 95) return "A+";
  if (percentage >= 85) return "A";
  if (percentage >= 75) return "B";
  if (percentage >= 65) return "C";
  if (percentage >= 50) return "D";
  return "F";
}

/**
 * Generate actionable recommendations.
 */
function generateRecommendations(
  checks: SecurityCheck[],
  headers: SecurityHeaders
): string[] {
  const recommendations: string[] = [];
  // A check with a `status` produced no verdict, so there is nothing here to advise
  // about. Keyed by header name because that is the only identifier these two lists
  // share.
  const noVerdict = new Set(checks.filter((c) => c.status).map((c) => c.header));

  // Priority 1: Missing critical headers
  if (noVerdict.has("Strict-Transport-Security")) {
    // The finding on an http:// site is not a missing header, it is the transport.
    // Advising HSTS here advised something RFC 6797 forbids the site to do.
    recommendations.push(
      "CRITICAL: Serve the site over HTTPS. Until then HSTS cannot be sent (RFC 6797) and was not scored."
    );
  } else if (!headers.strictTransportSecurity) {
    recommendations.push(
      "CRITICAL: Add HSTS header (Strict-Transport-Security: max-age=31536000; includeSubDomains; preload)"
    );
  }

  if (!headers.contentSecurityPolicy) {
    recommendations.push(
      "CRITICAL: Add Content-Security-Policy header to prevent XSS attacks"
    );
  }

  if (!headers.xFrameOptions) {
    recommendations.push(
      "HIGH: Add X-Frame-Options: DENY to prevent clickjacking"
    );
  }

  // Priority 2: Missing recommended headers
  if (!headers.xContentTypeOptions) {
    recommendations.push(
      "🟡 MEDIUM: Add X-Content-Type-Options: nosniff to prevent MIME sniffing"
    );
  }

  if (!headers.referrerPolicy) {
    recommendations.push(
      "🟡 MEDIUM: Add Referrer-Policy: strict-origin-when-cross-origin"
    );
  }

  // Priority 3: Configuration improvements
  const failingChecks = checks.filter(
    (c) => c.present && c.score < c.maxScore
  );
  for (const check of failingChecks) {
    if (
      check.header !== "X-XSS-Protection" &&
      !check.recommendation.includes("properly configured")
    ) {
      recommendations.push(`🔵 IMPROVE: ${check.recommendation}`);
    }
  }

  if (recommendations.length === 0) {
    recommendations.push("✓ All security headers properly configured.");
  }

  return recommendations;
}

