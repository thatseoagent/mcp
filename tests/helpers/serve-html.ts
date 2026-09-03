/**
 * Re-exported from `serve.ts`, which is the one implementation now.
 *
 * This file was a second fetch stub: same idea, different matching rule,
 * different default content type, and a `restoreFetch` that captured
 * `globalThis.fetch` at module load and so restored whatever was current the
 * first time any file imported it. See `serve.ts` for the rest of that story.
 *
 * Kept as a re-export rather than deleted so the twenty-four files that import
 * from here do not all have to change to say the same thing.
 */
export { serveHtml, restoreFetch, serve, type Route, type FetchMock } from "./serve";
