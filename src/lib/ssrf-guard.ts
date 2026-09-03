/**
 * SSRF guard for server-side fetches of user-supplied URLs.
 *
 * Every Tool that fetches an Operator-supplied URL runs on the Operator's own
 * machine, which is exactly why the guard still matters: without it, a URL an
 * agent was talked into passing could point at `http://169.254.169.254/…`,
 * `http://localhost`, or any RFC-1918 host, and the server would fetch it and
 * echo the body back — reaching a router admin page, a local database, or a
 * cloud metadata endpoint that the Operator can see and the caller cannot.
 *
 * Defense:
 *   1. Only http/https schemes are allowed.
 *   2. The hostname is resolved via DNS and EVERY resolved address is checked
 *      against private / loopback / link-local / reserved ranges (IPv4 + IPv6,
 *      including IPv4-mapped IPv6). Literal-IP hosts are checked directly.
 *   3. Redirects are followed MANUALLY and the target of every hop is
 *      re-validated, so an attacker cannot use `http://evil/ → http://10.0.0.1/`
 *      to slip past the front-door check.
 *
 * Residual risk (accepted): DNS rebinding between the lookup here and the
 * kernel's connect() is theoretically possible. The lookup and fetch happen
 * within milliseconds, which makes the rebind window impractical for the tool
 * use-case; pinning the resolved IP at connect time is a future hardening.
 */

import { lookup } from "node:dns/promises";
import net from "node:net";

/** Hostnames that must never be fetched, independent of what they resolve to. */
const BLOCKED_HOSTNAMES = new Set([
  "metadata.google.internal",
  "metadata.goog",
]);

export class SsrfError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SsrfError";
  }
}

// ── IP range classification ──────────────────────────────────────────────────

function ipv4ToInt(ip: string): number | null {
  const parts = ip.split(".");
  if (parts.length !== 4) return null;
  let n = 0;
  for (const part of parts) {
    const octet = Number(part);
    if (!Number.isInteger(octet) || octet < 0 || octet > 255) return null;
    n = n * 256 + octet;
  }
  return n >>> 0;
}

function inRange(value: number, base: string, prefix: number): boolean {
  const baseInt = ipv4ToInt(base);
  if (baseInt === null) return false;
  const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
  return (value & mask) === (baseInt & mask);
}

function isBlockedIpv4(ip: string): boolean {
  const n = ipv4ToInt(ip);
  if (n === null) return true; // unparseable → treat as unsafe
  return (
    inRange(n, "0.0.0.0", 8) || // "this network"
    inRange(n, "10.0.0.0", 8) || // private
    inRange(n, "100.64.0.0", 10) || // CGNAT
    inRange(n, "127.0.0.0", 8) || // loopback
    inRange(n, "169.254.0.0", 16) || // link-local (cloud metadata)
    inRange(n, "172.16.0.0", 12) || // private
    inRange(n, "192.0.0.0", 24) || // IETF protocol assignments
    inRange(n, "192.0.2.0", 24) || // TEST-NET-1
    inRange(n, "192.168.0.0", 16) || // private
    inRange(n, "198.18.0.0", 15) || // benchmarking
    inRange(n, "198.51.100.0", 24) || // TEST-NET-2
    inRange(n, "203.0.113.0", 24) || // TEST-NET-3
    inRange(n, "224.0.0.0", 4) || // multicast
    inRange(n, "240.0.0.0", 4) // reserved + 255.255.255.255
  );
}

/**
 * Expand any valid IPv6 textual form into its 8 16-bit groups, resolving `::`
 * compression and a trailing embedded IPv4 (e.g. `::ffff:1.2.3.4`). Returns null
 * if the string can't be parsed. Callers treat null as unsafe.
 *
 * Doing this by value (not by string prefix/regex) is what closes the bypass
 * where `::ffff:7f00:1` (hex form of `::ffff:127.0.0.1`) or a NAT64/6to4 literal
 * embeds a private IPv4 that the old prefix matcher never saw.
 */
