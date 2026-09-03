/**
 * Whether an agent can operate the page, not just read it.
 *
 * Google's AI-optimization guide is the reason this check exists and the reason
 * it is worded the way it is:
 *
 * > "Agents may interact with your site by analyzing visual rendering, inspecting
 * > the DOM, and interpreting the accessibility tree."
 * > https://developers.google.com/search/docs/fundamentals/ai-optimization-guide
 *
 * That sentence is the only Google-sourced statement in the whole guide about
 * what to build for the AI era, and it names something checkable. The rest of the
 * product's AI-era surface is our citability model: defensible, but ours. This is
 * not. The accessibility tree is built from the DOM by documented rules, so a
 * control with no accessible name is missing one for an agent exactly as it is for
 * a screen reader.
 *
 * The product had one accessibility check before this — heading structure — while
 * shipping two AI-visibility scores built on inference. That imbalance is what
 * this closes.
 */
import { describe, it, expect } from "vitest";
import { load } from "cheerio";

import { auditAgentOperability } from "@/lib/analyzers/agent-operability";

/**
 * Audits `body` inside a `<main>`, so a case about a button is only about that
 * button. Without the wrapper every fixture also trips the landmark rule, and
 * thirteen unrelated cases start asserting on two findings each.
 */
const audit = (body: string) =>
  auditAgentOperability(load(`<html><body><main>${body}</main></body></html>`));

/** No wrapper, for the landmark rule itself. */
const auditBare = (body: string) =>
  auditAgentOperability(load(`<html><body>${body}</body></html>`));

describe("controls an agent cannot name", () => {
  it("finds a button whose only content is an icon", () => {
    const { findings } = audit('<button><svg viewBox="0 0 1 1"></svg></button>');

    expect(findings).toHaveLength(1);
    expect(findings[0].reason).toMatch(/no accessible name/i);
  });

  it("accepts aria-label as the name", () => {
    expect(audit('<button aria-label="Close"><svg></svg></button>').findings).toEqual([]);
  });

  it("accepts visible text as the name", () => {
    expect(audit("<button>Add to cart</button>").findings).toEqual([]);
  });

  it("accepts an image's alt text as the name", () => {
    expect(audit('<button><img src="x.png" alt="Search"></button>').findings).toEqual([]);
  });

  it("accepts aria-labelledby, without resolving the reference", () => {
    // Resolving the id would need the whole document and buys little: an author
    // who wrote aria-labelledby has thought about the name.
    expect(audit('<button aria-labelledby="h"><svg></svg></button>').findings).toEqual([]);
  });

  it("finds a link whose only content is an icon", () => {
    const { findings } = audit('<a href="/cart"><svg></svg></a>');
    expect(findings[0].reason).toMatch(/no accessible name/i);
  });

  it("does not report a link that is genuinely decorative and hidden", () => {
    // aria-hidden says "not part of the accessibility tree". Reporting it would
    // be arguing with an explicit, correct declaration.
    expect(audit('<a href="/x" aria-hidden="true"><svg></svg></a>').findings).toEqual([]);
  });
});

describe("form fields an agent cannot fill", () => {
  it("finds an input with no label of any kind", () => {
    const { findings } = audit('<form><input type="email" name="email"></form>');

    expect(findings).toHaveLength(1);
    expect(findings[0].reason).toMatch(/no label/i);
  });

  it("accepts a label bound by for/id", () => {
    expect(
      audit('<form><label for="e">Email</label><input id="e" type="email"></form>').findings
    ).toEqual([]);
  });

  it("accepts a wrapping label", () => {
    expect(audit("<form><label>Email <input type=\"email\"></label></form>").findings).toEqual([]);
  });

  it("accepts aria-label", () => {
    expect(audit('<form><input type="email" aria-label="Email"></form>').findings).toEqual([]);
  });

  it("survives an id containing selector syntax", () => {
    // Legal, unusual, and it made the analyzer throw when the id was interpolated
    // straight into a `label[for="…"]` selector.
    expect(() => audit('<form><input id=\'a"]b\' type="email"></form>')).not.toThrow();
  });

  it("does not accept a placeholder as a label", () => {
    // A placeholder disappears on focus and is not an accessible name. It is the
    // single most common substitute, which is why it is called out rather than
    // quietly passed.
    const { findings } = audit('<form><input type="email" placeholder="Email"></form>');

    expect(findings).toHaveLength(1);
    expect(findings[0].reason).toMatch(/placeholder is not a label/i);
  });

  it("ignores hidden and submit inputs, which need no label", () => {
    expect(
      audit('<form><input type="hidden" name="csrf"><input type="submit" value="Go"></form>').findings
    ).toEqual([]);
  });
});

describe("landmarks", () => {
  it("reports a page with no main landmark", () => {
    const { findings } = auditBare("<div><p>Everything lives in divs.</p></div>");

    expect(findings.some((f) => /main landmark/i.test(f.reason))).toBe(true);
  });

  it("accepts <main>", () => {
    expect(auditBare("<main><p>Content.</p></main>").findings).toEqual([]);
  });

  it("accepts role=main", () => {
    expect(auditBare('<div role="main"><p>Content.</p></div>').findings).toEqual([]);
  });
});

describe("the criterion each finding cites", () => {
  it("cites Name, Role, Value for an unnamed control", () => {
    expect(audit("<button><svg></svg></button>").findings[0].standard).toContain("4.1.2");
  });

  it("cites Info and Relationships for a missing landmark, not 4.1.2", () => {
    // A landmark is structure, not naming. The first version hard-coded 4.1.2 for
    // both, which cited the wrong criterion for one of the two things it reports.
    const finding = auditBare("<div><p>x</p></div>").findings[0];
    expect(finding.standard).toContain("1.3.1");
    expect(finding.standard).not.toContain("4.1.2");
  });
});

describe("what the audit returns", () => {
  it("caps the findings it lists but reports the true total", () => {
    const many = Array.from({ length: 30 }, () => "<button><svg></svg></button>").join("");
    const { findings, total } = audit(many);

    // A page with a broken component template has the same defect 30 times. The
    // list is for reading; the count is what says how much work it is.
    expect(total).toBe(30);
    expect(findings.length).toBeLessThan(30);
  });

  it("says nothing about a page that is already operable", () => {
    const { findings, total } = auditBare(
      '<main><h1>Shop</h1><form><label for="q">Search</label><input id="q"></form>' +
        '<a href="/cart">Cart</a><button>Buy</button></main>'
    );

    expect(total).toBe(0);
    expect(findings).toEqual([]);
  });
});
