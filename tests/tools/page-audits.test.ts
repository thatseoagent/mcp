import { describe, it, expect, afterEach, vi } from "vitest";
import { handler as runPageAudit } from "@/tools/run-page-audit";
import { handler as getPageAudits } from "@/tools/get-page-audits";
import { findSite, listSites } from "@/lib/sites";
import { findPageAudit, listPageAudits, normaliseAuditUrl } from "@/lib/page-audits";
import { resetPersistence } from "@/lib/db/runtime";
import { DB_PATH_VARIABLE } from "@/lib/db/database";
import { InvalidInputError } from "@/lib/invalid-input-error";
import { useTempDatabase } from "../helpers/temp-database";
import { serve } from "../helpers/serve";

const originalFetch = globalThis.fetch;
let temp: ReturnType<typeof useTempDatabase> | null = null;

/** A page the audit can read, whose title the test can vary. */
function servePage(title: string, description = "A page"): void {
  serve({
    "example.com/robots.txt": { status: 404, body: "" },
    "https://example.com/pricing": {
      headers: { "content-type": "text/html" },
      body:
        `<html><head><title>${title}</title>` +
        `<meta name="description" content="${description}">` +
        `<link rel="canonical" href="https://example.com/pricing"></head>` +
        `<body><h1>Pricing</h1><p>Some words about the price of things.</p>` +
        `<a href="/about">About</a></body></html>`,
    },
  });
}

afterEach(() => {
  globalThis.fetch = originalFetch;
  temp?.dispose();
  temp = null;
  delete process.env[DB_PATH_VARIABLE];
  resetPersistence();
  vi.restoreAllMocks();
});

const textOf = (result: { content: Array<{ text: string }> }): string =>
  result.content.map((part) => part.text).join("\n");

const audit = (url = "https://example.com/pricing") =>
  runPageAudit({ force_refresh: undefined, url });

const read = (args: Partial<{ domain: string; url: string }> = {}) =>
  getPageAudits({ force_refresh: undefined, domain: "example.com", url: undefined, ...args });

describe("normalising an audited URL", () => {
  it("drops the fragment, which never reaches the server", () => {
    expect(normaliseAuditUrl("https://example.com/a#section")).toBe("https://example.com/a");
  });

  it("keeps the query string, which can be the whole difference between two pages", () => {
    expect(normaliseAuditUrl("https://example.com/a?v=2")).toBe("https://example.com/a?v=2");
  });

  it("refuses something that is not an http URL", () => {
    expect(() => normaliseAuditUrl("ftp://example.com/a")).toThrow(InvalidInputError);
  });
});

