import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { GOOGLE_SCOPES } from "@/lib/google/scopes";
import { GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET } from "@/lib/google/oauth";
import { HTTP_ENDPOINT, HTTP_PORT, MCP_URL } from "@/lib/server-address";

/**
 * The setup guide, checked against the thing it describes.
 *
 * #17 asks for a document verified by following it rather than by review. The
 * parts a person has to follow — creating a Cloud project, clicking through a
 * consent screen — cannot be automated, and were followed by hand.
 *
 * What *can* be pinned is everything the document quotes from this codebase: the
 * port, the endpoint, the variable names, the scopes, the commands, and the
 * error messages in its troubleshooting table. Those are the parts that rot
 * silently — a renamed variable leaves a guide that reads perfectly and does not
 * work, and nobody notices until somebody follows it on a clean machine.
 */

const guide = readFileSync(path.resolve(process.cwd(), "docs/setup.md"), "utf8");
const packageJson = JSON.parse(readFileSync(path.resolve(process.cwd(), "package.json"), "utf8")) as {
  scripts: Record<string, string>;
  engines: { node: string };
};

describe("the setup guide quotes this server correctly", () => {
  it("names the address the server actually listens on", () => {
    expect(guide).toContain(MCP_URL);
    expect(guide).toContain(String(HTTP_PORT));
    expect(guide).toContain(HTTP_ENDPOINT);
  });

  it("names commands that exist", () => {
    for (const command of ["install", "build", "start", "login"]) {
      // `pnpm install` is npm's own; the rest have to be declared.
      if (command !== "install") {
        expect(packageJson.scripts, command).toHaveProperty(command);
      }
      expect(guide).toContain(`pnpm ${command}`);
    }
  });

  it("names the Node version the package requires", () => {
    // The stated version has to track `engines`, or the guide sends somebody to
    // install one that will not run this.
    const required = packageJson.engines.node.replace(/[^\d.]/g, "").split(".")[0];
    expect(guide).toContain(`Node ${required}`);
  });

  it("names the environment variables the login actually reads", () => {
    expect(guide).toContain(GOOGLE_CLIENT_ID.variable);
    expect(guide).toContain(GOOGLE_CLIENT_SECRET.variable);
  });

  it("tells the Operator to use the file rather than the shell", () => {
    // `export` reaches one terminal. The login command and the server are
    // different processes, usually started from different ones, and the guide
    // sending somebody down that path is the mistake that looks like the login
    // not having worked.
    expect(guide).toContain(".env");
    expect(guide).toContain(".env.example");
    expect(guide).not.toContain("export GOOGLE_CLIENT_ID");
  });

  it("lists exactly the scopes the login asks for, and calls both read-only", () => {
    for (const scope of GOOGLE_SCOPES) {
      // The bare product name, since the table names them the way a person does.
      const shortName = scope.url.split("/").pop()!;
      expect(guide, scope.url).toContain(shortName);
    }
    expect(guide).toContain("read-only");
    expect(guide).toContain("never submits a sitemap");
  });

  it("requires the one OAuth client type that works", () => {
    // The single setup mistake that produces a confusing Google error page much
    // later, so the guide has to be emphatic about it.
    expect(guide).toContain("Desktop app");
    expect(guide).toContain("redirect_uri_mismatch");
  });
});

describe("the troubleshooting table maps real messages", () => {
  /**
   * Each entry is a phrase the guide promises an Operator will see, and the
   * module that actually produces it. Matched on a distinctive fragment rather
   * than the whole sentence: the wording is allowed to be improved, but it is
   * not allowed to diverge from what the code says.
   */
  const messages: Array<[string, string]> = [
    ["Port 3737 on 127.0.0.1 is already in use", "scripts/start.mjs"],
    ["There is no build to run", "scripts/start.mjs"],
    ["is not set", "src/lib/required-config.ts"],
    ["Google did not return a refresh token", "src/lib/google/login-flow.ts"],
    ["No Search Console property found", "src/lib/google/property.ts"],
    ["No Full Report for", "src/tools/run-site-audit.ts"],
    ["not verified", "src/lib/google/property-access.ts"],
    ["returned HTTP 403", "src/lib/upstream-api-error.ts"],
  ];

  for (const [phrase, source] of messages) {
    it(`"${phrase}" is a message ${source} can produce`, () => {
      const code = readFileSync(path.resolve(process.cwd(), source), "utf8");

      expect(guide, `the guide is missing "${phrase}"`).toContain(phrase);
      // `returned HTTP 403` is built from a template, so the fragment either side
      // of the status is what to look for.
      const inCode = phrase.replace(/\b403\b/, "${status}").replace("Port 3737 on 127.0.0.1", "Port ${port} on ${host}");
      expect(code, `${source} no longer produces "${phrase}"`).toContain(inCode);
    });
  }
});

describe("the guide's shape", () => {
  it("puts the credential-free path first and says you can stop there", () => {
    // The cold-install on-ramp is that half of the surface. Someone who only
    // wants it should not have to read about Google Cloud to find out.
    const credentialFree = guide.indexOf("## 1. Install and connect");
    const google = guide.indexOf("## 2. Google Cloud");

    expect(credentialFree).toBeGreaterThan(-1);
    expect(credentialFree).toBeLessThan(google);
    expect(guide).toContain("You can stop here");
  });

  it("links the decisions it depends on rather than restating them", () => {
    for (const adr of [
      "adr/0002-google-login-via-local-cli.md",
      "adr/0003-tools-fail-rather-than-degrade.md",
      "adr/0004-http-transport-on-loopback.md",
    ]) {
      expect(guide, adr).toContain(adr);
    }
  });
});
