import { describe, expect, it, vi } from "vitest";
import { defineTool } from "@/lib/define-tool";
import { failure, success, unwrap } from "@/lib/type-guards";
import { toolText, type ToolResult } from "@/lib/tool-result";
import { SsrfError } from "@/lib/ssrf-guard";
import { MissingConfigError } from "@/lib/required-config";

/**
 * The invariant this file exists to keep: **a failure an analyzer *reports* is
 * worded by the same seam as one it throws.**
 *
 * `tool-failure.ts` states it: *"Every failure path routes here, not only the
 * `catch`. The analyzers do not throw — they return a failed Result — and a
 * handler that renders that branch itself has opted out of the rule, which is the
 * gap to watch for when porting a Tool."*
 *
 * Nine Tools carried that obligation by hand, in a byte-identical four-line
 * block, with the explanatory comment verbatim in three of them, a variant in
 * one, and absent in five. `unwrap` puts the branch at the seam, so this is one
 * test instead of nine — and instead of nine things to trust.
 *
 * A subtlety worth pinning rather than rediscovering: the authorship rule must
 * not care *how* the failure arrived. An `SsrfError` is our sentence and the
 * whole answer whether it was thrown or returned; a database driver's
 * `ECONNREFUSED` is neither, either way.
 */

const CONTEXT = "do the thing";

/** The text of a Tool result, which is all a client ever sees. */
const textOf = (result: ToolResult) => result.content.map((part) => part.text).join("\n");

describe("a reported failure and a thrown one are worded the same way", () => {
  it("forwards an authored message from a Result, exactly as from a throw", async () => {
    const refusal = new SsrfError(
      "Refusing to fetch private/reserved address: 169.254.169.254",
    );

    const reported = await defineTool(CONTEXT, async () => {
      return toolText(unwrap(failure(refusal)));
    })({});
    const thrown = await defineTool(CONTEXT, async () => {
      throw refusal;
    })({});

    expect(textOf(reported)).toBe(refusal.message);
    // The property that matters: the two paths are indistinguishable at the seam.
    expect(textOf(reported)).toBe(textOf(thrown));
    expect(reported.isError).toBe(true);
  });

  it("keeps the one message whose whole value is being read by a person", async () => {
    const missing = new MissingConfigError({
      variable: "EXAMPLE_API_KEY",
      purpose: "do the thing",
      howToGet: "Create one in the console.",
    });

    const result = await defineTool(CONTEXT, async () => toolText(unwrap(failure(missing))))({});

    // ADR-0003: the refusal names what to configure. Replacing it with "the
    // failure was unexpected" suppresses the only sentence that could have fixed
    // the problem.
    expect(textOf(result)).toContain("EXAMPLE_API_KEY");
    expect(textOf(result)).not.toContain("has been logged");
  });

  it("does not forward text we did not author, whichever path it took", async () => {
    // `logError` writes to stderr on purpose — see `log.ts` — so that is what
    // gets watched here, not `console.error`.
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const driver = new Error("ECONNREFUSED 10.0.0.5:5432");

    const reported = await defineTool(CONTEXT, async () => toolText(unwrap(failure(driver))))({});
    const thrown = await defineTool(CONTEXT, async () => {
      throw driver;
    })({});

    for (const result of [reported, thrown]) {
      // The internal hostname and port are the reason the rule is authorship
      // rather than severity.
      expect(textOf(result)).not.toContain("10.0.0.5");
      expect(textOf(result)).not.toContain("ECONNREFUSED");
      expect(textOf(result)).toContain(`Could not ${CONTEXT}`);
      expect(textOf(result)).toContain("has been logged");
      expect(result.isError).toBe(true);
    }
    expect(textOf(reported)).toBe(textOf(thrown));

    // Nothing is lost for debugging; it just stops being the client's problem.
    expect(stderr).toHaveBeenCalled();
    stderr.mockRestore();
  });

  it("leaves a successful Result alone", async () => {
    const result = await defineTool(CONTEXT, async () => toolText(unwrap(success("all well"))))({});

    expect(textOf(result)).toBe("all well");
    expect(result.isError).toBeUndefined();
  });
});
