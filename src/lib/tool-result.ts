/**
 * MCP tool-result helpers — the single place that shapes the `{ content, isError }`
 * payload every stateful (non-cached) tool returns. Cacheable tools go through
 * `withCache()`, which shapes results for them; the stateful tools (tasks, audit,
 * shared reports, GA4 listing) hand-built the same object dozens of times, which
 * made it easy to forget the `isError` flag on an error path. These two functions
 * make success vs. error explicit and impossible to confuse.
 */

type TextContent = { type: "text"; text: string };
export type ToolResult = { content: TextContent[]; isError?: true };

/** A successful text result. */
export function toolText(text: string): ToolResult {
  return { content: [{ type: "text", text }] };
}

/** An error text result — always carries `isError: true`. */
export function toolError(text: string): ToolResult {
  return { content: [{ type: "text", text }], isError: true };
}
