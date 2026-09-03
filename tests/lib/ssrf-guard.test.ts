import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock DNS resolution so hostname tests are deterministic and offline.
const lookupMock = vi.fn();
vi.mock("node:dns/promises", () => ({
  lookup: (...args: unknown[]) => lookupMock(...args),
}));

import { isBlockedAddress, assertUrlAllowed, SsrfError } from "@/lib/ssrf-guard";

describe("isBlockedAddress", () => {
  it("blocks IPv4 loopback / private / link-local / reserved ranges", () => {
    for (const ip of [
      "127.0.0.1",
      "169.254.169.254", // cloud metadata
      "10.0.0.1",
      "172.16.0.1",
      "172.31.255.255",
      "192.168.1.1",
      "100.64.0.1", // CGNAT
      "0.0.0.0",
      "224.0.0.1", // multicast
      "255.255.255.255",
    ]) {
      expect(isBlockedAddress(ip), ip).toBe(true);
    }
  });

  it("allows ordinary public IPv4", () => {
    for (const ip of ["8.8.8.8", "1.1.1.1", "172.15.0.1", "172.32.0.1", "93.184.216.34"]) {
      expect(isBlockedAddress(ip), ip).toBe(false);
    }
  });

  it("blocks IPv6 loopback / ULA / link-local and IPv4-mapped metadata", () => {
    for (const ip of ["::1", "::", "fc00::1", "fd12::1", "fe80::1", "ff02::1", "::ffff:169.254.169.254", "::ffff:127.0.0.1"]) {
      expect(isBlockedAddress(ip), ip).toBe(true);
    }
  });

  it("blocks IPv4-mapped/embedded literals in hex and alternate notations", () => {
    for (const ip of [
      "::ffff:7f00:1", // hex form of ::ffff:127.0.0.1 (loopback)
      "::ffff:a9fe:a9fe", // hex form of ::ffff:169.254.169.254 (metadata)
      "0:0:0:0:0:ffff:7f00:1", // fully expanded mapped loopback
      "64:ff9b::a9fe:a9fe", // NAT64-wrapped metadata
      "64:ff9b::169.254.169.254", // NAT64 with dotted v4
      "2002:7f00:1::", // 6to4-wrapped 127.0.0.1
      "::7f00:1", // deprecated IPv4-compatible loopback
    ]) {
      expect(isBlockedAddress(ip), ip).toBe(true);
    }
  });

  it("allows public IPv6 and treats non-IPs as unsafe", () => {
    expect(isBlockedAddress("2606:4700:4700::1111")).toBe(false); // Cloudflare
    expect(isBlockedAddress("2002:5db8:d822::1")).toBe(false); // 6to4 wrapping a public v4 (93.184...)
    expect(isBlockedAddress("not-an-ip")).toBe(true);
  });
});

describe("assertUrlAllowed", () => {
  beforeEach(() => lookupMock.mockReset());

  it("rejects non-http(s) schemes", async () => {
    await expect(assertUrlAllowed("file:///etc/passwd")).rejects.toBeInstanceOf(SsrfError);
    await expect(assertUrlAllowed("ftp://example.com")).rejects.toBeInstanceOf(SsrfError);
  });

  it("rejects blocked literal-IP hosts without touching DNS", async () => {
    await expect(assertUrlAllowed("http://169.254.169.254/latest/meta-data/")).rejects.toBeInstanceOf(SsrfError);
    await expect(assertUrlAllowed("http://[::1]:8080/")).rejects.toBeInstanceOf(SsrfError);
    expect(lookupMock).not.toHaveBeenCalled();
  });

  it("rejects the cloud-metadata hostname explicitly", async () => {
    await expect(assertUrlAllowed("http://metadata.google.internal/")).rejects.toBeInstanceOf(SsrfError);
  });

  it("rejects a public hostname that resolves to a private address", async () => {
    lookupMock.mockResolvedValue([{ address: "10.0.0.5", family: 4 }]);
    await expect(assertUrlAllowed("http://rebind.evil.com/")).rejects.toBeInstanceOf(SsrfError);
  });

  it("allows a public hostname resolving to public addresses", async () => {
    lookupMock.mockResolvedValue([{ address: "93.184.216.34", family: 4 }]);
    const url = await assertUrlAllowed("https://example.com/path");
    expect(url.hostname).toBe("example.com");
  });

  it("rejects when every resolved address is private even if one is public", async () => {
    lookupMock.mockResolvedValue([
      { address: "93.184.216.34", family: 4 },
      { address: "127.0.0.1", family: 4 },
    ]);
    await expect(assertUrlAllowed("http://mixed.example.com/")).rejects.toBeInstanceOf(SsrfError);
  });
});
