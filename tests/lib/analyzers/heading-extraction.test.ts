/**
 * The page analyzers that reported issue #290: a `<br>` inside a heading fused
 * the words on either side of it ("directoen"), so an audit flagged a content
 * defect that did not exist on the page. `visibleTexts` is unit-tested in
 * tests/lib/utils/visible-text.test.ts; these pin the wiring at each call site.
 */
import { describe, it, expect, afterEach } from "vitest";

import { analyzeOnPageSeo } from "@/lib/analyzers/onpage-seo";
import { analyzeContent } from "@/lib/analyzers/content-analyzer";
import { serveHtml, restoreFetch } from "../../helpers/serve-html";

// `fetchHtml` keeps a 60s module-level cache keyed by URL, so each test serves
// its fixture from its own URL and cannot read the previous one's body.
const url = (name: string) => `https://thatseoagent.com/es/mcp-${name}`;

/** The real markup of app/[locale]/(landing)/mcp/page.tsx, reduced to the H1. */
const HERO = `<!DOCTYPE html>
<html lang="es">
  <head><title>Análisis SEO en tu agente de IA</title></head>
  <body>
    <h1>Análisis SEO, directo<br /><span>en tu agente de IA.</span></h1>
    <h2>Qué hace<br />el servidor MCP</h2>
    <p>${Array.from({ length: 120 }, () => "contenido").join(" ")}</p>
  </body>
</html>`;

afterEach(restoreFetch);

describe("analyzeOnPageSeo headings", () => {
  it("reports a <br> heading as separate words", async () => {
    const target = url("onpage");
    serveHtml({ [target]: HERO });

    const result = await analyzeOnPageSeo(target);

    expect(result.headings.h1).toEqual(["Análisis SEO, directo en tu agente de IA."]);
    expect(result.headings.h2).toEqual(["Qué hace el servidor MCP"]);
  });
});

describe("analyzeContent heading outline", () => {
  it("builds the outline from unfused heading text", async () => {
    const target = url("content");
    serveHtml({ [target]: HERO });

    const result = await analyzeContent(target);
    expect(result.success).toBe(true);
    if (!result.success) return;

    const outline = result.data.headingStructure.outline;
    expect(outline[0]?.text).toBe("Análisis SEO, directo en tu agente de IA.");
    expect(outline[0]?.children[0]?.text).toBe("Qué hace el servidor MCP");
    expect(result.data.headingStructure.counts).toMatchObject({ h1: 1, h2: 1 });
  });
});
