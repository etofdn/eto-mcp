import { describe, it, expect, beforeEach } from "vitest";
import { createSession, type AuthStrategy } from "../../src/gateway/session.js";
import { authenticate } from "../../src/gateway/auth.js";
import { __resetForTests } from "../../src/signing/server-key.js";
import * as ed from "@noble/ed25519";
import { sha512 } from "@noble/hashes/sha512";

// Ensure sha512Sync is installed for tests.
ed.etc.sha512Sync = (...m: Uint8Array[]) => sha512(ed.etc.concatBytes(...m));

// Helpers
function makeToken(strategy: AuthStrategy, ttlSeconds = 3600): string {
  return createSession({
    userId: `user-${strategy}`,
    walletId: "wallet-1",
    network: "testnet",
    capabilities: ["wallet:read"],
    ttlSeconds,
    authStrategy: strategy,
  });
}

/** Decode a compact-JWS without verifying — for test assertions. */
function decodeJws(jws: string): { header: Record<string, unknown>; payload: Record<string, unknown> } {
  const [headerB64, payloadB64] = jws.split(".");
  const header = JSON.parse(Buffer.from(headerB64, "base64url").toString("utf8"));
  const payload = JSON.parse(Buffer.from(payloadB64, "base64url").toString("utf8"));
  return { header, payload };
}

beforeEach(() => {
  // Reset the server key so each test starts with a fresh ephemeral key.
  __resetForTests();
});

describe("FN-049: mintSessionAttestation via authenticate()", () => {
  it("mints a compact-JWS for a siwe session", () => {
    const token = makeToken("siwe");
    // authenticate() uses ambient bearer; supply explicit header.
    process.env["ETO_AUTH_DEV_BYPASS"] = ""; // ensure dev bypass is off in this test
    const ctx = authenticate(`Bearer ${token}`);
    expect(ctx.session_attestation_jws).not.toBeNull();
    const jws = ctx.session_attestation_jws!;
    expect(jws.split(".").length).toBe(3);
    const { header, payload } = decodeJws(jws);
    expect(header["alg"]).toBe("EdDSA");
    expect(typeof header["kid"]).toBe("string");
    expect(payload["iss"]).toBe("eto-mcp");
    expect(payload["sub"]).toBe("user-siwe");
    expect(payload["aud"]).toBe("eto-agent");
    expect(typeof payload["jti"]).toBe("string");
    expect(typeof payload["iat"]).toBe("number");
    expect(typeof payload["exp"]).toBe("number");
  });

  it("mints a JWS for inapp_email strategy", () => {
    const token = makeToken("inapp_email");
    const ctx = authenticate(`Bearer ${token}`);
    expect(ctx.session_attestation_jws).not.toBeNull();
    const { payload } = decodeJws(ctx.session_attestation_jws!);
    expect(payload["sub"]).toBe("user-inapp_email");
  });

  it("mints a JWS for inapp_oauth strategy", () => {
    const token = makeToken("inapp_oauth");
    const ctx = authenticate(`Bearer ${token}`);
    expect(ctx.session_attestation_jws).not.toBeNull();
    const { payload } = decodeJws(ctx.session_attestation_jws!);
    expect(payload["sub"]).toBe("user-inapp_oauth");
  });

  it("returns null session_attestation_jws for dev strategy (when devBypass off, dev token)", () => {
    const token = makeToken("dev");
    const ctx = authenticate(`Bearer ${token}`);
    // dev strategy sessions should not get a JWS
    expect(ctx.session_attestation_jws).toBeNull();
  });

  it("returns null session_attestation_jws for dev strategy token (no JWS for dev sessions)", () => {
    // dev strategy sessions don't get a JWS — already covered above by the
    // "dev strategy" test. Verify explicitly that dev-bypass auth also returns null
    // by checking the dev session constant exposed through a no-header call
    // when devBypass is active. Since we cannot easily toggle the singleton,
    // we verify indirectly: a token with auth_strategy "dev" returns null.
    const token = makeToken("dev");
    const ctx = authenticate(`Bearer ${token}`);
    expect(ctx.session_attestation_jws).toBeNull();
  });

  it("JWS signature is verifiable with the server public key", async () => {
    const token = makeToken("siwe");
    const ctx = authenticate(`Bearer ${token}`);
    const jws = ctx.session_attestation_jws!;
    const [headerB64, payloadB64, sigB64] = jws.split(".");
    const signingInput = new TextEncoder().encode(`${headerB64}.${payloadB64}`);
    const sig = new Uint8Array(Buffer.from(sigB64, "base64url"));
    // Import after reset so we get the same key instance
    const { getServerPublicKeyBytes } = await import("../../src/signing/server-key.js");
    const pubKey = getServerPublicKeyBytes();
    const valid = await ed.verify(sig, signingInput, pubKey);
    expect(valid).toBe(true);
  });
});
