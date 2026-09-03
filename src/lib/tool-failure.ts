/**
 * The single seam that turns a thrown error into text an MCP client may see.
 *
 * Without it, handlers end with the same four lines — catch, take `.message`,
 * return it as text — which forwards whatever the failure happened to say into
 * the model's context: a database driver string, an internal hostname, a
 * serialized upstream request.
 *
 * The rule is **authorship, not severity**: a message is forwarded when we wrote
 * it, and replaced when we did not. `SsrfError("Refusing to fetch
 * private/reserved address: 169.254.169.254")` is our sentence, it is the whole
 * answer to the Operator's question, and suppressing it would make a correct
 * refusal look like a crash. A driver's `ECONNREFUSED …:5432` is not our sentence
 * and says nothing anyone can act on.
 *
 * Anything unrecognized is logged in full to stderr and summarized generically.
 * Nothing is lost for debugging; it just stops being the client's problem.
 *
 * Every failure path routes here, not only the `catch`. The analyzers do not
 * throw — they return a failed Result — and a handler that renders that branch
 * itself has opted out of the rule, which is the gap to watch for when porting a
 * Tool.
 */
import { SsrfError } from "./ssrf-guard";
import { PageFetchError } from "./page-fetch-error";
import { InvalidInputError } from "./invalid-input-error";
import { RobotsDisallowedError } from "./robots-gate";
import { CrawlBudgetError } from "./crawl-pacing";
import { MissingConfigError } from "./required-config";
import { UpstreamApiError } from "./upstream-api-error";
import { logError } from "./log";
import { toolError, type ToolResult } from "./tool-result";

/**
 * Error types whose `message` we author ourselves and whose text is written to be
 * read by a person. Adding a class here is a statement that every message it can
 * carry is safe to publish — check the throw sites before extending it.
 *
 * The test to apply is not "did a human type the string" but: **is this text the
 * answer, and can its every instance be shown to anyone?** A `PageFetchError`
 * carries a status and a fixed sentence per status, so yes. An error from a
 * database driver carries whatever the driver felt like saying, so no.
 *
 * The list is shorter than it will be. Errors from the Google layer and from the
 * database belong here too, and join it when those layers land.
 */
const AUTHORED_BY_US = [
  SsrfError,
  PageFetchError,
  InvalidInputError,
  // Both are refusals rather than failures, and the distinction is the whole
  // message: the site is fine and we chose not to press it. Replacing either
  // with "the failure was unexpected" would send an Operator debugging a server
  // over a rule somebody wrote on purpose, or over a pace we set ourselves.
  RobotsDisallowedError,
  CrawlBudgetError,
  // The one error whose whole value is being read by a person: it names the
  // variable to set and where to get a value for it. Replacing it with "the
  // failure was unexpected and has been logged" suppresses the only sentence
  // that could have fixed the problem, which is what the retired implementation
  // did by throwing a bare `Error`. ADR-0003.
  MissingConfigError,
  // A status and a fixed sentence per status, interpolating a service name we
  // wrote down ourselves. The remote server's body never reaches the message —
  // see the class — which is the property that makes the whole type safe to
  // forward, and the one to re-check before adding a field to it.
  UpstreamApiError,
] as const;

function isAuthoredByUs(error: unknown): error is Error {
  return AUTHORED_BY_US.some((ctor) => error instanceof ctor);
}

/**
 * Describes a failure for the client.
 *
 * @param error   the thrown value, of any shape
 * @param context what was being attempted, in the Operator's terms. Written to
 *                complete the sentence "Could not …".
 */
export function describeToolFailure(error: unknown, context: string): string {
  if (isAuthoredByUs(error)) return error.message;

  logError(context, error);

  return (
    `Could not ${context}. The failure was unexpected and has been logged. ` +
    `Trying again shortly often works. The cause is not visible from here, so ` +
    `nothing more specific can be said about it.`
  );
}

/** {@link describeToolFailure}, already shaped as an error {@link ToolResult}. */
export function toolFailure(error: unknown, context: string): ToolResult {
  return toolError(describeToolFailure(error, context));
}
