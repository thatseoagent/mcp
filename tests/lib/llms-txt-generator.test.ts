import { describe, it, expect } from "vitest";
import { buildGeneratedTemplate } from "@/lib/llms-txt-generator";
import type { PageMeta } from "@/lib/page-meta";

/**
 * The generated `llms.txt`, on plain data.
 *
 * The module states two rules and both are corrections to what it used to do:
 * **nothing here is invented**, and **it never declares a URL nobody has seen**.
 * Neither was asserted anywhere — the Tool's own test generates a file and checks
 * that some lines are in it, which passes just as well when a line is filler.
 */

const ORIGIN = "https://example.com";

const page = (url: string, over: Partial<PageMeta> = {}): PageMeta => ({ url, ...over });

const build = (pages: PageMeta[], origin = ORIGIN) =>
  buildGeneratedTemplate(origin, "Example Ltd", "What Example does.", pages);

describe("rule 1 — nothing here is invented", () => {
  it("uses the page's own title and description", () => {
    const file = build([
      page("https://example.com/pricing", { title: "Pricing", description: "What it costs." }),
    ]);

    expect(file).toContain("- [Pricing](https://example.com/pricing): What it costs.");
  });

  it("omits the description a page does not publish, rather than filling it", () => {
    const file = build([page("https://example.com/pricing", { title: "Pricing" })]);

    // It used to write `- [Pricing](url): Pricing page` — filler standing exactly
    // where the spec asks for a description. An omission is also a finding the
    // reader can act on.
    expect(file).toContain("- [Pricing](https://example.com/pricing)");
    expect(file).not.toContain("Pricing page");
    expect(file).not.toMatch(/pricing\): Pricing/);
  });

  it("falls back to the raw slug, and does not title-case it", () => {
    const file = build([page("https://example.com/ueber-uns")]);

    // A slug is not a title. Opened up and percent-decoded, and nobody's
    // capitalisation changed: an honest raw slug beats a confident wrong title.
    expect(file).toContain("- [ueber uns](https://example.com/ueber-uns)");
    expect(file).not.toContain("Ueber Uns");
  });

  it("decodes a percent-encoded slug instead of printing the escapes", () => {
    const file = build([page("https://example.com/%E5%85%B3%E4%BA%8E")]);

    expect(file).toContain("[关于]");
  });

  it("takes the site's own heading and blurb", () => {
    const file = build([]);

    expect(file.startsWith("# Example Ltd\n> What Example does.")).toBe(true);
  });

  it("falls back to the hostname when the site published no title", () => {
    const file = buildGeneratedTemplate(ORIGIN, "  ", "", []);

    expect(file).toContain("# example.com");
    expect(file).toContain("> Content and resources from example.com");
  });
});

describe("rule 2 — it never declares a URL nobody has seen", () => {
  it("writes no Optional section when the site has no legal pages", () => {
    const file = build([page("https://example.com/pricing", { title: "Pricing" })]);

    // `/privacy` and `/terms` were hardcoded on every site, so `--generate`
    // handed the user a file that `seo_llms_txt` would then fail them for:
    // our own audit reports a declared link that 404s as broken.
    expect(file).not.toContain("## Optional");
    expect(file).not.toContain("/privacy");
    expect(file).not.toContain("/terms");
  });

  it("writes one when the site does have them", () => {
    const file = build([
      page("https://example.com/privacy", { title: "Privacy" }),
      page("https://example.com/es/aviso-legal", { title: "Aviso legal" }),
    ]);

    expect(file).toContain("## Optional");
    expect(file).toContain("[Privacy](https://example.com/privacy)");
    expect(file).toContain("[Aviso legal](https://example.com/es/aviso-legal)");
  });

  it("declares only URLs on the site it was asked about", () => {
    const file = build([
      page("https://elsewhere.test/blog/a", { title: "Someone else's post" }),
      page("not a url", { title: "Nonsense" }),
    ]);

    expect(file).not.toContain("elsewhere.test");
    expect(file).not.toContain("Nonsense");
  });
});

describe("the shape of the file", () => {
  it("always leads with the homepage under Key Content", () => {
    const file = build([page("https://example.com/pricing", { title: "Pricing" })]);
    const lines = file.split("\n");
    const keyContent = lines.indexOf("## Key Content");

    expect(keyContent).toBeGreaterThan(-1);
    expect(lines[keyContent + 2]).toBe("- [Example Ltd](https://example.com/): What Example does.");
  });

  it("sorts pages into the sections their paths name", () => {
    const file = build([
      page("https://example.com/blog/one", { title: "One" }),
      page("https://example.com/docs/two", { title: "Two" }),
      page("https://example.com/pricing", { title: "Pricing" }),
    ]);

    expect(file.indexOf("## Blog")).toBeLessThan(file.indexOf("## Documentation"));
    expect(file).toContain("[One](https://example.com/blog/one)");
    expect(file).toContain("[Two](https://example.com/docs/two)");
    // Anything uncategorised keeps the homepage company.
    expect(file.indexOf("[Pricing]")).toBeLessThan(file.indexOf("## Blog"));
  });

  it("lists the homepage once, however the sitemap spelled it", () => {
    const file = build([
      page("https://example.com/", { title: "Root" }),
      page("https://example.com/pricing", { title: "Pricing" }),
      page("https://example.com/pricing", { title: "Pricing again" }),
    ]);

    expect(file.match(/https:\/\/example\.com\/\)/g) ?? []).toHaveLength(1);
    expect(file).not.toContain("Pricing again");
  });

  it("does not lose every page when the origin arrives with a trailing slash", () => {
    // The filter compared `parsed.origin`, which never carries one, against the
    // argument as given — so this generated a file containing only the homepage.
    const file = build([page("https://example.com/pricing", { title: "Pricing" })], "https://example.com/");

    expect(file).toContain("[Pricing](https://example.com/pricing)");
  });

  it("keeps each section to four entries", () => {
    const file = build(
      Array.from({ length: 9 }, (_, i) => page(`https://example.com/blog/${i}`, { title: `Post ${i}` })),
    );

    expect(file).toContain("[Post 3]");
    expect(file).not.toContain("[Post 4]");
  });
});
