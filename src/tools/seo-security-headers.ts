import { z } from "zod";
import { type ToolMetadata, type InferSchema } from "xmcp";
import { analyzeSecurityHeaders } from "../lib/analyzers/security-analyzer";
import { renderVerdict } from "../lib/render-check";
import { defineCachedTool } from "../lib/define-tool";
import { domainFromUrl, refreshable } from "../lib/with-cache";
import { toolFailure } from "../lib/tool-failure";
import { toolText } from "../lib/tool-result";

export const schema = {
  ...refreshable,
  url: z.string().url().describe("The URL to audit for security headers"),
};

export const metadata: ToolMetadata = {
  name: "seo_security_headers",
  description:
    "Read a URL's HTTP security headers — HSTS, Content-Security-Policy, " +
    "X-Frame-Options, X-Content-Type-Options, Referrer-Policy, Permissions-Policy — " +
    "grade them, and say what to add. Headers are read from whatever response comes " +
    "back, so a 404 is still answerable. Needs no credentials and no database.",
  annotations: {
    title: "Check security headers",
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: true,
  },
};

/** Completes the sentence "Could not …" for every failure this Tool can return. */
const FAILURE_CONTEXT = "check the security headers for this URL";

export default defineCachedTool(FAILURE_CONTEXT, { toolName: "seo_security_headers", domainOf: domainFromUrl }, async ({ url }: InferSchema<typeof schema>) => {
  const result = await analyzeSecurityHeaders(url);

  if (!result.success) {
    return toolFailure(result.error, FAILURE_CONTEXT);
  }

  const data = result.data;
  const lines: string[] = [];

  // What this Tool does not do, said before the score rather than after it. The
  // CSP check looks for two named mistakes; it does not evaluate a policy.
  lines.push("Note: CSP validation checks for common issues (unsafe-inline, unsafe-eval) but");
  lines.push("does not fully validate CSP syntax or coverage. Use https://csp-evaluator.withgoogle.com");
  lines.push("for a thorough CSP audit.");
  lines.push("");

  lines.push("=== SECURITY SCORE ===");
  lines.push(`Grade: ${data.grade}`);
  lines.push(
    `Score: ${data.score} / ${data.maxScore} (${Math.round((data.score / data.maxScore) * 100)}%)`,
  );

  lines.push("");
  lines.push("=== SECURITY HEADERS ===");
  for (const check of data.checks) {
    // A header with a `status` was not judged, so it gets neither a tick nor a
    // cross and no figures — `0/0` would read as a header worth nothing.
    //
    // `SecurityCheck` is not a `Scorable`: it says `score`/`maxScore` where the
    // shared type says `earned`/`points`. The literal below is why `renderVerdict`
    // takes four loose fields rather than a `Scorable` — no adapter, no
    // intermediate type, and no stored shape rewritten to make a renderer happy.
    const { mark, words } = renderVerdict({
      status: check.status,
      passed: check.present,
      earned: check.score,
      points: check.maxScore,
    });
    const verdict = words
      ? `${mark} ${words}`
      : check.present
        ? `${mark} Present (${check.score}/${check.maxScore})`
        : `${mark} Missing (0/${check.maxScore})`;

    lines.push("");
    lines.push(`${check.header}: ${verdict}`);
    if (check.value) lines.push(`  Value: ${check.value}`);
    lines.push(`  ${check.recommendation}`);
  }

  lines.push("");
  lines.push("=== RECOMMENDATIONS ===");
  lines.push(...data.recommendations);

  lines.push("");
  lines.push("=== IMPLEMENTATION GUIDE ===");

  // Only where the check actually returned a verdict. On an http:// site the
  // guide used to print "Add HSTS (requires HTTPS)" — which named the
  // precondition and then handed over a header the site cannot legally send.
  const hstsJudged = !data.checks.some(
    (c) => c.header === "Strict-Transport-Security" && c.status,
  );
  if (hstsJudged && !data.headers.strictTransportSecurity) {
    lines.push("");
    lines.push("Add HSTS (requires HTTPS):");
    lines.push("  Strict-Transport-Security: max-age=31536000; includeSubDomains; preload");
  }

  if (!data.headers.contentSecurityPolicy) {
    lines.push("");
    lines.push("Add CSP (basic example):");
    lines.push(
      "  Content-Security-Policy: default-src 'self'; script-src 'self'; object-src 'none'; base-uri 'self'",
    );
  }

  if (!data.headers.xFrameOptions) {
    lines.push("");
    lines.push("Add X-Frame-Options:");
    lines.push("  X-Frame-Options: DENY");
  }

  if (!data.headers.xContentTypeOptions) {
    lines.push("");
    lines.push("Add X-Content-Type-Options:");
    lines.push("  X-Content-Type-Options: nosniff");
  }

  if (!data.headers.referrerPolicy) {
    lines.push("");
    lines.push("Add Referrer-Policy:");
    lines.push("  Referrer-Policy: strict-origin-when-cross-origin");
  }

  if (!data.headers.permissionsPolicy) {
    lines.push("");
    lines.push("Add Permissions-Policy:");
    lines.push("  Permissions-Policy: geolocation=(), camera=(), microphone=(), payment=()");
  }

  return toolText(lines.join("\n"));
});
