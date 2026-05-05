/**
 * Tests for `signWithJose` — the minimal compact-JWS / VC-JOSE proof suite
 * wrapper added to audit-trail.ts in FN-030.
 *
 * Test cases:
 *   1. Happy path: output is a 3-part base64url JWS with correct EdDSA header.
 *   2. Signature verifies against the corresponding public key.
 *   3. Tampered payload fails Ed25519 signature verification.
 *   4. Different keys produce different signatures for the same payload.
 */

import { describe, test, expect } from "vitest";
import * as ed from "@noble/ed25519";
import { sha512 } from "@noble/hashes/sha512";
import { signWithJose } from "../../src/services/indexer/audit-trail.js";

// Configure synchronous sha512 for @noble/ed25519 v2 (required).
ed.etc.sha512Sync = (...m: Uint8Array[]) => sha512(ed.etc.concatBytes(...m));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makePrivateKey(): Uint8Array {
  const k = new Uint8Array(32);
  crypto.getRandomValues(k);
  return k;
}

function b64uDecode(s: string): Uint8Array {
  return new Uint8Array(Buffer.from(s, "base64url"));
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("signWithJose (FN-030)", () => {
  test("produces a 3-part compact JWS with alg=EdDSA header", async () => {
    const key = makePrivateKey();
    const payload = { sub: "did:eto:agent:test", iat: 1_700_000_000 };

    const jws = await signWithJose(payload, key);

    const parts = jws.split(".");
    expect(parts).toHaveLength(3);

    const header = JSON.parse(Buffer.from(parts[0]!, "base64url").toString());
    expect(header.alg).toBe("EdDSA");
    expect(header.typ).toBe("JWT");

    const decoded = JSON.parse(Buffer.from(parts[1]!, "base64url").toString());
    expect(decoded).toEqual(payload);
  });

  test("signature verifies against the Ed25519 public key", async () => {
    const privateKey = makePrivateKey();
    const publicKey = await ed.getPublicKeyAsync(privateKey);
    const payload = { iss: "did:eto:indexer:audit-trail:v0", claim: "test" };

    const jws = await signWithJose(payload, privateKey);

    const parts = jws.split(".");
    expect(parts).toHaveLength(3);

    const signingInput = new TextEncoder().encode(`${parts[0]}.${parts[1]}`);
    const sig = b64uDecode(parts[2]!);

    const valid = await ed.verifyAsync(sig, signingInput, publicKey);
    expect(valid).toBe(true);
  });

  test("tampered payload fails signature verification", async () => {
    const privateKey = makePrivateKey();
    const publicKey = await ed.getPublicKeyAsync(privateKey);
    const payload = { iss: "legit", data: "original" };

    const jws = await signWithJose(payload, privateKey);
    const parts = jws.split(".");

    // Replace payload part with a tampered base64url-encoded object.
    const tampered = Buffer.from(
      JSON.stringify({ iss: "legit", data: "tampered" }),
    ).toString("base64url");
    const tamperedParts = [parts[0], tampered, parts[2]];

    const signingInput = new TextEncoder().encode(
      `${tamperedParts[0]}.${tamperedParts[1]}`,
    );
    const sig = b64uDecode(tamperedParts[2]!);

    const valid = await ed.verifyAsync(sig, signingInput, publicKey);
    expect(valid).toBe(false);
  });

  test("different keys produce different signatures for the same payload", async () => {
    const key1 = makePrivateKey();
    const key2 = makePrivateKey();
    const payload = { claim: "shared-payload" };

    const jws1 = await signWithJose(payload, key1);
    const jws2 = await signWithJose(payload, key2);

    // Header and payload parts are deterministic (same JSON), but signatures differ.
    const [h1, p1, s1] = jws1.split(".");
    const [h2, p2, s2] = jws2.split(".");
    expect(h1).toBe(h2);
    expect(p1).toBe(p2);
    expect(s1).not.toBe(s2);
  });
});
