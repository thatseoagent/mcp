import { describe, it, expect, afterEach, vi } from "vitest";
import { MissingConfigError, requireConfig } from "@/lib/required-config";
import { describeToolFailure } from "@/lib/tool-failure";

const A_KEY = {
  variable: "EXAMPLE_API_KEY",
  purpose: "call the Example API",
  howToGet: "Create one at https://example.com/console and enable the Example API.",
};

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("requireConfig", () => {
  it("returns the value when it is set", () => {
    vi.stubEnv("EXAMPLE_API_KEY", "abc123");

    expect(requireConfig(A_KEY)).toBe("abc123");
  });

  it("refuses when the variable is unset, naming it and where to get a value", () => {
    vi.stubEnv("EXAMPLE_API_KEY", undefined);

    expect(() => requireConfig(A_KEY)).toThrow(MissingConfigError);
    try {
      requireConfig(A_KEY);
    } catch (error) {
      const message = (error as Error).message;
      expect(message).toContain("EXAMPLE_API_KEY");
      expect(message).toContain("call the Example API");
      expect(message).toContain("https://example.com/console");
      // The line an Operator can paste, because "set the variable" is advice and
      // this is an instruction. It names the file too: `export` reaches one
      // shell, and the server is usually started in a different one.
      expect(message).toContain(".env");
      expect(message).toContain("EXAMPLE_API_KEY=your_key");
    }
  });

  it("treats a variable set to whitespace as unset", () => {
    // A `.env` line left as `PAGESPEED_API_KEY=` reads as configured and is not.
    // Passing it on produces a 400 from the far end, which sends the Operator
    // debugging Google rather than their own file.
    vi.stubEnv("EXAMPLE_API_KEY", "   ");

    expect(() => requireConfig(A_KEY)).toThrow(MissingConfigError);
  });

  it("never puts the value it read into the message", () => {
    // The refusal is about the variable, never its contents: these messages are
    // published to the agent's context verbatim.
    vi.stubEnv("EXAMPLE_API_KEY", "");

    try {
      requireConfig(A_KEY);
    } catch (error) {
      expect((error as MissingConfigError).variable).toBe("EXAMPLE_API_KEY");
    }
  });

  it("is forwarded verbatim by the Tool failure seam", () => {
    // The whole point of the mechanism: what the Operator reads is the sentence
    // naming the variable, not "the failure was unexpected and has been logged".
    vi.stubEnv("EXAMPLE_API_KEY", undefined);

    let error: unknown;
    try {
      requireConfig(A_KEY);
    } catch (thrown) {
      error = thrown;
    }

    expect(describeToolFailure(error, "do the thing")).toContain("EXAMPLE_API_KEY");
    expect(describeToolFailure(error, "do the thing")).not.toContain("has been logged");
  });
});
