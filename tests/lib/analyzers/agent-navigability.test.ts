import { describe, it, expect } from "vitest";
import {
  judgeNavigability,
  type NavigabilityProbes,
} from "@/lib/analyzers/agent-navigability";
import { PROBE_PATH, type Landing, type Probe } from "@/lib/analyzers/agent-probe";
import { tally } from "@/lib/analyzers/scored-checks";

/**
 * The navigability checks, on plain data.
 *
 * There was no test like this. The checks were already "response in, verdict
 * out", but they sat behind a function that fetched first, so the only way to
 * reach any of them was through a stubbed `fetch` —
 * `tests/tools/seo-agent-navigability.test.ts` is 90 lines against a 624-line
 * analyzer for that reason, and the intricate parts were reachable only by
 * arranging a route table to produce them.
 *
 * `judgeNavigability` is pure, and `Probe` and `Landing` are records, so every
 * case below is a literal. ADR-0006 is the axis these checks answer to; rule 8
 * is the one most of these assertions are about.
 */

const SITE = "https://example.com/";

function ok(over: Partial<Extract<Probe, { ok: true }>> = {}): Probe {
  return {
    ok: true,
    status: 200,
    headers: new Headers({ "content-type": "text/html; charset=utf-8" }),
    body: "<html><body>copy</body></html>",
    url: SITE,
    ...over,
  };
}

function landed(probe: Probe, over: Partial<Landing> = {}): Landing {
  return {
    requested: probe.ok ? probe.url : probe.url,
    probe,
    hops: [],
    offHost: null,
    finalUrl: probe.ok ? probe.url : probe.url,
    ...over,
  };
}

/** A site that answers everything plainly: HTML at the root, a 404 at the probe. */
function probes(over: Partial<NavigabilityProbes> = {}): NavigabilityProbes {
  return {
    landing: landed(ok()),
    missing: landed(ok({ status: 404, url: `https://example.com${PROBE_PATH}`, body: "Not Found" })),
    markdown: ok({ headers: new Headers({ "content-type": "text/html" }) }),
    ...over,
  };
}

const check = (result: ReturnType<typeof judgeNavigability>, name: RegExp) => {
  const found = result.checks.find((c) => name.test(c.name));
  if (!found) throw new Error(`no check matching ${name} in ${result.checks.map((c) => c.name).join(", ")}`);
  return found;
};

describe("the shape of a reading", () => {
  it("reports the landed URL, not the one it was given", () => {
    const result = judgeNavigability("https://example.com/typed", probes({
      landing: landed(ok({ url: "https://example.com/landed" }), {
        requested: "https://example.com/typed",
        finalUrl: "https://example.com/landed",
      }),
    }));

    expect(result.url).toBe("https://example.com/typed");
    expect(result.finalUrl).toBe("https://example.com/landed");
  });

  it("derives its totals from the checks, in one walk", () => {
    const result = judgeNavigability(SITE, probes());
    const walked = tally(result.checks);

    expect(result.score).toBe(walked.score);
    expect(result.max).toBe(walked.max);
    expect(result.notApplicable).toBe(walked.notApplicable);
    expect(result.notEvaluated).toBe(walked.notEvaluated);
  });

  it("accounts for every point its checks declare", () => {
    const result = judgeNavigability(SITE, probes());
    const declared = result.checks.reduce((sum, c) => sum + c.points, 0);

    expect(result.max + result.notApplicable + result.notEvaluated).toBe(declared);
  });

  it("ships a reproducing request with every check", () => {
    // ADR-0006: an agent-readiness check is an assertion about a response, so a
    // reader who cannot re-run it cannot check our work.
    for (const c of judgeNavigability(SITE, probes()).checks) {
      expect(c.request, c.name).toMatch(/^curl /);
    }
  });
});

