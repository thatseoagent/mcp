import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { SERVER_INSTRUCTIONS } from "@/lib/server-instructions";

/**
 * Every Tool name a prompt, a playbook or the handshake mentions has to exist.
 *
 * This is the one thing that goes wrong silently. A Tool gets renamed, the
 * playbooks keep the old name, and an agent following one confidently calls
 * something that is not there — reporting the failure to the Operator as though
 * the site were the problem. Nothing else in the suite would catch it: the
 * prompts are strings, and a string cannot fail to compile.
 *
 * The reverse is deliberately *not* asserted. A Tool nobody wrote a playbook for
 * is fine; a playbook naming a Tool nobody wrote is not.
 */

const root = process.cwd();

/** The Tool names the server actually registers, read from the Tool modules. */
function registeredToolNames(): Set<string> {
  const dir = path.join(root, "src/tools");
  const names = new Set<string>();

  for (const file of readdirSync(dir).filter((name) => name.endsWith(".ts"))) {
    const source = readFileSync(path.join(dir, file), "utf8");
    const match = source.match(/name:\s*"([a-z0-9_]+)"/);
    if (match) names.add(match[1]);
  }

  return names;
}

/**
 * Anything in the text that looks like one of this server's Tool names.
 *
 * Matched on the shape rather than against the registry, which is the whole
 * point: a name that no longer exists still looks like a Tool name, and that is
 * exactly what has to be caught.
 */
function mentionedToolNames(text: string): string[] {
  const candidates = text.match(/\b(?:seo|gsc|ga4|run|crawl|get|sync|ai|entity|pagespeed)_[a-z0-9_]+/g) ?? [];
  return [...new Set(candidates)];
}

/** Every prompt and resource module's rendered text. */
function playbookSources(): Array<{ file: string; text: string }> {
  const sources: Array<{ file: string; text: string }> = [];

  // `src/resources` is nested: xmcp reads the URI scheme from a `(scheme)`
  // directory, so a playbook lives at `(seo)/playbooks/name.ts`. Walking rather
  // than listing keeps this working when another scheme is added.
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith(".ts")) {
        sources.push({ file: path.relative(root, full), text: readFileSync(full, "utf8") });
      }
    }
  };

  for (const dir of ["src/prompts", "src/resources"]) walk(path.join(root, dir));

  return sources;
}

describe("Tool names referenced outside the Tools", () => {
  const registered = registeredToolNames();

  it("finds the Tools it is checking against", () => {
    // A guard on the guard: if the registry came back empty, every assertion
    // below would pass while checking nothing.
    expect(registered.size).toBeGreaterThan(40);
    expect(registered).toContain("run_site_audit");
  });

  for (const { file, text } of playbookSources()) {
    it(`${file} names only Tools that exist`, () => {
      for (const name of mentionedToolNames(text)) {
        expect(registered, `${file} mentions ${name}`).toContain(name);
      }
    });
  }

  it("the handshake instructions name only Tools that exist", () => {
    for (const name of mentionedToolNames(SERVER_INSTRUCTIONS)) {
      expect(registered, `the instructions mention ${name}`).toContain(name);
    }
  });

  it("the handshake stays short enough to be worth its tokens", () => {
    // Paid for in every conversation, out of the budget the Operator's question
    // could have used. The playbooks carry the detail.
    expect(SERVER_INSTRUCTIONS.length).toBeLessThan(2_000);
  });
});
