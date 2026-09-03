import { describe, expect, it } from "vitest";
import { tally } from "@/lib/analyzers/scored-checks";
import { renderCoverage } from "@/lib/render-scored-checks";
import { eeatOf } from "../../helpers/eeat";
import { performSecurityChecks } from "@/lib/analyzers/security-analyzer";

/**
 * The invariant this file exists to keep: **a score that set points aside says so.**
 *
 * `Tally` grew `notApplicable` and `notEvaluated` so a caller could state its own
 * coverage "without walking the list a second time with different rules than
 * `tally` used — which is exactly how the score and the qualifier beside it would
 * drift apart". The fields existed. Two of the six scoring surfaces then dropped
 * them on the floor:
 *
 *   - `eeat-analyzer` destructured `{ score, max }` per category and hand-summed
 *     the two it kept, so three trustworthiness indicators worth 15 points could
 *     leave the fraction and `seo_eeat_score` printed `Score: 61 / 85` with
 *     nothing saying where the other 15 went.
 *   - `security-analyzer` took HSTS out by zeroing `score` AND `maxScore`, which
 *     did the arithmetic correctly and destroyed the only record that the check
 *     was worth 20 — so an http:// site was graded out of 74 and the report could
 *     not name the missing points even in principle.
 *
 * Both are the failure ADR-0003 exists to prevent, arriving through the analyzer
 * rather than through a refusal: a partial result presented as a whole one. The
 * ADR governs a Tool that cannot run at all; a scored Tool that partly ran owes
 * the same honesty, and `docs/adr/0003` now says so.
 *
 * This is a test rather than a convention for the reason `no-answer-says-why.test.ts`
 * gives about #346: the correct type and the correct helper were both present and
 * the distinction died anyway, in a caller that could take the two fields it liked
 * and ignore the rest.
 */

describe("renderCoverage", () => {
  it("says nothing when nothing was set aside", () => {
    expect(renderCoverage({ notApplicable: 0, notEvaluated: 0 })).toEqual([]);
  });

  it("keeps the two states apart, because only one makes a run incomparable", () => {
    const [notApplicable] = renderCoverage({ notApplicable: 15, notEvaluated: 0 });
    const [notEvaluated] = renderCoverage({ notApplicable: 0, notEvaluated: 8 });

    expect(notApplicable).toContain("do not apply");
    expect(notApplicable).toContain("they are not gaps");
    // The sentence that blames our network rather than the reader's page belongs
    // only to the state that earns it.
    expect(notApplicable).not.toContain("a retry may change the score");
    expect(notEvaluated).toContain("a retry may change the score");
  });

  it("names the subject, which was the only difference worth keeping", () => {
    // Four surfaces had four wordings. Reading them side by side, the page/file/
    // site distinction was the only one carrying meaning; the rest was drift.
    expect(renderCoverage({ notApplicable: 0, notEvaluated: 5 }, { subject: "this file" })[0])
      .toContain("without this file changing");
    expect(renderCoverage({ notApplicable: 0, notEvaluated: 5 }, { subject: "this page" })[0])
      .toContain("without this page changing");
  });

  it("carries a detail clause when the exclusion is structural in a way worth naming", () => {
    const [line] = renderCoverage(
      { notApplicable: 12, notEvaluated: 0 },
      { subject: "this page", notApplicableDetail: "They were N/A for 'product' pages." },
    );
    expect(line).toContain("They were N/A for 'product' pages.");
  });

  it("always says the points left both sides, which a bare numerator hides", () => {
    for (const line of renderCoverage({ notApplicable: 15, notEvaluated: 8 })) {
      expect(line).toContain("excluded from both sides");
    }
  });
});

/**
 * A page with no author, no dates and no trust pages: the shape that turns
 * indicators `not-applicable` and moves the denominator.
 */
const BARE_PRODUCT = `<!DOCTYPE html><html lang="en"><body>
  <h1>A widget</h1>
  <script type="application/ld+json">{"@context":"https://schema.org","@type":"Product","name":"A widget"}</script>
  <p>${"word ".repeat(200)}</p>
</body></html>`;

