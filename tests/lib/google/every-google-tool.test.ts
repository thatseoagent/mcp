import { describe, it, expect, afterEach, vi } from "vitest";
import { readdirSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import { fakeGoogleReader } from "@/lib/google/fake-reader";
import type { GoogleReader, Ga4Report } from "@/lib/google/reader";
import { UpstreamApiError } from "@/lib/upstream-api-error";
import { resetPersistence } from "@/lib/db/runtime";
import { defineTool } from "@/lib/define-tool";
import type { ToolResult } from "@/lib/tool-result";

/**
 * Two things every Google-backed Tool owes, asserted for all thirty-one.
 *
 * `ga4.test.ts`, `gsc-core.test.ts` and `gsc-analysis-tools.test.ts` are 77
 * cases over 2,100 lines of Tool code — roughly two and a half each, which buys
 * the happy path and little else. The two states left over are the two an
 * Operator actually meets:
 *
 *   1. **The property is readable and has no data for this window.** A new
 *      property, a small site, a window before launch. That is an answer, not a
 *      failure, and it must not be reported as one — nor as a header with an
 *      empty space under it, nor with a number nobody measured. `0/0` is `NaN`,
 *      an absent row is `undefined`, and both render happily into prose.
 *   2. **Google refuses.** ADR-0003: a Tool that cannot do its whole job says
 *      so, naming what to configure. The refusal must not be swallowed into a
 *      partial answer, and must not be replaced by "the failure was logged".
 *
 * Table-driven over the Tool modules rather than written out, because the point
 * is that it holds for *every* one: a Tool added tomorrow is covered the moment
 * its file lands, which is the property a hand-written list cannot have.
 */

/**
 * The Tool modules, read off the directory rather than listed.
 *
 * `readdirSync` and not `import.meta.glob`, for the reason
 * `tool-names-referenced.test.ts` walks the directory too: a Tool added
 * tomorrow is covered the moment its file lands, and the assertion below that
 * the list is not empty is what keeps that from silently becoming zero.
 */
const TOOL_DIRECTORY = path.join(process.cwd(), "src/tools");

type ToolModule = {
  metadata: { name: string };
  schema?: Record<string, z.ZodType>;
  handler: (args: never, google: GoogleReader) => Promise<ToolResult>;
};

/**
 * Every argument any Google Tool asks for, by the name it asks for it under.
 *
 * One bag rather than a per-Tool literal: each Tool's own schema picks what it
 * needs out of it and applies its own defaults, so this test exercises the
 * surface an MCP client sees. A Tool whose schema wants a key that is not here
 * fails loudly, which is the right failure — it means a new argument arrived
 * and nobody decided what a plausible value for it is.
 */
const ARGUMENTS: Record<string, unknown> = {
  force_refresh: undefined,
  siteUrl: "example.com",
  domain: "example.com",
  url: "https://example.com/page",
  urls: ["https://example.com/page"],
  page: "https://example.com/page",
  propertyId: "123456789",
  property: "123456789",
  feedpath: "https://example.com/sitemap.xml",
  brandTerms: ["example"],
  metrics: ["sessions"],
  dimensions: undefined,
  rowDimension: "pagePath",
  columnDimension: "deviceCategory",
  search: undefined,
  days: undefined,
  startDate: undefined,
  endDate: undefined,
  type: undefined,
  rowLimit: undefined,
  columnLimit: undefined,
  limit: undefined,
  offset: undefined,
  minImpressions: undefined,
  maxCtr: undefined,
};

const EMPTY_REPORT: Ga4Report = {
  dimensionHeaders: [],
  metricHeaders: [],
  rows: [],
  rowCount: 0,
};

/**
 * A reader whose properties are all readable and whose windows are all empty.
 *
 * Property Access is deliberately left intact: "there is nothing to list" is a
 * different state and the Tools already refuse it by name. What is emptied is
 * every method that answers with rows, which is the state this file is about.
 */
function emptyReader(): GoogleReader {
  return fakeGoogleReader({
    searchConsole: {
      searchAnalytics: async () => [],
      listSitemaps: async () => [],
    },
    analytics: {
      runReport: async () => EMPTY_REPORT,
      runPivotReport: async () => EMPTY_REPORT,
      runRealtimeReport: async () => EMPTY_REPORT,
      getMetadata: async () => ({ dimensions: [], metrics: [] }),
      checkCompatibility: async () => ({}),
    },
  });
}

/** A reader that refuses everything the way Google refuses an unauthorised property. */
function refusingReader(): GoogleReader {
  const refuse = async (): Promise<never> => {
    throw new UpstreamApiError("Google Search Console", 403);
  };
  return fakeGoogleReader({
    searchConsole: {
      listProperties: refuse,
      searchAnalytics: refuse,
      inspectUrl: refuse,
      listSitemaps: refuse,
      getSitemap: refuse,
    },
    analytics: {
      listProperties: refuse,
      runReport: refuse,
      runPivotReport: refuse,
      runRealtimeReport: refuse,
      getMetadata: refuse,
      checkCompatibility: refuse,
    },
  });
}

const textOf = (result: ToolResult): string => result.content.map((part) => part.text).join("\n");

/** Every Google-backed Tool, with its arguments parsed by its own schema. */
type Tool = { name: string; args: never; run: ToolModule["handler"]; declaresWindow: boolean };

async function googleTools(): Promise<Tool[]> {
  const tools: Tool[] = [];

  for (const file of readdirSync(TOOL_DIRECTORY).filter((name) => name.endsWith(".ts"))) {
    const module = (await import(`../../../src/tools/${file}`)) as ToolModule;
    if (!/^(gsc|ga4)_/.test(module.metadata.name)) continue;

    const schema = z.object(module.schema ?? {});
    const parsed = schema.safeParse(ARGUMENTS);
    if (!parsed.success) {
      throw new Error(
        `${module.metadata.name}: no plausible value in ARGUMENTS for ${parsed.error.issues
          .map((issue) => issue.path.join("."))
          .join(", ")}`,
      );
    }
    tools.push({
      name: module.metadata.name,
      args: parsed.data as never,
      run: module.handler,
      declaresWindow: "startDate" in (module.schema ?? {}) && "endDate" in (module.schema ?? {}),
    });
  }

  return tools.sort((a, b) => a.name.localeCompare(b.name));
}

afterEach(() => {
  resetPersistence();
  vi.restoreAllMocks();
});

describe("a readable property with no data for the window", () => {
  it("covers every Google Tool", async () => {
    // The guard on the guard: a glob that matched nothing would make every case
    // below pass by iterating an empty list.
    expect((await googleTools()).length).toBeGreaterThanOrEqual(30);
  });

  it("is an answer rather than a failure", async () => {
    for (const tool of await googleTools()) {
      const result = await tool.run(tool.args, emptyReader());

      expect(result.isError, `${tool.name} reported an empty window as a failure`).toBeUndefined();
      expect(textOf(result).trim().length, tool.name).toBeGreaterThan(20);
    }
  });

  it("never prints a number nobody measured", async () => {
    // `0/0` is `NaN`, an absent row is `undefined`, and a percentage of nothing
    // is `Infinity`. All three render into a sentence without complaint, and a
    // reader has no way to tell one from a real figure.
    for (const tool of await googleTools()) {
      const text = textOf(await tool.run(tool.args, emptyReader()));

      expect(text, tool.name).not.toMatch(/\bNaN\b/);
      expect(text, tool.name).not.toMatch(/\bundefined\b/);
      expect(text, tool.name).not.toMatch(/\bInfinity\b/);
      expect(text, tool.name).not.toMatch(/\[object Object\]/);
    }
  });
});

describe("Google refuses", () => {
  it("is never turned into a partial answer", async () => {
    for (const tool of await googleTools()) {
      // The refusal has to reach the seam, which is the only place that words
      // it: `defineGoogleTool` wraps the handler and hands it a reader, so a
      // `handler` that caught an `UpstreamApiError` and rendered a report
      // without the data would be ADR-0003's exact failure — a partial result
      // presented as a whole one. Thirty-one Tools, none of them swallowing it.
      await expect(
        tool.run(tool.args, refusingReader()),
        `${tool.name} swallowed a 403`,
      ).rejects.toBeInstanceOf(UpstreamApiError);
    }
  });

  it("reaches the Operator as our sentence, naming the service and the status", async () => {
    // Asserted at the seam rather than per Tool because that is where it lives.
    // `defineGoogleTool` builds a live reader itself, so the composition a
    // client calls cannot be handed a fake — which is why every test in this
    // repo calls `handler` directly, and why the wording of a refusal was
    // pinned nowhere until this case.
    const refusal = new UpstreamApiError("Google Search Console", 403);
    const tool = defineTool("read Search Console performance for this site", async () => {
      throw refusal;
    });

    const result = await tool({});

    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("Google Search Console returned HTTP 403");
    // The status is the fact and a fixed sentence per status is what makes the
    // class safe to publish: no remote body, and not "the failure was logged".
    expect(textOf(result)).not.toContain("has been logged");
  });
});

describe("a window a reader can trust", () => {
  /** The Tools whose schema declares a window, which is where the promise lives. */
  const windowed = async (prefix: "gsc" | "ga4") =>
    (await googleTools()).filter(
      (tool) => tool.name.startsWith(`${prefix}_`) && tool.declaresWindow,
    );

  it("names the window every Search Console reading came from", async () => {
    const tools = await windowed("gsc");
    expect(tools.length).toBeGreaterThan(5);

    for (const tool of tools) {
      const text = textOf(await tool.run(tool.args, fakeGoogleReader()));

      // A table of queries with no window is a table a reader cannot compare
      // against anything, including the same Tool's answer yesterday.
      expect(text, tool.name).toMatch(/^Window: \d{4}-\d{2}-\d{2} to \d{4}-\d{2}-\d{2}$/m);
      expect(text, tool.name).toMatch(/^Property: /m);
    }
  });

  it("cannot forget that a defaulted GA4 window ends on a partial day", async () => {
    const tools = await windowed("ga4");
    expect(tools.length).toBeGreaterThan(1);

    for (const tool of tools) {
      const text = textOf(await tool.run(tool.args, fakeGoogleReader()));

      // Four of the five windowed Tools printed a window ending yesterday
      // without this, so a reader could not tell a quiet day from a day Google
      // has not finished processing. It travels in the header for that reason,
      // and this is the case that says so for all of them at once.
      expect(text, tool.name).toContain("The window ends yesterday");
    }
  });
});
