/**
 * Diagnostics go to stderr, always.
 *
 * This was originally about protocol safety — over stdio, stdout *is* the
 * protocol, and a stray log line corrupts the connection. ADR-0004 moved the
 * server to HTTP, so that specific hazard is gone and the rule is kept for a
 * plainer reason: stdout is where a process says what it produced, stderr is
 * where it says how it went, and a server whose output stream is prose is a
 * server nobody can pipe.
 *
 * It stays a module rather than each caller reaching for `console` so there is
 * one import to grep for, and no judgement call at the call site.
 */
export function logError(context: string, error: unknown): void {
  const detail = error instanceof Error ? (error.stack ?? error.message) : String(error);
  process.stderr.write(`[${new Date().toISOString()}] ${context}: ${detail}\n`);
}