describe("does the site have a distinct 404", () => {
  it("passes on a 404 at the probe path", () => {
    expect(check(judgeNavigability(SITE, probes()), /404/).passed).toBe(true);
  });

  it("fails on a 200, which is a site that answers everything", () => {
    const result = judgeNavigability(SITE, probes({
      missing: landed(ok({ status: 200, url: `https://example.com${PROBE_PATH}` })),
    }));

    expect(check(result, /does not exist returns 404/).passed).toBe(false);
  });

  it("sees a 404 that sits one hop behind a locale guard", () => {
    // The case that made the probe path landed rather than fetched once: a guard
    // answering `/x` with a 308 to `/en/x`, where stopping at the 308 reported
    // "this site does not 404" about a site whose 404 is one hop away.
    const result = judgeNavigability(SITE, probes({
      missing: landed(
        ok({ status: 404, url: `https://example.com/en${PROBE_PATH}` }),
        {
          requested: `https://example.com${PROBE_PATH}`,
          hops: [{
            url: `https://example.com${PROBE_PATH}`,
            status: 308,
            location: `https://example.com/en${PROBE_PATH}`,
          }],
          finalUrl: `https://example.com/en${PROBE_PATH}`,
        },
      ),
    }));

    expect(check(result, /does not exist returns 404/).passed).toBe(true);
  });

  it("says it could not tell when the probe request failed", () => {
    const result = judgeNavigability(SITE, probes({
      missing: landed({ ok: false, reason: "timed out", url: `https://example.com${PROBE_PATH}` }),
    }));

    // Rule 8: a question we did not ask costs nothing, and leaves both sides.
    const verdict = check(result, /does not exist returns 404/);
    expect(verdict.status).toBe("not-evaluated");
    expect(verdict.detail).toContain("not a finding about the page");
  });

  it("refuses to guess when the probe path redirects off the host", () => {
    const offHost = {
      url: `https://example.com${PROBE_PATH}`,
      status: 302,
      location: "https://elsewhere.test/gone",
    };
    const result = judgeNavigability(SITE, probes({
      missing: landed(ok({ status: 302, url: `https://example.com${PROBE_PATH}` }), { offHost }),
    }));

    const verdict = check(result, /does not exist returns 404/);
    // Neither a zero nor an innocent `notScored`. The hop is a fact about the
    // site, so the sentence must not claim innocence on its behalf — but we never
    // followed it, so whether the path 404s is genuinely unknown, and charging
    // for an unasked question is what ADR-0006 rule 8 forbids.
    expect(verdict.status).toBe("not-evaluated");
    expect(verdict.detail).toContain("elsewhere.test");
  });

  it("leaves the check unscored when robots.txt disallowed the probe", () => {
    const result = judgeNavigability(SITE, probes({
      missing: landed({
        ok: false,
        reason: "robots.txt disallows this path for our crawler",
        url: `https://example.com${PROBE_PATH}`,
        blockedByRobots: true,
      }),
    }));

    const verdict = check(result, /does not exist returns 404/);
    expect(verdict.status).toBe("not-evaluated");
    // ADR-0006 rule 8, third bullet. `notScored`'s sentence would be two lies at
    // once: it claims innocence on the page's behalf when the cause is the page's
    // own robots.txt, and it says "try again" when trying again is what we have
    // undertaken not to do. Every check here used `couldNotRun` and none read
    // `blockedByRobots`; the two sibling tiers had five adapters of `disallowed`
    // and this one had none.
    expect(verdict.detail).not.toContain("not a finding about the page");
    expect(verdict.detail).toContain("robots.txt disallows");
    expect(verdict.detail).toContain("Nothing was fetched");
  });

  it("draws that distinction in every check, not just the first", () => {
    // One helper rather than a `blockedByRobots` branch per check, for the reason
    // `agent-probe.ts` gives about the same-host guard: two copies of a
    // distinction is the copy that eventually stops drawing it.
    const blocked = {
      ok: false as const,
      reason: "robots.txt disallows this path for our crawler",
      url: SITE,
      blockedByRobots: true,
    };
    const result = judgeNavigability(SITE, {
      landing: landed(blocked),
      missing: landed({ ...blocked, url: `https://example.com${PROBE_PATH}` }),
      markdown: blocked,
    });

    const unscored = result.checks.filter((c) => c.status === "not-evaluated");
    expect(unscored.length).toBeGreaterThan(3);
    for (const c of unscored) {
      expect(c.detail, c.name).not.toContain("not a finding about the page");
    }
    // And nothing is charged for any of it.
    expect(result.score).toBe(0);
    expect(result.max).toBe(0);
  });
});

