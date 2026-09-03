/**
 * What a Tool needs configured, and what it says when it is not.
 *
 * ADR-0003 states the posture: **a Tool that cannot do its whole job returns an
 * error naming what to configure, and never returns a smaller result instead.**
 * This module is the mechanism that makes that cheap enough to be the default,
 * because the alternative — each Tool writing its own sentence — is how a surface
 * ends up with fifteen ways of saying "not configured", several of which forget
 * to say what to set.
 *
 * Three things it guarantees, and each of them was a bug somewhere first:
 *
 * - **The Operator is told the variable's name and where to get a value.** The
 *   retired implementation threw a bare `Error` whose message was good, and being
 *   a bare `Error` it was replaced with "the failure was unexpected and has been
 *   logged" the moment it crossed the Tool boundary — so the one sentence that
 *   could have fixed the problem was the one thing suppressed.
 * - **The refusal reaches the agent as a Tool result, not a transport error.**
 *   {@link MissingConfigError} is registered in `tool-failure.ts` as authored by
 *   us, so `defineTool` renders it as text the model can read out and act on.
 *   An exception escaping the handler is a transport failure the client cannot
 *   relay.
 * - **The value never appears in the message.** These strings are published into
 *   the model's context verbatim; a refusal that helpfully echoed the malformed
 *   key would publish a credential.
 *
 * A Tool stays registered whether or not its configuration is present. That is
 * not this module's doing — xmcp discovers Tools from the filesystem, so there is
 * nothing here that could hide one — but it is the half of ADR-0003 that makes
 * this half worth having: a Tool that vanished from `tools/list` would leave the
 * agent nothing to explain to the Operator, and many clients cache that list.
 *
 * ── What does NOT belong here ──
 *
 * `GOOGLE_KG_API_KEY` goes through {@link readOptionalConfig} rather than through
 * {@link requireConfig}, and that is a different posture rather than an
 * oversight: the Knowledge Graph lookup is an **enrichment**, and a Tool without
 * it reports the check as not evaluated and answers everything else. Routing it
 * through `requireConfig` would turn an optional signal into a refusal, which is
 * the opposite of what ADR-0003 asks for — the ADR is about a Tool that cannot do
 * its *whole* job. What the two share is where the value comes from: both read
 * `.env` through the same loader, so an Operator configures one file.
 *
 * The test to apply: can the Tool still answer the question it was asked? If yes,
 * the variable is an enrichment and the missing signal is reported as not
 * evaluated. If no, it is a requirement and belongs here.
 */

import { loadEnvFile } from "./env-file";

/** One piece of configuration a Tool cannot work without. */
export interface ConfigRequirement {
  /** The environment variable's name, exactly as it must be spelled. */
  variable: string;
  /**
   * What the Tool does with it, completing the sentence "… is needed to …".
   *
   * In the Operator's terms rather than ours: "call the PageSpeed Insights API"
   * says why the key exists, "authenticate the client" says nothing they can act
   * on.
   */
  purpose: string;
  /** Where to obtain a value. A URL and, where it is not obvious, what to enable. */
  howToGet: string;
}

/**
 * A Tool was asked to do something it has not been configured for.
 *
 * A distinct type because it is a **refusal, not a failure**: nothing went wrong,
 * and there is exactly one person who can change the outcome. Reporting it as an
 * unexpected error would send an Operator reading logs for a fault that is not
 * there.
 */
export class MissingConfigError extends Error {
  /**
   * The variable that is not set.
   *
   * Carried as a field rather than parsed back out of `message`, which is prose
   * written for a person and exists to be reworded.
   */
  readonly variable: string;

  constructor(requirement: ConfigRequirement) {
    super(
      `${requirement.variable} is not set, and it is needed to ${requirement.purpose}. ` +
        `${requirement.howToGet} ` +
        `Put it in a .env file at the root of the server, as ` +
        `${requirement.variable}=your_key, and start the server again. ` +
        // True whatever else is configured, which is what lets it live in the
        // shared class. An earlier draft said "this one Tool alone needs it" —
        // a fact about the whole server, baked into a generic mechanism, that
        // the second Tool to adopt it would have turned into a false statement
        // published into the model's context.
        `Only Tools that need this variable are affected; the rest of the server works as usual.`,
    );
    this.name = "MissingConfigError";
    this.variable = requirement.variable;
    // Restore the prototype chain, as `page-fetch-error.ts` does and for the
    // same reason: `instanceof` is how `tool-failure.ts` decides to forward this.
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/**
 * The configured value, or a refusal naming what to set.
 *
 * Whitespace counts as unset. A `.env` line left as `PAGESPEED_API_KEY=` reads as
 * configured and is not, and passing it on produces a 400 from the far end —
 * which sends the Operator debugging Google's API rather than their own file.
 *
 * @throws {MissingConfigError} always safe to publish; see the module header.
 */
export function requireConfig(requirement: ConfigRequirement): string {
  const value = readOptionalConfig(requirement.variable);
  if (!value) throw new MissingConfigError(requirement);
  return value;
}

/**
 * A configured value, or `null`, with no refusal attached.
 *
 * For the variables that buy an **enrichment** rather than a capability — see the
 * module header. The Tool that reads one of these carries on without it and says
 * the signal was not evaluated.
 *
 * This is also the single seam through which `.env` is read, which is why
 * {@link requireConfig} goes through it too: an Operator should configure one
 * file, not one file for the required variables and something else for the
 * optional ones.
 */
export function readOptionalConfig(variable: string): string | null {
  loadEnvFile();
  return process.env[variable]?.trim() || null;
}
