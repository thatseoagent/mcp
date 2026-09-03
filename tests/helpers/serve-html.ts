import { vi } from "vitest";

type FetchInput = Parameters<typeof fetch>[0];

function urlOf(input: FetchInput): string {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.toString();
  return input.url;
}

/**
 * Replace `globalThis.fetch` with a stub that serves the given bodies by URL and
 * 404s everything else, so a request to an unexpected URL fails the test instead
 * of quietly passing. Restore with `restoreFetch()` in `afterEach`.
 *
 * Keys are matched exactly first, then by suffix, so `"/robots.txt"` serves any
 * origin's robots file while a full URL pins one page.
 */
export function serveHtml(bodies: Record<string, string>): void {
  globalThis.fetch = vi.fn(async (input: FetchInput) => {
    const url = urlOf(input);
    const body =
      bodies[url] ??
      Object.entries(bodies).find(([key]) => url.endsWith(key))?.[1];

    if (body === undefined) return new Response("Not Found", { status: 404 });

    return new Response(body, {
      status: 200,
      headers: { "Content-Type": "text/html; charset=utf-8" },
    });
  }) as unknown as typeof fetch;
}

const originalFetch = globalThis.fetch;

export function restoreFetch(): void {
  globalThis.fetch = originalFetch;
}
