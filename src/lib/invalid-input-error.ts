/**
 * The caller passed an argument we cannot use, and naming it is the answer.
 *
 * Distinct from every other failure in the codebase by who can fix it: nobody
 * needs to be paged, nothing needs to be retried, and the party that can act is
 * the one that will read the message. `BreadcrumbList requires 'items' array` is
 * a complete instruction to a model that omitted the field; replacing it with
 * "the failure was unexpected, retrying shortly may work" removes the only
 * information that would have led to a correct second call, and — because the
 * generic text also says not to speculate about the cause — actively discourages
 * the inference that would fix it.
 *
 * A leaf module with no imports, so the low-level validators (`http-client`) and
 * the pure generators (`schema-generator`) can both raise it without either one
 * reaching for the other.
 *
 * The bar for throwing this is that the message names the offending argument, or
 * the constraint it violated, in the caller's own vocabulary. Anything that would
 * make the reader guess belongs in an ordinary `Error`, where the seam in
 * `tool-failure.ts` will log it and summarize it instead.
 */
export class InvalidInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidInputError";
    // Restore prototype chain (needed when targeting ES5 or compiling with tsc)
    Object.setPrototypeOf(this, new.target.prototype);
  }
}