function expandIpv6Groups(input: string): number[] | null {
  let s = input.toLowerCase().split("%")[0]; // drop zone id

  // Fold a trailing embedded IPv4 into two hex groups.
  const v4 = s.match(/(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (v4) {
    const octets = v4.slice(1).map(Number);
    if (octets.some((o) => o > 255)) return null;
    const hi = ((octets[0] << 8) | octets[1]).toString(16);
    const lo = ((octets[2] << 8) | octets[3]).toString(16);
    s = s.slice(0, v4.index) + hi + ":" + lo;
  }

  const halves = s.split("::");
  if (halves.length > 2) return null;
  const toNums = (part: string) => (part ? part.split(":").map((h) => parseInt(h, 16)) : []);

  let groups: number[];
  if (halves.length === 1) {
    groups = toNums(halves[0]);
    if (groups.length !== 8) return null;
  } else {
    const left = toNums(halves[0]);
    const right = toNums(halves[1]);
    const fill = 8 - left.length - right.length;
    if (fill < 1) return null; // "::" must stand for at least one zero group
    groups = [...left, ...new Array(fill).fill(0), ...right];
  }
  if (groups.length !== 8 || groups.some((n) => !Number.isInteger(n) || n < 0 || n > 0xffff)) {
    return null;
  }
  return groups;
}

/** Render two consecutive IPv6 groups as a dotted IPv4 string for range checks. */
function groupsToIpv4(hi: number, lo: number): string {
  return `${(hi >> 8) & 0xff}.${hi & 0xff}.${(lo >> 8) & 0xff}.${lo & 0xff}`;
}

function isBlockedIpv6(ip: string): boolean {
  const g = expandIpv6Groups(ip);
  if (g === null) return true; // unparseable → treat as unsafe

  if (g.every((n) => n === 0)) return true; // :: unspecified
  if (g.slice(0, 7).every((n) => n === 0) && g[7] === 1) return true; // ::1 loopback

  // IPv4-mapped ::ffff:0:0/96 and (deprecated) IPv4-compatible ::/96 — check the
  // embedded IPv4 against the v4 ranges (all notations fold to the same groups).
  if (g[0] === 0 && g[1] === 0 && g[2] === 0 && g[3] === 0 && g[4] === 0 && (g[5] === 0xffff || g[5] === 0)) {
    return isBlockedIpv4(groupsToIpv4(g[6], g[7]));
  }
  // NAT64 64:ff9b::/96 — embedded IPv4 can target metadata/loopback.
  if (g[0] === 0x0064 && g[1] === 0xff9b && g[2] === 0 && g[3] === 0 && g[4] === 0 && g[5] === 0) {
    return isBlockedIpv4(groupsToIpv4(g[6], g[7]));
  }
  // 6to4 2002::/16 — embedded IPv4 is groups 1..2.
  if (g[0] === 0x2002) {
    return isBlockedIpv4(groupsToIpv4(g[1], g[2]));
  }

  if ((g[0] & 0xffc0) === 0xfe80) return true; // link-local fe80::/10
  if ((g[0] & 0xfe00) === 0xfc00) return true; // unique local fc00::/7
  if ((g[0] & 0xff00) === 0xff00) return true; // multicast ff00::/8
  return false;
}

/** True when an IP literal falls in a range we must never fetch. */
export function isBlockedAddress(ip: string): boolean {
  const family = net.isIP(ip);
  if (family === 4) return isBlockedIpv4(ip);
  if (family === 6) return isBlockedIpv6(ip);
  return true; // not a valid IP → unsafe
}

// ── URL validation ─────────────────────────────────────────────────────────

/**
 * Assert a URL is safe to fetch from the server. Throws {@link SsrfError} on
 * a disallowed scheme, a blocked hostname, or a hostname that resolves to a
 * private/loopback/link-local/reserved address. Returns the parsed URL.
 */
export async function assertUrlAllowed(rawUrl: string): Promise<URL> {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new SsrfError("Invalid URL");
  }

  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new SsrfError("Only http(s) URLs may be fetched");
  }

  // URL keeps IPv6 literals in brackets — strip them for classification.
  const hostname = parsed.hostname.replace(/^\[|\]$/g, "");
  if (BLOCKED_HOSTNAMES.has(hostname.toLowerCase())) {
    throw new SsrfError(`Blocked host: ${hostname}`);
  }

  if (net.isIP(hostname)) {
    if (isBlockedAddress(hostname)) {
      throw new SsrfError(`Refusing to fetch private/reserved address: ${hostname}`);
    }
    return parsed;
  }

  let addresses: { address: string }[];
  try {
    addresses = await lookup(hostname, { all: true });
  } catch {
    throw new SsrfError(`DNS resolution failed for ${hostname}`);
  }
  if (addresses.length === 0) {
    throw new SsrfError(`No DNS records for ${hostname}`);
  }
  for (const { address } of addresses) {
    if (isBlockedAddress(address)) {
      throw new SsrfError(`Host ${hostname} resolves to private/reserved address ${address}`);
    }
  }
  return parsed;
}

