import { vi } from "vitest";

export type Route = { status?: number; body?: string; headers?: Record<string, string> };

/**
 * Replace `globalThis.fetch` with a route table.
 *
 * A URL matches a key when it contains it, so a test can name
 * `"example.com/robots.txt"` without restating the scheme. Anything unmatched is
 * a 404, because a test that forgot to declare a route should see the same thing
 * the Operator would see rather than a hang.
 */
export function serve(routes: Record<string, Route>): void {
  globalThis.fetch = vi.fn(async (input: Parameters<typeof fetch>[0]) => {
    const url =
      typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const hit = routes[url] ?? Object.entries(routes).find(([key]) => url.includes(key))?.[1];
    if (!hit) return new Response("Not Found", { status: 404 });
    return new Response(hit.body ?? "", {
      status: hit.status ?? 200,
      headers: new Headers({ "content-type": "text/plain; charset=utf-8", ...hit.headers }),
    });
  }) as unknown as typeof fetch;
}
