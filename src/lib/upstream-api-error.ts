/**
 * A third-party API we call on the Operator's behalf answered, and not with data.
 *
 * Distinct from {@link PageFetchError}, which is about *the page the Operator
 * asked us to audit*. Every sentence there names "the URL", and reusing it here
 * would tell an Operator their own site returned 403 when what happened is that
 * Google refused our key. Two failures, two subjects, two vocabularies.
 *
 * ── What is deliberately not carried ──
 *
 * The response body. Google's error payloads are JSON with a `message` that is
 * often useful and is, in the end, **a remote server's text forwarded verbatim
 * into a model's context under our signature**. `page-fetch-error.ts` already
 * settled this argument for `statusText` and the reasoning is unchanged: the
 * status is the fact, and a fixed sentence per status is what makes the whole
 * class safe to publish. The body still reaches stderr through `logError`, so
 * nothing is lost for debugging.
 *
 * The status is carried as a field for callers that branch on it, and because
 * reading it back out of `message` would couple a decision to prose that exists
 * to be reworded.
 *
 * ── The one thing read out of the body ──
 *
 * The commonest failure on a fresh Google Cloud project is an API nobody enabled,
 * and it arrives as a 403 indistinguishable by status from a refused key or a
 * property the account cannot read. Google says which in a structured field —
 * `error.details[].reason` is `SERVICE_DISABLED`, with the API's host name and
 * the project number beside it — and the generic 403 sentence made the Operator
 * guess between three fixes when the response had named one.
 *
 * So the body is *parsed* for that, and nothing from it is forwarded as text.
 * Two tokens are taken, each checked against a strict pattern — a
 * `*.googleapis.com` host and a numeric project — and the sentence and the
 * console URL are rebuilt from them here. Anything that does not match is
 * dropped and the status sentence stands, which is the same message as before.
 */
import { logError } from "./log";

/**
 * A refusal Google explained, reduced to the tokens a fixed sentence needs.
 *
 * - `api-disabled` — the API is not enabled on the Cloud project the key or the
 *   OAuth client belongs to.
 * - `key-restricted` — the API key carries an API restriction that leaves this
 *   API out.
 */
export type GoogleRefusal =
  | { reason: "api-disabled"; api: string; project: string }
  | { reason: "key-restricted"; api: string };

/** A Google API host, e.g. `searchconsole.googleapis.com`. Nothing looser. */
const API_HOST = /^[a-z0-9-]+(?:\.[a-z0-9-]+)*\.googleapis\.com$/;
/** The consumer as Google writes it: `projects/<number>`. */
const PROJECT = /^projects\/(\d{1,20})$/;

/**
 * Read a {@link GoogleRefusal} out of a Google error body, or `null`.
 *
 * Exported for its test. Tolerant of every shape that is not the one it wants,
 * because a body that is HTML, truncated or from a proxy is ordinary.
 */
export function readGoogleRefusal(body: string): GoogleRefusal | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return null;
  }
  const error = isObject(parsed) && isObject(parsed.error) ? parsed.error : null;
  const details = error && Array.isArray(error.details) ? error.details : [];

  for (const detail of details) {
    if (!isObject(detail) || typeof detail.reason !== "string") continue;
    const metadata = isObject(detail.metadata) ? detail.metadata : {};
    const api = typeof metadata.service === "string" && API_HOST.test(metadata.service)
      ? metadata.service
      : null;
    if (!api) continue;

    if (detail.reason === "SERVICE_DISABLED") {
      const project =
        typeof metadata.consumer === "string" ? PROJECT.exec(metadata.consumer)?.[1] : undefined;
      if (project) return { reason: "api-disabled", api, project };
    }
    if (detail.reason === "API_KEY_SERVICE_BLOCKED") {
      return { reason: "key-restricted", api };
    }
  }
  return null;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The fix, as a fixed sentence around the two validated tokens. */
function describeRefusal(refusal: GoogleRefusal): string {
  if (refusal.reason === "api-disabled") {
    return (
      `The API it needs (${refusal.api}) is not enabled on the Google Cloud project these ` +
      `credentials belong to. Enable it at https://console.developers.google.com/apis/api/` +
      `${refusal.api}/overview?project=${refusal.project} and retry in a few minutes — ` +
      "the change takes a moment to reach Google's servers. Nothing else is misconfigured."
    );
  }
  return (
    `The API key is restricted to other APIs and ${refusal.api} is not among them. Add it ` +
    "under the key's API restrictions at https://console.cloud.google.com/apis/credentials, " +
    "or remove the restriction."
  );
}

export class UpstreamApiError extends Error {
  /** The HTTP status the API answered with. */
  readonly status: number;
  /** The API, named as the Operator would name it. */
  readonly service: string;
  /**
   * Why Google refused, when it said so in a form we can check. For callers that
   * branch on it: a disabled API is not a property the account cannot read, and
   * retrying with the other property shape will not enable it.
   */
  readonly refusal: GoogleRefusal | null;

  constructor(service: string, status: number, refusal: GoogleRefusal | null = null) {
    super(
      `${service} returned HTTP ${status}. ` +
        (refusal ? describeRefusal(refusal) : describeUpstreamStatus(status)),
    );
    this.name = "UpstreamApiError";
    this.status = status;
    this.service = service;
    this.refusal = refusal;
    Object.setPrototypeOf(this, new.target.prototype);
  }

  /**
   * Build the error and send the body to stderr in one step.
   *
   * One call rather than two, because the two belong together: the body is the
   * thing a reader debugging this will want, and it is precisely the thing that
   * must not travel in the message. Splitting them is how a caller ends up doing
   * one and forgetting the other.
   */
  static async fromResponse(service: string, response: Response): Promise<UpstreamApiError> {
    const body = await response.text().catch(() => "");
    if (body) logError(`${service} returned HTTP ${response.status}`, body.slice(0, 1_000));
    return new UpstreamApiError(service, response.status, readGoogleRefusal(body));
  }
}

/**
 * What a status means when the thing that returned it is an API rather than a
 * page. Each sentence says what the Operator can do about it, because that is
 * the only reason to print a status at all.
 */
function describeUpstreamStatus(status: number): string {
  if (status === 400) {
    return "The request was rejected. This usually means the configured key is wrong or the request asked for something the API does not accept.";
  }
  if (status === 401 || status === 403) {
    return "The key was refused. Check that it is valid, that the API is enabled for its project, and that any referrer or IP restriction on it allows this machine.";
  }
  if (status === 429) {
    return "The quota for this key is exhausted. Retrying later should work; a persistent 429 means the quota needs raising.";
  }
  if (status >= 500) {
    return "The API failed on its own side. Nothing here is misconfigured; retrying shortly usually works.";
  }
  return "The call did not return data.";
}
