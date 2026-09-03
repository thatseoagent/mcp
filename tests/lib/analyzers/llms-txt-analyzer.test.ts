import { describe, expect, it } from "vitest";
import { scoreLlmsTxt } from "@/lib/analyzers/llms-txt-analyzer";
import { parseLinks, type LinkAudit } from "@/lib/llms-txt-links";
import { tally } from "@/lib/analyzers/scored-checks";

/**
 * The five checks, on a string.
 *
 * There was no test like this. About 210 of the Tool's 453 lines were scored
 * analysis living in the handler, and the only coverage drove the whole Tool
 * through a monkeypatched `fetch` — so every one of these cases needed a fake
 * HTTP server to reach, and most were never reached at all.
 */

const FULL = `# Example Ltd

> The shortest description of what we do.

## Docs
- [Getting started](https://example.com/start): How to begin
- [Pricing](https://example.com/pricing): What it costs
- [API](https://example.com/api): The reference

## Optional
- [Privacy](https://example.com/privacy): Privacy policy
`;

function read(content: string, linkAudit: LinkAudit | null = null) {
  return scoreLlmsTxt({ content, links: parseLinks(content), linkAudit });
}

/** A probe result: `resolves` of `probed` reached real content. */
function audit(over: Partial<LinkAudit> = {}): LinkAudit {
  return {
    probed: 3,
    resolves: 3,
    broken: [],
    unreachable: [],
    shellCheckRan: true,
    ...over,
  } as LinkAudit;
}

describe("the five questions", () => {
  it("scores a complete file out of the full hundred", () => {
    const reading = read(FULL, audit());

    expect(reading.max).toBe(100);
    expect(reading.score).toBe(100);
    expect(reading.grade).toBe("Excellent");
    expect(reading.issues).toEqual([]);
  });

  it("wants a title and says how to write one", () => {
    const reading = read(FULL.replace("# Example Ltd", "Example Ltd"), audit());

    expect(reading.score).toBe(80);
    expect(reading.issues.join("\n")).toContain("# Site Name");
  });

  it("wants a description", () => {
    const reading = read(FULL.replace("> The shortest", "The shortest"), audit());

    expect(reading.score).toBe(80);
    expect(reading.issues.join("\n")).toContain("> Brief description");
  });

  it("wants an Optional section", () => {
    const reading = read(FULL.replace("## Optional", "## Legal"), audit());

    expect(reading.score).toBe(80);
    expect(reading.issues.join("\n")).toContain("## Optional");
  });

  it("gives partial credit for one or two links rather than nothing", () => {
    const two = `# T\n\n> D\n\n- [a](https://example.com/a): A\n- [b](https://example.com/b): B\n\n## Optional\n`;

    const reading = read(two, audit({ probed: 2, resolves: 2 }));

    // `earned`, not `passed`: `points` stays the ceiling, which is the single
    // most important line in `scored-checks.ts`.
    const linkCheck = reading.checks[2];
    expect(linkCheck).toMatchObject({ points: 20, earned: 8 });
    expect(reading.issues.join("\n")).toContain("recommend at least 3");
  });

  it("asks for absolute URLs, and says why", () => {
    const relative = FULL.replace("https://example.com/start", "/start");

    const reading = read(relative, audit());

    expect(reading.issues.join("\n")).toContain("relative URL");
    expect(reading.issues.join("\n")).toContain("absolute URLs");
  });
});

