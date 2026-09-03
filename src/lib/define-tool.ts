/**
 * The one seam that reaches every Tool.
 *
 * The retired server had this as a wrapper around the SDK's registration call,
 * which meant a Tool could not be registered without passing through it. xmcp
 * discovers Tools from the filesystem and exposes no registration hook, so the
 * seam has to be applied by each Tool to its own handler instead. That is weaker
 * — a Tool can forget — which is why every Tool test asserts the behaviour this
 * provides rather than trusting the wrapper to be present.
 *
 * What it does today is convert a thrown error into a Tool result. That matters
 * more than it looks: an exception escaping a handler surfaces to the agent as a
 * transport failure, which it cannot relay or recover from, instead of as text it
 * can read out and act on.
 *
 * It also exists to have somewhere for the next cross-cutting concern to go —
 * caching, timing, tracing — without threading it through every Tool by hand.
 */
import { toolFailure } from "./tool-failure";
import { type ToolResult } from "./tool-result";
import { withCache, type CacheOptions, type Refreshable } from "./with-cache";
import { createGoogleReader } from "./google/live-reader";
import type { GoogleReader } from "./google/reader";

/**
 * Wrap a Tool handler.
 *
 * @param context what the Tool was trying to do, in the Operator's terms, written
 *                to complete the sentence "Could not …".
 */
export function defineTool<Args>(
  context: string,
  handler: (args: Args) => Promise<ToolResult>,
): (args: Args) => Promise<ToolResult> {
  return async (args: Args) => {
    try {
      return await handler(args);
    } catch (error) {
      return toolFailure(error, context);
    }
  };
}

/**
 * {@link defineTool}, with the Tool cache in the middle.
 *
 * One function rather than `defineTool(ctx, withCache(opts, handler))` written
 * out at each of the seventeen Tools that fetch something, because the order of
 * the two wrappers is load-bearing and nothing at a call site would reveal it:
 * the cache has to sit **inside** the failure seam, so a database error is
 * rendered as a Tool result rather than escaping as a transport failure — and so
 * a handler that throws is never written to the cache as if it had succeeded.
 *
 * The Tool that does not use this is `seo_schema_generator`, which builds JSON-LD
 * from its arguments and fetches nothing. There is no crawl to save.
 */
export function defineCachedTool<Args extends Refreshable>(
  context: string,
  cache: CacheOptions<Args>,
  handler: (args: Args) => Promise<ToolResult>,
): (args: Omit<Args, "force_refresh"> & Refreshable) => Promise<ToolResult> {
  // The returned signature makes `force_refresh` optional, which the schema
  // already says it is. xmcp's `InferSchema` types an optional Zod field as a
  // *required* key whose value may be undefined, so without this every direct
  // caller — every Tool test — would have to pass `force_refresh: undefined` to
  // satisfy the compiler about an argument the Tool does not need.
  return defineTool(context, withCache(cache, handler)) as (
    args: Omit<Args, "force_refresh"> & Refreshable,
  ) => Promise<ToolResult>;
}

/**
 * A Tool that reads the Operator's Google data.
 *
 * The handler is **handed** its {@link GoogleReader} rather than reaching for
 * one, which is the whole point of #9: a Tool that fetches its own auth client
 * can only be tested with a Google account, a project and a verified property,
 * which is why the retired suite covered these Tools worst. Export the handler
 * from the Tool module and a test can call it with `fakeGoogleReader()`.
 *
 * `createGoogleReader()` itself does not authenticate — the reader asks for a
 * token per request — so building it is free and cannot fail. The refusal an
 * Operator who has not logged in sees comes from `accessToken()` on the first
 * actual read, as a `MissingConfigError` naming the login command. That is
 * ADR-0003 arriving from the one place that can tell, and it is why the Tool
 * stays listed and answers with text rather than vanishing or throwing.
 */
export function defineGoogleTool<Args extends Refreshable>(
  context: string,
  cache: CacheOptions<Args>,
  handler: (args: Args, google: GoogleReader) => Promise<ToolResult>,
): (args: Omit<Args, "force_refresh"> & Refreshable) => Promise<ToolResult> {
  return defineCachedTool(context, cache, (args: Args) => handler(args, createGoogleReader()));
}
