import { describe, it, expect } from "vitest";
import { connect } from "node:net";
import { awaitConsent } from "@/lib/google/login-flow";

/**
 * The consent round trip, driven the way a browser drives it.
 *
 * No Google account and no network: the listener is ours, the redirect is a
 * plain `fetch` at the URI it published, and the code is whatever the test says
 * it is. What is being checked is the half of OAuth this project actually owns.
 */

/** Is anything accepting connections on this port? */
function isListening(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect({ host: "127.0.0.1", port });
    socket.once("connect", () => {
      socket.destroy();
      resolve(true);
    });
    socket.once("error", () => resolve(false));
  });
}

function portOf(redirectUri: string): number {
  return Number(new URL(redirectUri).port);
}

describe("awaitConsent", () => {
  it("publishes a loopback redirect URI on a port nobody chose in advance", async () => {
    const listener = await awaitConsent();
    try {
      const url = new URL(listener.redirectUri);

      expect(url.hostname).toBe("127.0.0.1");
      expect(url.pathname).toBe("/callback");
      // Ephemeral, unlike the MCP port: this one exists for seconds and is told
      // to Google at the moment it is chosen, so it cannot collide with a running
      // server or a second login.
      expect(Number(url.port)).toBeGreaterThan(0);
    } finally {
      listener.stop();
    }
  });

  it("resolves with the code Google redirects back", async () => {
    const listener = await awaitConsent();

    await fetch(`${listener.redirectUri}?code=the-code&state=${listener.state}`);

    await expect(listener.code).resolves.toBe("the-code");
  });

  it("stops listening once the code is received", async () => {
    // An acceptance criterion, not housekeeping: a listener left running is an
    // unauthenticated endpoint on the Operator's machine that accepts an OAuth
    // code.
    const listener = await awaitConsent();
    const port = portOf(listener.redirectUri);

    expect(await isListening(port)).toBe(true);

    await fetch(`${listener.redirectUri}?code=the-code&state=${listener.state}`);
    await listener.code;

    expect(await isListening(port)).toBe(false);
  });

  it("ignores a request that does not carry the state it issued", async () => {
    // Loopback is reachable from any page the Operator's browser has open.
    // Without the check, whatever arrives first with a `code` gets exchanged.
    const listener = await awaitConsent();
    try {
      const response = await fetch(`${listener.redirectUri}?code=injected&state=wrong`);

      expect(response.status).toBe(400);
      // And it must not have settled the login: a stray request from another
      // page must not be able to cancel the Operator's consent either.
      const settled = await Promise.race([
        listener.code.then(() => "settled"),
        new Promise((resolve) => setTimeout(() => resolve("still waiting"), 50)),
      ]);
      expect(settled).toBe("still waiting");
    } finally {
      listener.stop();
    }
  });

  it("reports Google's own refusal rather than timing out", async () => {
    const listener = await awaitConsent();

    await fetch(`${listener.redirectUri}?error=access_denied&state=${listener.state}`);

    await expect(listener.code).rejects.toThrow(/access_denied/);
  });

  it("fails rather than waiting when the redirect carries no code", async () => {
    const listener = await awaitConsent();

    await fetch(`${listener.redirectUri}?state=${listener.state}`);

    await expect(listener.code).rejects.toThrow(/no authorization code/);
  });

  it("answers anything that is not the callback path with a 404", async () => {
    const listener = await awaitConsent();
    try {
      const base = new URL(listener.redirectUri).origin;

      expect((await fetch(`${base}/`)).status).toBe(404);
    } finally {
      listener.stop();
    }
  });

  it("leaves nothing listening when it is stopped without ever being used", async () => {
    // The abandoned-login path: the Operator hits Ctrl-C, or a check further
    // down the command throws.
    const listener = await awaitConsent();
    const port = portOf(listener.redirectUri);

    listener.stop();
    // Give the close a tick to take effect.
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(await isListening(port)).toBe(false);
  });
});