describe("a file that could not be fully measured", () => {
  it("takes the link check out of both sides when there was nothing to probe", () => {
    const noLinks = `# T\n\n> D\n\n## Optional\n`;

    const reading = read(noLinks, null);

    // Not a failure and not a pass: the links check above already reported that
    // there are none, and charging twice for one absence is a double count.
    expect(reading.checks[3]).toMatchObject({ status: "not-applicable" });
    expect(reading.max).toBe(80);
    expect(reading.totals.notApplicable).toBe(20);
  });

  it("takes it out and says so when no link could be reached", () => {
    const reading = read(
      FULL,
      audit({
        probed: 3,
        resolves: 0,
        unreachable: [
          { url: "https://example.com/start", reason: "HTTP 503" },
          { url: "https://example.com/pricing", reason: "timed out" },
          { url: "https://example.com/api", reason: "HTTP 503" },
        ],
      } as Partial<LinkAudit>),
    );

    expect(reading.checks[3]).toMatchObject({ status: "not-evaluated" });
    expect(reading.max).toBe(80);
    expect(reading.totals.notEvaluated).toBe(20);
    // The sentence promises the reader this is not their file's fault.
    expect(reading.notes.join("\n")).toContain("not a finding about the page");
  });

  it("blames robots.txt where robots.txt is the cause, not the network", () => {
    const reading = read(
      FULL,
      audit({
        probed: 3,
        resolves: 0,
        unreachable: [
          { url: "https://example.com/start", reason: "disallowed", blockedByRobots: true },
          { url: "https://example.com/pricing", reason: "disallowed", blockedByRobots: true },
          { url: "https://example.com/api", reason: "disallowed", blockedByRobots: true },
        ],
      } as Partial<LinkAudit>),
    );

    expect(reading.notes.join("\n")).toContain("allow those paths in robots.txt");
    expect(reading.notes.join("\n")).toContain("we do not fetch what you disallow");
  });

  it("grades against what could be asked, not against a fixed hundred", () => {
    // A file whose links we failed to reach is scored out of 80. Holding it to
    // the 100-point bands would cost it a grade for our network trouble.
    const reading = read(
      FULL,
      audit({
        probed: 3,
        resolves: 0,
        unreachable: [
          { url: "https://example.com/start", reason: "HTTP 503" },
          { url: "https://example.com/pricing", reason: "HTTP 503" },
          { url: "https://example.com/api", reason: "HTTP 503" },
        ],
      } as Partial<LinkAudit>),
    );

    expect(reading.score).toBe(80);
    expect(reading.max).toBe(80);
    expect(reading.percent).toBe(100);
    expect(reading.grade).toBe("Excellent");
  });

  it("keeps an unanswerable read out of the recommendations", () => {
    // `issues` drives the recommendations, and a `notScored(...)` string in it
    // printed "Fix: Not scored: … This is not a finding about the page" and
    // marked a correct file invalid because one link timed out.
    const reading = read(
      FULL,
      audit({
        probed: 3,
        resolves: 2,
        unreachable: [{ url: "https://example.com/api", reason: "timed out" }],
      } as Partial<LinkAudit>),
    );

    expect(reading.notes.join("\n")).toContain("could not be reached on this run");
    expect(reading.issues.join("\n")).not.toContain("Not scored");
  });

  it("says when the strongest half of the link check did not run", () => {
    // Without the homepage every 200 looks like real content, which is precisely
    // the check this replaced.
    const reading = read(FULL, audit({ shellCheckRan: false }));

    expect(reading.notes.join("\n")).toContain("app shell");
  });
});

describe("the arithmetic", () => {
  it("comes from one walk of the checks, so the total cannot drift from its parts", () => {
    const reading = read(FULL, audit({ probed: 3, resolves: 2 }));
    const walked = tally(reading.checks);

    expect(reading.score).toBe(walked.score);
    expect(reading.max).toBe(walked.max);
    expect(reading.totals).toEqual(walked);
  });

  it("accounts for every point the five checks declare", () => {
    for (const linkAudit of [null, audit(), audit({ probed: 1, resolves: 0, unreachable: [{ url: "u", reason: "r" }] } as Partial<LinkAudit>)]) {
      const reading = read(FULL, linkAudit);
      const declared = reading.checks.reduce((sum, check) => sum + check.points, 0);

      expect(declared).toBe(100);
      expect(reading.max + reading.totals.notApplicable + reading.totals.notEvaluated)
        .toBe(declared);
    }
  });

  it("scores an empty file zero rather than refusing to grade it", () => {
    // A 200 with an empty body reaches here. A 503 does not — the Tool stops
    // before this function, because there is nothing to score until the file is
    // read.
    const reading = read("", null);

    expect(reading.score).toBe(0);
    expect(reading.grade).toBe("Poor");
    expect(reading.percent).toBe(0);
  });
});
