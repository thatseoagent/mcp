/**
 * Where the server listens. **Build-time constants, not runtime configuration.**
 *
 * `xmcp.config.ts` is evaluated when the bundle is built, so these values are
 * compiled into `dist/`. Changing one means rebuilding; there is no environment
 * variable that moves the listener afterwards. (`PORT` does appear in the bundle,
 * but it belongs to a dependency and does not reach the listener — it was
 * mistaken for a runtime knob once already.)
 *
 * The values live in `server-address.json` rather than in this file, and that is
 * the one thing here worth explaining. `scripts/start.mjs` has to know the
 * address in order to refuse a busy port *before* the bundle loads, and it is
 * plain Node run straight from disk — it cannot import TypeScript. A second copy
 * of the port in the launcher is the copy that eventually disagrees with the
 * build, and the failure it produces is exactly the one #18 is about: a client
 * pointed at an address nothing is serving. JSON is the one format both readers
 * have.
 *
 * This module stays as the typed front door, so the config and the tests address
 * the server by importing the same values it was built with instead of restating
 * them.
 */
import address from "./server-address.json";

/** Loopback. Exposing the server beyond this machine should be deliberate. */
export const HTTP_HOST: string = address.host;

/**
 * Not 3000, because of what xmcp does when the port is taken: it does **not**
 * fail, it increments — "Port 3737 is in use, trying 3738 instead" — and serves
 * happily from the new one.
 *
 * That is worse than a crash. An MCP client is configured with a fixed URL, so a
 * server that quietly moves is a server the client can no longer reach, and the
 * only sign is a connection refused on the client's side with a healthy server
 * sitting next to it.
 *
 * Picking a port nothing else wants lowers the odds and fixes nothing, so it is
 * no longer the whole defence: `scripts/start.mjs` refuses to start on a busy
 * port and verifies after startup that the listener is on this exact number.
 */
export const HTTP_PORT: number = address.port;

export const HTTP_ENDPOINT: string = address.endpoint;

export const MCP_URL = `http://${HTTP_HOST}:${HTTP_PORT}${HTTP_ENDPOINT}`;