describe("run_page_audit", () => {
  it("analyses the page and stores the result against its Site", async () => {
    temp = useTempDatabase();
    servePage("Pricing — Example");

    const text = textOf(await audit());

    expect(listSites().map((site) => site.domain)).toEqual(["example.com"]);
    const site = findSite("example.com")!;
    expect(findPageAudit(site.id, "https://example.com/pricing")).not.toBeNull();
    expect(text).toContain("Title: Pricing — Example");
  });

  it("says there is nothing to compare against on the first run", async () => {
    temp = useTempDatabase();
    servePage("Pricing");

    const text = textOf(await audit());

    expect(text).toContain("first audit stored for this page");
  });

  it("reports what moved on the second run", async () => {
    // The reason this Tool exists rather than `seo_analyze_page`: the question an
    // Operator has after doing the work is whether it helped.
    temp = useTempDatabase();
    servePage("Pricing");
    await audit();

    servePage("Pricing — Plans and costs");
    // What a minute passing does, or what `force_refresh` does through the Tool:
    // the HTTP layer holds a page's markup for sixty seconds, so two audits in
    // quick succession genuinely read the same bytes. Dropping it here is the
    // test standing in for time.
    const { resetHttpCaches } = await import("@/lib/http-client");
    resetHttpCaches();

    const text = textOf(await audit());

    expect(text).toContain('Title: was "Pricing", now "Pricing — Plans and costs"');
  });

  it("says nothing changed when nothing did", async () => {
    temp = useTempDatabase();
    servePage("Pricing");
    await audit();

    const text = textOf(await audit());

    expect(text).toContain("Nothing measured here changed since then");
  });

  it("replaces the row rather than accumulating one per run", async () => {
    temp = useTempDatabase();
    servePage("Pricing");

    await audit();
    await audit();
    const site = findSite("example.com")!;

    expect(listPageAudits(site.id)).toHaveLength(1);
  });

  it("keeps the date this page was first audited across replacements", async () => {
    // The one date that says how far back the record goes.
    temp = useTempDatabase();
    servePage("Pricing");
    await audit();
    const site = findSite("example.com")!;
    const first = findPageAudit(site.id, "https://example.com/pricing")!.createdAt;

    await audit();

    expect(findPageAudit(site.id, "https://example.com/pricing")!.createdAt).toEqual(first);
  });

  it("stores nothing when the page could not be read", async () => {
    // A row saying "we failed once" would be compared against by the next run as
    // though it described the page.
    temp = useTempDatabase();
    serve({
      "example.com/robots.txt": { status: 404, body: "" },
      "https://example.com/pricing": { status: 500, body: "" },
    });

    // The handler throws; `defineCachedTool` is what turns that into a Tool
    // result. What matters here is that nothing reached the table.
    await expect(audit()).rejects.toThrow(/HTTP 500/);

    const site = findSite("example.com")!;
    expect(listPageAudits(site.id)).toHaveLength(0);
  });

  it("refuses when there is no database, since storing is the point", async () => {
    process.env[DB_PATH_VARIABLE] = "off";
    resetPersistence();
    servePage("Pricing");

    await expect(audit()).rejects.toThrow(/needs the server's database/);
  });
});

describe("get_page_audits", () => {
  it("lists what has been audited, with both dates", async () => {
    temp = useTempDatabase();
    servePage("Pricing");
    await audit();

    const text = textOf(await read());

    expect(text).toContain("Pages audited: 1");
    expect(text).toContain("https://example.com/pricing — last ");
    expect(text).toContain("first ");
  });

  it("reads one page's stored audit back in full", async () => {
    temp = useTempDatabase();
    servePage("Pricing — Example");
    await audit();

    const text = textOf(await read({ url: "https://example.com/pricing" }));

    expect(text).toContain("Title: Pricing — Example");
    expect(text).toContain("not a fresh read of the page");
  });

  it("says what is stored when the URL asked for is not", async () => {
    // A URL differing only by its query string is a different page here, which is
    // the likeliest reason for a miss.
    temp = useTempDatabase();
    servePage("Pricing");
    await audit();

    const text = textOf(await read({ url: "https://example.com/pricing?v=2" }));

    expect(text).toContain("No audit is stored for");
    expect(text).toContain("differing only by its");
    expect(text).toContain("https://example.com/pricing");
  });

  it("tells an Operator with no audits how to store one", async () => {
    temp = useTempDatabase();
    servePage("Pricing");
    await audit("https://example.com/pricing");
    // A Site with an audit, then a different Site with none.
    const { registerSite } = await import("@/lib/sites");
    registerSite("other.example");

    const text = textOf(await read({ domain: "other.example" }));

    expect(text).toContain("No page audits stored for this Site yet");
    expect(text).toContain("before and after a");
  });

  it("keeps 'not registered' apart from 'no audits'", async () => {
    temp = useTempDatabase();

    await expect(read({ domain: "never-seen.example" })).rejects.toThrow(
      /is not a registered Site/,
    );
  });

  it("refuses when there is no database", async () => {
    process.env[DB_PATH_VARIABLE] = "off";
    resetPersistence();

    await expect(read()).rejects.toThrow(/needs the server's database/);
  });
});
