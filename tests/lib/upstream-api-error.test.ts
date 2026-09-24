import { describe, it, expect } from "vitest";
import { UpstreamApiError, readGoogleRefusal } from "@/lib/upstream-api-error";

/** Google's error body for an API nobody enabled, as the Search Console API sends it. */
const SERVICE_DISABLED = JSON.stringify({
  error: {
    code: 403,
    message:
      "Google Search Console API has not been used in project 123456789 before or it is disabled.",
    status: "PERMISSION_DENIED",
    details: [
      {
        "@type": "type.googleapis.com/google.rpc.ErrorInfo",
        reason: "SERVICE_DISABLED",
        domain: "googleapis.com",
        metadata: {
          service: "searchconsole.googleapis.com",
          consumer: "projects/123456789",
          activationUrl: "https://evil.example/phish",
        },
      },
    ],
  },
});

const respond = (body: string, status: number) => new Response(body, { status });

describe("a 403 Google explained", () => {
  it("names the API to enable and links to it", async () => {
    const error = await UpstreamApiError.fromResponse(
      "Google Search Console",
      respond(SERVICE_DISABLED, 403),
    );

    expect(error.message).toContain("searchconsole.googleapis.com) is not enabled");
    expect(error.message).toContain(
      "https://console.developers.google.com/apis/api/searchconsole.googleapis.com/overview?project=123456789",
    );
    expect(error.refusal).toEqual({
      reason: "api-disabled",
      api: "searchconsole.googleapis.com",
      project: "123456789",
    });
  });

  it("rebuilds the link rather than forwarding the one in the body", async () => {
    // The body is a remote server's text. The URL it offers is not ours to publish.
    const error = await UpstreamApiError.fromResponse("Google Search Console", respond(SERVICE_DISABLED, 403));

    expect(error.message).not.toContain("evil.example");
    expect(error.message).not.toContain("has not been used in project");
  });

  it("recognises a key restricted to other APIs", () => {
    const body = JSON.stringify({
      error: {
        details: [
          { reason: "API_KEY_SERVICE_BLOCKED", metadata: { service: "chromeuxreport.googleapis.com" } },
        ],
      },
    });
    expect(readGoogleRefusal(body)).toEqual({
      reason: "key-restricted",
      api: "chromeuxreport.googleapis.com",
    });
  });
});

describe("a body that does not say, or says something we will not repeat", () => {
  it.each([
    ["HTML", "<html>Forbidden</html>"],
    ["a truncated body", '{"error":{"details":[{"reason":"SERVICE_DIS'],
    ["a service that is not a Google API host", JSON.stringify({
      error: { details: [{ reason: "SERVICE_DISABLED", metadata: { service: "evil.example", consumer: "projects/1" } }] },
    })],
    ["a consumer that is not a project number", JSON.stringify({
      error: {
        details: [{ reason: "SERVICE_DISABLED", metadata: { service: "x.googleapis.com", consumer: "projects/<b>" } }],
      },
    })],
  ])("falls back to the status sentence for %s", async (_label, body) => {
    const error = await UpstreamApiError.fromResponse("Google Search Console", respond(body, 403));

    expect(error.refusal).toBeNull();
    expect(error.message).toContain("The key was refused");
  });
});
