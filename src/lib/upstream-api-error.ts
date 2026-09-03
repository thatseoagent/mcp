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
 */
import { logError } from "./log";

export class UpstreamApiError extends Error {
  /** The HTTP status the API answered with. */
  readonly status: number;
  /** The API, named as the Operator would name it. */
  readonly service: string;

  constructor(service: string, status: number) {
    super(`${service} returned HTTP ${status}. ${describeUpstreamStatus(status)}`);
    this.name = "UpstreamApiError";
    this.status = status;
    this.service = service;
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
    return new UpstreamApiError(service, response.status);
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
