import { describe, it, expect, vi, afterEach } from "vitest";
import { callApi, DEFAULT_PER_MINUTE, UpstreamUnansweredError, type ThirdPartyService } from "@/lib/third-party-api";
import { UpstreamApiError } from "@/lib/upstream-api-error";
import { MissingConfigError, type ConfigRequirement } from "@/lib/required-config";
import { describeToolFailure } from "@/lib/tool-failure";
import { requestsOf, serve, type FetchMock, type ServedRequest } from "../helpers/serve";

/**
 * `callApi`, at its interface: a service described once, and every answer an
 * API can give turned into data, "no data" or an error we wrote.
 *
 * These are the behaviours eleven modules used to re-implement, and four of
 * them got wrong — a timeout or an HTML 200 reached the Operator as "the failure
 * was unexpected". They are asserted here once, against made-up services, so the
 * modules' own tests can be about what their answers mean.
 *
 * Two of the cases are the invariant this file was first written for: **a fixed
 * third-party API is exempt from the robots gate on purpose, and from nothing
 * else.**
 */

const REQUIREMENT: ConfigRequirement = {
  variable: "TSA_TEST_API_KEY",
  purpose: "call the test API",
  howToGet: "Ask whoever wrote the test.",
};

const KEY = "sekret-key-0123456789";
const ENDPOINT = "https://api.example.com/v1/answer";

const keyless = { name: "The Test API", timeoutMs: 5_000 } satisfies ThirdPartyService;

const placements = {
  query: { ...keyless, key: { requirement: REQUIREMENT, in: "query", param: "key" } },
  header: { ...keyless, key: { requirement: REQUIREMENT, in: "header", header: "x-goog-api-key" } },
  bearer: { ...keyless, key: { requirement: REQUIREMENT, in: "bearer" } },
} satisfies Record<string, ThirdPartyService>;

/** What the one request asked for. */
function asked(mock: FetchMock): ServedRequest & { parsedUrl: URL } {
  const request = requestsOf(mock)[0] as ServedRequest;
  return { ...request, parsedUrl: new URL(request.url) };
}

/**
 * Put `AbortSignal.timeout` on the faked clock.
 *
 * Node's own timer behind it is not one `vi.useFakeTimers` reaches, so without
 * this a five-second budget would take five real seconds to run out. The fetch
 * is `serve`'s `hang` route, which answers only when the signal fires — so what
 * is tested is that `callApi` set a timeout and translated it, not that a
 * hand-thrown `DOMException` was translated.
 */
function onFakeClock(): void {
  vi.useFakeTimers();
  vi.spyOn(AbortSignal, "timeout").mockImplementation((ms: number) => {
    const controller = new AbortController();
    setTimeout(() => controller.abort(new DOMException("The operation timed out.", "TimeoutError")), ms);
    return controller.signal;
  });
}

/** The error `promise` rejects with once the faked clock has run `ms`. */
async function thrownAfter(promise: Promise<unknown>, ms: number): Promise<Error> {
  const error = thrown(promise);
  await vi.advanceTimersByTimeAsync(ms);
  return error;
}