describe("E-E-A-T reports its coverage", () => {
  const { data } = eeatOf("https://example.com/shop/widget", BARE_PRODUCT);

  it("carries both coverage figures out of the analyzer", () => {
    expect(data).toHaveProperty("notApplicable");
    expect(data).toHaveProperty("notEvaluated");
  });

  it("agrees with one walk of the indicators, so the total cannot drift from its parts", () => {
    const all = [
      ...data.signals.experience.indicators,
      ...data.signals.expertise.indicators,
      ...data.signals.authoritativeness.indicators,
      ...data.signals.trustworthiness.indicators,
    ];
    const walked = tally(all);

    expect(data.score).toBe(walked.score);
    expect(data.maxScore).toBe(walked.max);
    expect(data.notApplicable).toBe(walked.notApplicable);
    expect(data.notEvaluated).toBe(walked.notEvaluated);
  });

  it("accounts for every point an indicator declares", () => {
    // The property that was silently false before: the four figures have to add up
    // to what the checks are worth, or points have gone missing between `tally`
    // and the report.
    const all = [
      ...data.signals.experience.indicators,
      ...data.signals.expertise.indicators,
      ...data.signals.authoritativeness.indicators,
      ...data.signals.trustworthiness.indicators,
    ];
    const declared = all.reduce((sum, indicator) => sum + indicator.points, 0);

    expect(data.maxScore + data.notApplicable + data.notEvaluated).toBe(declared);
  });

  it("gives every category its own coverage, not just the total", () => {
    for (const category of Object.values(data.signals)) {
      expect(category).toHaveProperty("notApplicable");
      expect(category).toHaveProperty("notEvaluated");
    }
  });
});

describe("security headers report their coverage", () => {
  /** RFC 6797 forbids HSTS over plain http, so the check cannot be asked. */
  const overHttp = performSecurityChecks(
    {
      strictTransportSecurity: null,
      contentSecurityPolicy: null,
      xFrameOptions: null,
      xContentTypeOptions: null,
      referrerPolicy: null,
      permissionsPolicy: null,
      xXssProtection: null,
    },
    false,
  );

  it("keeps the excluded check's ceiling instead of zeroing it away", () => {
    const hsts = overHttp.find((check) => check.header === "Strict-Transport-Security")!;

    expect(hsts.status).toBe("not-applicable");
    expect(hsts.score).toBe(0);
    // The line this test exists for. `maxScore: 0` also left the fraction, and
    // also made the 20 points unnameable.
    expect(hsts.maxScore).toBe(20);
  });

  it("excludes it from both sides through `status`, not through the figures", () => {
    const walked = tally(
      overHttp.map((check) => ({
        points: check.maxScore,
        earned: check.score,
        status: check.status,
      })),
    );

    expect(walked.notApplicable).toBe(20);
    const declared = overHttp.reduce((sum, check) => sum + check.maxScore, 0);
    expect(walked.max + walked.notApplicable + walked.notEvaluated).toBe(declared);
    // And the denominator really did move, which is why the sentence is owed.
    expect(walked.max).toBeLessThan(declared);
  });

  it("says nothing about coverage on a transport where every header is answerable", () => {
    const overHttps = performSecurityChecks(
      {
        strictTransportSecurity: "max-age=31536000",
        contentSecurityPolicy: "default-src 'self'",
        xFrameOptions: "DENY",
        xContentTypeOptions: "nosniff",
        referrerPolicy: "no-referrer",
        permissionsPolicy: "geolocation=()",
        xXssProtection: null,
      },
      true,
    );
    const walked = tally(
      overHttps.map((check) => ({
        points: check.maxScore,
        earned: check.score,
        status: check.status,
      })),
    );

    expect(walked.notApplicable).toBe(0);
    expect(renderCoverage(walked)).toEqual([]);
  });
});
