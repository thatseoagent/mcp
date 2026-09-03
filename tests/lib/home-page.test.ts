import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
// @ts-expect-error — plain ESM, deliberately not TypeScript: it runs from
// `scripts/build.mjs` before anything is compiled. See its module header.
import { buildHomePage, surfaceCounts } from "../../scripts/build-home-page.mjs";
import { MCP_URL } from "@/lib/server-address";

/**
 * The page served at `/`, checked against the build it describes.
 *
 * It is generated and committed, like `drizzle/`, because `xmcp.config.ts` can
 * only name a path — it is compiled in a sandbox with no `node:fs`. A committed
 * copy that has gone stale is the failure this file exists for: the page would
 * still render, still look right, and quietly report a Tool count from whenever
 * somebody last ran the generator.
 */

const committed = readFileSync(path.resolve(process.cwd(), "public/home.html"), "utf8");
const counts = surfaceCounts() as { tools: number; prompts: number; resources: number };

describe("the committed home page", () => {
  it("is what the generator produces right now", () => {
    // If this fails, run `node scripts/build-home-page.mjs` — or just
    // `pnpm build`, which does it first.
    expect(committed).toBe(buildHomePage());
  });

  it("counts the surface this build actually ships", () => {
    expect(counts.tools).toBeGreaterThan(40);
    expect(committed).toContain(`<span class="stat">${counts.tools}</span>`);
    expect(committed).toContain(`<span class="stat">${counts.prompts}</span>`);
    expect(committed).toContain(`<span class="stat">${counts.resources}</span>`);
  });

  it("names the address the server actually listens on", () => {
    // Both read `server-address.json`, so a port change moves the page with the
    // build rather than leaving a URL nothing answers on.
    expect(committed).toContain(MCP_URL);
  });
});

describe("the design system it carries", () => {
  it("uses the warm-paper ground and the AA-verified ink tiers", () => {
    for (const token of ["#F8F5F1", "#1C1815", "#2E2822", "#5F564E", "#736A5F", "#E7E0D8"]) {
      expect(committed, token).toContain(token);
    }
  });

  it("keeps one lamp", () => {
    // Deep Ōtan is the only saturated colour used as ink or fill. The vivid
    // `#FF4E20` appears in the mark, where it is not text — anything else
    // saturated would mean two things are red and neither reads as urgent.
    const saturated = [...committed.matchAll(/#[0-9A-Fa-f]{6}/g)].map((match) => match[0].toUpperCase());
    const allowed = new Set([
      "#C4331A", // the lamp
      "#FF4E20", // the mark
      "#F8F5F1",
      "#FFFFFF",
      "#F1ECE3",
      "#E7E0D8",
      "#D6CCC0",
      "#1C1815",
      "#2E2822",
      "#5F564E",
      "#736A5F",
    ]);

    for (const colour of new Set(saturated)) {
      expect(allowed, `${colour} is not in the palette`).toContain(colour);
    }
  });

  it("takes its depth from rules rather than shadow", () => {
    expect(committed).not.toContain("box-shadow");
    expect(committed).not.toContain("filter: blur");
  });

  it("keeps corners square, which is the paper register's signature", () => {
    // The 2px radius belongs to the report register and nowhere else. `rx` on
    // the SVG mark is the robot's own geometry, not a CSS corner.
    expect(committed).not.toMatch(/border-radius/);
  });

  it("never removes a focus ring without replacing it", () => {
    expect(committed).toContain("a:focus-visible");
    expect(committed).toContain("outline: 2px solid var(--lamp)");
  });

  it("fetches nothing, because a loopback page should not phone out", () => {
    // xmcp serves no static files, so the mark is inlined and the favicon is a
    // data URI. The brand faces are named and left to fall back.
    expect(committed).not.toContain("fonts.googleapis.com");
    expect(committed).not.toContain("<link rel=\"stylesheet\"");
    expect(committed).toContain('font-family: var(--mono)');
    expect(committed).toContain("Space Grotesk");
  });

  it("carries the mark inline, at the geometry it was published with", () => {
    expect(committed).toContain('viewBox="0 0 56 56"');
    expect(committed).toContain('aria-label="That SEO Agent"');
    // The flush edge: the square bleeds to its own bounds, which is what makes
    // it legible at favicon size.
    expect(committed).toContain('<rect width="56" height="56" fill="#FF4E20"/>');
  });
});

describe("what the page claims", () => {
  it("states the honesty rules the Tools actually follow", () => {
    for (const claim of [
      "never reported as a check that passed",
      "absence in the rows read",
      "named as ours",
      "directional readings",
    ]) {
      expect(committed, claim).toContain(claim);
    }
  });

  it("tells a visitor which half of the surface needs nothing configured", () => {
    expect(committed).toContain("No credentials at all");
    expect(committed).toContain("crawl_site");
    expect(committed).toContain("run_site_audit");
  });
});