describe("does the site serve markdown", () => {
  const asMarkdown = () =>
    ok({ headers: new Headers({ "content-type": "text/markdown; charset=utf-8" }), body: "# Title" });

  it("passes when the same URL answers text/markdown", () => {
    const result = judgeNavigability(SITE, probes({ markdown: asMarkdown() }));

    expect(check(result, /markdown/i).passed).toBe(true);
  });

  it("does not pass when the markdown request comes back as HTML", () => {
    expect(check(judgeNavigability(SITE, probes()), /markdown/i).passed).toBe(false);
  });

  it("gates the checks that only mean something for a markdown site", () => {
    // Read off the variant check rather than recomputed, so a site can never be
    // told it serves markdown by one check and not by another.
    const html = judgeNavigability(SITE, probes());
    const md = judgeNavigability(SITE, probes({ markdown: asMarkdown() }));

    const fencesOnHtml = check(html, /fence/i);
    const fencesOnMarkdown = check(md, /fence/i);

    expect(fencesOnHtml.status).toBe("not-applicable");
    expect(fencesOnMarkdown.status).toBeUndefined();
  });

  it("wants Vary: Accept once a site does serve two representations", () => {
    const withoutVary = judgeNavigability(SITE, probes({ markdown: asMarkdown() }));
    const withVary = judgeNavigability(SITE, probes({
      markdown: ok({
        headers: new Headers({ "content-type": "text/markdown", vary: "Accept, Accept-Encoding" }),
        body: "# Title",
      }),
    }));

    expect(check(withoutVary, /vary/i).passed).toBe(false);
    expect(check(withVary, /vary/i).passed).toBe(true);
  });

  it("does not ask an HTML-only site for Vary: Accept", () => {
    // A site with one representation has nothing to vary on, so a zero here
    // would be a finding about a decision it never made.
    expect(check(judgeNavigability(SITE, probes()), /vary/i).status).toBe("not-applicable");
  });
});

describe("redirect hygiene", () => {
  it("passes a URL that lands where it was asked", () => {
    expect(check(judgeNavigability(SITE, probes()), /redirect/i).passed).toBe(true);
  });

  it("is about the mechanism, not the hop count", () => {
    // Two same-host 301s are fine: an agent that does not run scripts follows
    // them. The check's name is the claim — "Redirects happen in HTTP, not in
    // JavaScript".
    const result = judgeNavigability(SITE, probes({
      landing: landed(ok({ url: "https://example.com/c" }), {
        requested: SITE,
        finalUrl: "https://example.com/c",
        hops: [
          { url: SITE, status: 301, location: "https://example.com/b" },
          { url: "https://example.com/b", status: 301, location: "https://example.com/c" },
        ],
      }),
    }));

    expect(check(result, /Redirects happen in HTTP/).passed).toBe(true);
  });

  it("fails a meta refresh, which a non-rendering agent will not act on", () => {
    const result = judgeNavigability(SITE, probes({
      landing: landed(ok({
        body: '<html><head><meta http-equiv="refresh" content="0;url=/en/"></head><body></body></html>',
      })),
    }));

    const verdict = check(result, /Redirects happen in HTTP/);
    expect(verdict.passed).toBe(false);
    expect(verdict.detail).toContain("meta");
  });

  it("fails a near-empty body whose script assigns to location", () => {
    const result = judgeNavigability(SITE, probes({
      landing: landed(ok({
        body: '<html><body><script>location.href = "/en/"</script></body></html>',
      })),
    }));

    // Our threshold rather than a fact, which is why the check's source says so:
    // "a body this short with a script that assigns to location is a redirect
    // stub".
    expect(check(result, /Redirects happen in HTTP/).passed).toBe(false);
  });
});