// ── Hardened fetch ───────────────────────────────────────────────────────────

const SENSITIVE_HEADERS = new Set(["authorization", "cookie", "proxy-authorization"]);

/** Drop credential-bearing headers from any HeadersInit, returning a plain object. */
function stripSensitiveHeaders(headers: HeadersInit | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!headers) return out;
  // `headers.forEach` rather than `[...headers.entries()]`: the bundler compiles
  // this against a lib set without `Headers.entries`, and its build error does
  // not fail the build, so the spread reached `dist/` broken and silent.
  const entries: [string, string][] = [];
  if (Array.isArray(headers)) {
    entries.push(...(headers as [string, string][]));
  } else if (headers instanceof Headers) {
    headers.forEach((value, key) => entries.push([key, value]));
  } else {
    entries.push(...Object.entries(headers as Record<string, string>));
  }
  for (const [k, v] of entries) {
    if (!SENSITIVE_HEADERS.has(k.toLowerCase())) out[k] = v;
  }
  return out;
}

export interface SafeFetchResult {
  response: Response;
  /** URL of the final hop after manual redirect following. */
  finalUrl: string;
  /** Number of redirects followed (0 = no redirect). */
  redirectCount: number;
}

/** How many redirect hops to follow before giving up. */
const MAX_REDIRECTS = 5;

export interface SafeFetchOptions {
  /**
   * Run before each hop, including the first, after the URL has been validated.
   *
   * This is where `http-client` puts the two obligations it owes a third-party
   * server — robots.txt and the pacing budget. They used to sit *above*
   * `safeFetch`, which meant one robots check and one pacing slot covered a
   * chain of up to six requests: the loop below re-ran `assertUrlAllowed` per hop
   * and nothing else. `crawl-pacing.ts` sizes its per-origin ceiling on the
   * belief that a fifty-page crawl "spends about sixty fetches counting
   * robots.txt and redirects", and redirects were not being counted.
   *
   * Optional, and that is load-bearing: `robots-gate` fetches robots.txt through
   * here and must not be asked for permission to do so — `robots-gate.ts` names
   * the non-termination. It passes no hook, so the exemption is structural.
   *
   * Throws to refuse, because a refusal is the whole answer to the caller's
   * question.
   */
  onHop?: (url: string) => Promise<void>;
}

/**
 * Fetch a URL with SSRF protection. Validates the initial URL and every
 * redirect target before connecting, following redirects MANUALLY so each hop
 * is checked. `init.redirect` is ignored — redirect policy is owned here.
 */
export async function safeFetch(
  rawUrl: string,
  init: RequestInit = {},
  options: SafeFetchOptions = {}
): Promise<SafeFetchResult> {
  const maxRedirects = MAX_REDIRECTS;
  let current = rawUrl;
  const initialOrigin = (() => {
    try { return new URL(rawUrl).origin; } catch { return null; }
  })();

  for (let hop = 0; hop <= maxRedirects; hop++) {
    await assertUrlAllowed(current);
    // After the SSRF check and before the connection, on every hop. A redirect
    // that leaves the origin lands on a server we have made no promises to yet,
    // and this is the only place that can tell there was a hop at all.
    await options.onHop?.(current);

    const crossOrigin = initialOrigin !== null && new URL(current).origin !== initialOrigin;
    // Never carry credentials to a different origin reached via redirect — a
    // redirect to an attacker host must not receive the caller's Authorization
    // or Cookie.
    const headers = crossOrigin
      ? stripSensitiveHeaders(init.headers)
      : (init.headers as Record<string, string> | undefined);

    const response = await fetch(current, { ...init, headers, redirect: "manual" });

    const status = response.status;
    const location = response.headers.get("location");
    if (status >= 300 && status < 400 && location) {
      if (hop === maxRedirects) {
        throw new SsrfError("Too many redirects");
      }
      // Resolve relative redirects against the current URL.
      current = new URL(location, current).href;
      continue;
    }

    return { response, finalUrl: current, redirectCount: hop };
  }

  // Unreachable — the loop returns or throws first.
  throw new SsrfError("Too many redirects");
}
