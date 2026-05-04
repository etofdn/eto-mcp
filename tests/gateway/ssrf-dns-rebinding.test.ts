/**
 * FN-079 — DNS-rebinding SSRF guard tests.
 *
 * Verifies that `isPrivateOrLoopbackHostResolved` resolves the hostname
 * before the private-IP check, closing the bypass where a public-looking
 * domain resolves to 127.0.0.1 / 10.x / etc at request time.
 */
import { describe, it, expect } from "vitest";
import {
  isPrivateOrLoopbackHost,
  isPrivateOrLoopbackHostResolved,
  type DnsLookupFn,
} from "../../src/gateway/outbound-bpp.js";

function fakeLookup(map: Record<string, { address: string; family: 4 | 6 }>): DnsLookupFn {
  return async (h) => {
    const r = map[h];
    if (!r) throw new Error(`no fixture for ${h}`);
    return r;
  };
}

describe("FN-079 — DNS-resolving SSRF guard", () => {
  it("rejects literal private IPv4 (sync path still works)", () => {
    expect(isPrivateOrLoopbackHost("127.0.0.1")).toBe(true);
    expect(isPrivateOrLoopbackHost("10.0.0.5")).toBe(true);
    expect(isPrivateOrLoopbackHost("192.168.1.1")).toBe(true);
    expect(isPrivateOrLoopbackHost("169.254.1.1")).toBe(true);
  });

  it("rejects localhost / .local (sync path)", () => {
    expect(isPrivateOrLoopbackHost("localhost")).toBe(true);
    expect(isPrivateOrLoopbackHost("printer.local")).toBe(true);
  });

  it("allows public IP literal (sync allows, async confirms)", async () => {
    expect(isPrivateOrLoopbackHost("8.8.8.8")).toBe(false);
    const ok = await isPrivateOrLoopbackHostResolved("8.8.8.8", fakeLookup({}));
    expect(ok).toBe(false);
  });

  it("DNS rebinding: public-looking domain resolving to 127.0.0.1 is rejected", async () => {
    const lookup = fakeLookup({ "attacker.example.com": { address: "127.0.0.1", family: 4 } });
    const blocked = await isPrivateOrLoopbackHostResolved("attacker.example.com", lookup);
    expect(blocked).toBe(true);
  });

  it("DNS rebinding: domain resolving to 10.x is rejected", async () => {
    const lookup = fakeLookup({ "tricky.example.com": { address: "10.5.5.5", family: 4 } });
    expect(await isPrivateOrLoopbackHostResolved("tricky.example.com", lookup)).toBe(true);
  });

  it("DNS rebinding: domain resolving to ::1 is rejected", async () => {
    const lookup = fakeLookup({ "v6.example.com": { address: "::1", family: 6 } });
    expect(await isPrivateOrLoopbackHostResolved("v6.example.com", lookup)).toBe(true);
  });

  it("public domain resolving to 8.8.8.8 is allowed", async () => {
    const lookup = fakeLookup({ "google-public-dns.example.com": { address: "8.8.8.8", family: 4 } });
    expect(await isPrivateOrLoopbackHostResolved("google-public-dns.example.com", lookup)).toBe(false);
  });

  it("fail-closed: unresolvable hostname is treated as private", async () => {
    const lookup: DnsLookupFn = async () => { throw new Error("ENOTFOUND"); };
    expect(await isPrivateOrLoopbackHostResolved("nonexistent.invalid", lookup)).toBe(true);
  });
});
