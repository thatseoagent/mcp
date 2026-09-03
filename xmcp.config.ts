import { type XmcpConfig } from "xmcp";
import { HTTP_HOST, HTTP_PORT, HTTP_ENDPOINT } from "./src/lib/server-address";
import { SERVER_INSTRUCTIONS } from "./src/lib/server-instructions";

const config: XmcpConfig = {
  // What a client sees in the handshake.
  template: {
    name: "thatseoagent-mcp",
    description: "SEO analysis tools: crawlability, structured data, Search Console and Analytics.",
    // Delivered in the handshake, so an agent orients itself before its first
    // call rather than picking Tools by name-matching the request.
    instructions: SERVER_INSTRUCTIONS,
    // The page at `/`, which is not part of the MCP protocol — a client only
    // ever talks to `/mcp`. It exists for the person who pasted the URL into a
    // browser after `pnpm start`, and xmcp's default page describes xmcp rather
    // than this server.
    //
    // A path rather than an inline string, and generated rather than
    // hand-written. This config is compiled in a sandbox with no `node:fs`, so
    // it cannot count the Tools itself; `scripts/build-home-page.mjs` does that
    // and writes the file, the same way `drizzle/` is generated and committed.
    //
    // It lives in `public/` and **not** in `src/`, which is load-bearing rather
    // than tidy: `xmcp dev` watches `src/`, and a `homePage` inside it makes the
    // watcher fire a second compile the moment the first finishes — that pass
    // races the entry write and fails with `Can't resolve .xmcp/http.js`, then
    // the server starts before `dist/http.js` exists and crashes with
    // `MODULE_NOT_FOUND`. Dev recovers on the retry, so it looks like noise; it
    // is not, and it is entirely avoided by keeping the file out of `src/`.
    homePage: "public/home.html",
  },
  // HTTP. ADR-0004 supersedes ADR-0001 and records why.
  //
  // Nothing here reads `process.env`. This file is evaluated when the bundle is
  // *built*, not when the server runs, so an env read here bakes the build
  // machine's value into the artifact — it looks configurable and silently is
  // not. See `src/lib/server-address.ts`.
  http: {
    host: HTTP_HOST,
    port: HTTP_PORT,
    endpoint: HTTP_ENDPOINT,
    // No cross-origin access, and this is the server's only defence.
    //
    // There is no authentication: the endpoint is loopback-only and answers
    // whatever reaches it, which is reasonable for a server running on the
    // Operator's own machine. But xmcp's default is `origin: "*"`, and loopback
    // is reachable from a browser — so with that default any web page the
    // Operator visits could drive their Tools, using their Google credentials,
    // from JavaScript. Refusing cross-origin requests is what closes that, and
    // it costs an MCP client nothing: those are not browsers and do not send an
    // Origin header.
    cors: { origin: false },
  },
  /**
   * `better-sqlite3` must not be bundled.
   *
   * It is a native module: the JavaScript wrapper resolves
   * `build/Release/better_sqlite3.node` relative to its own location inside
   * `node_modules`. Inlined into `dist/http.js`, that lookup becomes
   * `<repo>/build/Release/better_sqlite3.node`, which does not exist — and the
   * failure is quiet, because `openDatabase()` catches it and the server carries
   * on with persistence disabled. Every Tool still answers; nothing is ever
   * cached and no history is ever written, on a server that reports itself as
   * having no database.
   *
   * Left external, the bundle `require`s it at runtime from `node_modules`,
   * which sits beside `dist/`.
   */
  bundler: (config) => {
    const externals = config.externals;
    config.externals = [
      ...(Array.isArray(externals) ? externals : externals ? [externals] : []),
      { "better-sqlite3": "commonjs better-sqlite3" },
    ];
    return config;
  },
  paths: {
    tools: "./src/tools",
    // The playbooks reference Tools by name, so these could only land once those
    // names were real and final. A test asserts every name they mention exists.
    prompts: "./src/prompts",
    resources: "./src/resources",
  },
};

export default config;