async function thrown(promise: Promise<unknown>): Promise<Error> {
  try {
    await promise;
  } catch (error) {
    return error as Error;
  }
  throw new Error("expected a rejection");
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("the key", () => {
  it("refuses before any request when it is not set", async () => {
    vi.stubEnv(REQUIREMENT.variable, "");
    const mock = serve({ "example.com": { body: "{}" } });

    const error = await thrown(callApi(placements.query, { url: ENDPOINT }));

    expect(error).toBeInstanceOf(MissingConfigError);
    expect(error.message).toContain("TSA_TEST_API_KEY is not set");
    expect(mock).not.toHaveBeenCalled();
  });

  it("goes in the query parameter the service names, and nowhere else", async () => {
    vi.stubEnv(REQUIREMENT.variable, KEY);
    const mock = serve({ "example.com": { body: "{}" } });

    await callApi(placements.query, { url: ENDPOINT, query: { q: "acme" } });

    const { searchParams, headers } = asked(mock);
    expect(searchParams.get("key")).toBe(KEY);
    expect(searchParams.get("q")).toBe("acme");
    expect(JSON.stringify(headers)).not.toContain(KEY);
  });

  it("goes in the header the service names, and never in the URL", async () => {
    vi.stubEnv(REQUIREMENT.variable, KEY);
    const mock = serve({ "example.com": { body: "{}" } });

    await callApi(placements.header, { url: ENDPOINT });

    const { url, headers } = asked(mock);
    expect(headers["x-goog-api-key"]).toBe(KEY);
    expect(url).not.toContain(KEY);
  });

  it("goes in a bearer token, and never in the URL", async () => {
    vi.stubEnv(REQUIREMENT.variable, KEY);
    const mock = serve({ "example.com": { body: "{}" } });

    await callApi(placements.bearer, { url: ENDPOINT });

    const { url, headers } = asked(mock);
    expect(headers.authorization).toBe(`Bearer ${KEY}`);
    expect(url).not.toContain(KEY);
  });

  it.each(Object.entries(placements))(
    "never appears in an error message, placed in the %s",
    async (_, service) => {
      vi.stubEnv(REQUIREMENT.variable, KEY);
      onFakeClock();
      const failures = [
        // A refusal whose body echoes the key, as some APIs' do.
        { status: 403, body: `{"error":{"message":"bad key ${KEY}"}}` },
        { status: 200, body: `<html>${KEY}</html>` },
        { hang: true as const },
      ];
      for (const route of failures) {
        serve({ "example.com": route });
        const error = await thrownAfter(callApi(service, { url: ENDPOINT }), service.timeoutMs);
        expect(error.message).not.toContain(KEY);
      }
    },
  );
});

describe("a request", () => {
  it("does not ask the API's robots.txt for permission", async () => {
    // Asking `wikipedia.org/robots.txt` whether we may call Wikipedia's REST API
    // is asking the wrong party the wrong question.
    const mock = serve({
      "/robots.txt": { body: "User-agent: *\nDisallow: /" },
      "/v1/answer": { body: "{}" },
    });

    await callApi(keyless, { url: ENDPOINT });

    expect(mock.mock.calls.map((call) => String(call[0]))).toEqual([ENDPOINT]);
  });

  it("identifies itself, because these APIs ask for a contactable agent", async () => {
    const mock = serve({ "example.com": { body: "{}" } });

    await callApi(keyless, { url: ENDPOINT });

    expect(asked(mock).headers["user-agent"]).toContain("ThatSEOAgentBot");
  });

  it("repeats an array parameter and keeps the ones already on the URL", async () => {
    const mock = serve({ "example.com": { body: "{}" } });

    await callApi(keyless, { url: `${ENDPOINT}?fixed=1`, query: { type: ["A", "B"] } });

    const { searchParams } = asked(mock);
    expect(searchParams.get("fixed")).toBe("1");
    expect(searchParams.getAll("type")).toEqual(["A", "B"]);
  });

  it("posts a JSON body as JSON", async () => {
    const mock = serve({ "example.com": { body: "{}" } });

    await callApi(keyless, { url: ENDPOINT, json: { url: "https://example.com/" } });

    const { method, headers, json } = asked(mock);
    expect(method).toBe("POST");
    expect(headers["content-type"]).toBe("application/json");
    expect(json).toEqual({ url: "https://example.com/" });
  });
});

describe("an answer", () => {
  it("is the parsed body and its status", async () => {
    serve({ "example.com": { body: '{"rows":[1,2]}' } });

    expect(await callApi(keyless, { url: ENDPOINT })).toEqual({
      kind: "data",
      body: { rows: [1, 2] },
      status: 200,
    });
  });

  it("is 'no data' on a status the service declares as meaning that", async () => {
    serve({ "example.com": { status: 404, body: '{"error":"not enough traffic"}' } });

    const answer = await callApi({ ...keyless, noDataStatuses: [404] }, { url: ENDPOINT });

    expect(answer).toEqual({ kind: "no-data", status: 404 });
  });

  it("is a refusal on the same status from a service that declares no such thing", async () => {
    serve({ "example.com": { status: 404 } });

    const error = await thrown(callApi(keyless, { url: ENDPOINT }));

    expect(error).toBeInstanceOf(UpstreamApiError);
    expect((error as UpstreamApiError).status).toBe(404);
  });
});

describe("no answer we can read", () => {
  it("says the service was slow, naming it and the seconds, rather than that something unexpected happened", async () => {
    onFakeClock();
    serve({ "example.com": { hang: true } });

    const error = await thrownAfter(callApi(keyless, { url: ENDPOINT }), keyless.timeoutMs);

    expect(error).toBeInstanceOf(UpstreamUnansweredError);
    expect(error.message).toContain("The Test API did not answer within 5 seconds");
    // What the Operator reads: our sentence, forwarded, not the generic one.
    expect(describeToolFailure(error, "call the test API")).toBe(error.message);
  });

  it("says the same when the headers arrived and the body did not", async () => {
    onFakeClock();
    serve({ "example.com": { hang: "body" } });

    const error = await thrownAfter(callApi(keyless, { url: ENDPOINT }), keyless.timeoutMs);

    expect(error.message).toContain("did not answer within 5 seconds");
  });

  it("reads a 200 that is not JSON as unreadable, and forwards none of it", async () => {
    serve({
      "example.com": {
        body: "<html><title>Temporarily Offline</title></html>",
        headers: { "content-type": "text/html" },
      },
    });

    const error = await thrown(callApi(keyless, { url: ENDPOINT }));

    expect(error).toBeInstanceOf(UpstreamUnansweredError);
    expect((error as UpstreamApiError).status).toBe(200);
    expect(error.message).toContain("The Test API answered, but not with data in its documented format");
    expect(error.message).not.toContain("Temporarily Offline");
    expect(describeToolFailure(error, "call the test API")).toBe(error.message);
  });
});

describe("a refusal", () => {
  const googleRefusal = (reason: string) =>
    JSON.stringify({
      error: {
        code: 403,
        message: "a remote sentence we do not forward",
        details: [
          {
            "@type": "type.googleapis.com/google.rpc.ErrorInfo",
            reason,
            metadata: { service: "webrisk.googleapis.com", consumer: "projects/123456789" },
          },
        ],
      },
    });

  it("names the API to enable when Google says it is disabled", async () => {
    serve({ "example.com": { status: 403, body: googleRefusal("SERVICE_DISABLED") } });

    const error = await thrown(callApi(keyless, { url: ENDPOINT }));

    expect(error.message).toContain("The Test API returned HTTP 403");
    expect(error.message).toContain(
      "https://console.developers.google.com/apis/api/webrisk.googleapis.com/overview?project=123456789",
    );
    expect(error.message).not.toContain("remote sentence");
  });

  it("names the billing account to link when Google says billing is off", async () => {
    serve({ "example.com": { status: 403, body: googleRefusal("BILLING_DISABLED") } });

    const error = await thrown(callApi(keyless, { url: ENDPOINT }));

    expect(error.message).toContain(
      "https://console.cloud.google.com/billing/linkedaccount?project=123456789",
    );
  });

  it("is an UpstreamApiError carrying its status on a 5xx, and not an unanswered one", async () => {
    serve({ "example.com": { status: 503, body: "upstream connect error" } });

    const error = await thrown(callApi(keyless, { url: ENDPOINT }));

    expect(error).toBeInstanceOf(UpstreamApiError);
    expect(error).not.toBeInstanceOf(UpstreamUnansweredError);
    expect((error as UpstreamApiError).status).toBe(503);
    expect(error.message).toContain("failed on its own side");
    expect(error.message).not.toContain("upstream connect");
  });
});

describe("the provider's ceiling", () => {
  /** Whether `promise` has settled, without waiting for it. */
  function settledFlag(promise: Promise<unknown>): { done: boolean } {
    const flag = { done: false };
    void promise.finally(() => {
      flag.done = true;
    });
    return flag;
  }

  it("holds a request over the service's perMinute until the minute makes room, rather than failing", async () => {
    vi.useFakeTimers();
    const mock = serve({ "example.com": { body: "{}" } });
    const twoAMinute = { ...keyless, name: "The Two-a-Minute API", perMinute: 2 };

    await callApi(twoAMinute, { url: ENDPOINT });
    await callApi(twoAMinute, { url: ENDPOINT });
    const third = callApi(twoAMinute, { url: ENDPOINT });
    const flag = settledFlag(third);

    await vi.advanceTimersByTimeAsync(59_000);
    expect(flag.done).toBe(false);
    expect(mock).toHaveBeenCalledTimes(2);

    await vi.advanceTimersByTimeAsync(1_100);
    await expect(third).resolves.toMatchObject({ kind: "data" });
    expect(mock).toHaveBeenCalledTimes(3);
  });

  it("counts each service in its own window", async () => {
    vi.useFakeTimers();
    const mock = serve({ "example.com": { body: "{}" } });
    const first = { ...keyless, name: "The First API", perMinute: 1 };
    const second = { ...keyless, name: "The Second API", perMinute: 1 };

    await callApi(first, { url: ENDPOINT });
    const waiting = settledFlag(callApi(first, { url: ENDPOINT }));
    const other = callApi(second, { url: ENDPOINT });
    await vi.advanceTimersByTimeAsync(0);

    await expect(other).resolves.toMatchObject({ kind: "data" });
    expect(waiting.done).toBe(false);
    expect(mock).toHaveBeenCalledTimes(2);
  });

  it("counts services that name one ceiling key in one window, as Wikimedia's do", async () => {
    vi.useFakeTimers();
    serve({ "example.com": { body: "{}" } });
    const rest = { ...keyless, name: "A REST API", ceilingKey: "One Provider", perMinute: 1 };
    const action = { ...keyless, name: "An Action API", ceilingKey: "One Provider", perMinute: 1 };

    await callApi(rest, { url: ENDPOINT });
    const flag = settledFlag(callApi(action, { url: ENDPOINT }));
    await vi.advanceTimersByTimeAsync(30_000);

    expect(flag.done).toBe(false);
  });

  it("applies the default to a service that declares none", async () => {
    vi.useFakeTimers();
    const mock = serve({ "example.com": { body: "{}" } });
    const undeclared = { ...keyless, name: "The Undeclared API" };

    for (let i = 0; i < DEFAULT_PER_MINUTE; i++) await callApi(undeclared, { url: ENDPOINT });
    const flag = settledFlag(callApi(undeclared, { url: ENDPOINT }));
    await vi.advanceTimersByTimeAsync(30_000);

    expect(flag.done).toBe(false);
    expect(mock).toHaveBeenCalledTimes(DEFAULT_PER_MINUTE);
  });

  it("is not the site pace: requests to one API's origin start without a gap between them", async () => {
    // `crawl-pacing` spaces starts to one origin by 100 ms. That is a rule for
    // a site that published no limit, and it used to queue every fixed API
    // behind it as well.
    vi.useFakeTimers();
    const mock = serve({ "example.com": { body: "{}" } });

    const all = Promise.all([1, 2, 3].map(() => callApi(keyless, { url: ENDPOINT })));
    await vi.advanceTimersByTimeAsync(0);

    expect(mock).toHaveBeenCalledTimes(3);
    await all;
  });

  // The pair below is the reset. Nothing in this file clears the window: the
  // first case fills it, and the second finds it empty only because
  // `tests/setup.ts` empties every registered limiter before each test.
  const onceAMinute = { ...keyless, name: "The Once-a-Minute API", perMinute: 1 };

  it("fills a window", async () => {
    vi.useFakeTimers();
    serve({ "example.com": { body: "{}" } });

    await callApi(onceAMinute, { url: ENDPOINT });
    const flag = settledFlag(callApi(onceAMinute, { url: ENDPOINT }));
    await vi.advanceTimersByTimeAsync(0);

    expect(flag.done).toBe(false);
  });

  it("starts the next test with that window empty, though no file reset it", async () => {
    vi.useFakeTimers();
    serve({ "example.com": { body: "{}" } });

    const flag = settledFlag(callApi(onceAMinute, { url: ENDPOINT }));
    await vi.advanceTimersByTimeAsync(0);

    expect(flag.done).toBe(true);
  });
});
