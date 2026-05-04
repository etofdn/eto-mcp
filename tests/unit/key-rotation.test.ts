/**
 * Tests for Ed25519 key rotation primitives (FN-028).
 *
 * Test cases:
 *   1. Happy path: sign with kid A, verify against DID with keys [A, B].
 *   2. Rotation case: sign with kid B (new key), verify against DID with [A, B].
 *   3. Unknown-kid rejection: sign with kid C, verify against DID with [A, B].
 *   4. Bad-signature rejection: tampered JWS fails verification.
 *   5. Malformed JWS (wrong number of parts) rejected.
 *   6. buildVerificationMethod helper round-trips correctly.
 */

import { describe, test, expect } from "vitest";
import * as ed from "@noble/ed25519";
import { sha512 } from "@noble/hashes/sha512";
import {
  signWithKid,
  verifyWithDid,
  buildVerificationMethod,
  KeyRotationError,
  type DidDocument,
  type VerificationMethod,
} from "../../src/signing/key-rotation.js";

// Configure synchronous sha512 for @noble/ed25519 v2 (required).
ed.etc.sha512Sync = (...m: Uint8Array[]) => sha512(ed.etc.concatBytes(...m));

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

function makeKey(): Uint8Array {
  const key = new Uint8Array(32);
  crypto.getRandomValues(key);
  return key;
}

function makeDidDoc(methods: readonly VerificationMethod[]): DidDocument {
  return {
    "@context": [
      "https://www.w3.org/ns/did/v1",
      "https://w3id.org/security/suites/ed25519-2020/v1",
    ],
    id: "did:eto:test:123",
    verificationMethod: methods,
    authentication: methods.map((m) => m.id),
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("signWithKid + verifyWithDid", () => {
  test("happy path: sign with kid A, verify against DID with keys [A, B]", async () => {
    const privA = makeKey();
    const privB = makeKey();

    const vmA = buildVerificationMethod("did:eto:test:123#key-A", "did:eto:test:123", privA);
    const vmB = buildVerificationMethod("did:eto:test:123#key-B", "did:eto:test:123", privB);
    const didDoc = makeDidDoc([vmA, vmB]);

    const payload = { sub: "alice", event: "init", slot: 42 };
    const jws = await signWithKid(payload, privA, "did:eto:test:123#key-A");

    const result = await verifyWithDid(jws, didDoc);
    expect(result).toEqual(payload);
  });

  test("rotation case: sign with kid B (new key), verify against DID with [A, B]", async () => {
    const privA = makeKey();
    const privB = makeKey();

    const vmA = buildVerificationMethod("did:eto:test:123#key-A", "did:eto:test:123", privA);
    const vmB = buildVerificationMethod("did:eto:test:123#key-B", "did:eto:test:123", privB);
    const didDoc = makeDidDoc([vmA, vmB]);

    const payload = { sub: "bob", event: "confirm", slot: 99, amountUsd: 5000 };
    // Sign with the new (rotated-in) key B
    const jws = await signWithKid(payload, privB, "did:eto:test:123#key-B");

    const result = await verifyWithDid(jws, didDoc);
    expect(result).toEqual(payload);
  });

  test("unknown-kid rejection: sign with kid C, verify against DID with [A, B]", async () => {
    const privA = makeKey();
    const privB = makeKey();
    const privC = makeKey(); // key not in DID doc

    const vmA = buildVerificationMethod("did:eto:test:123#key-A", "did:eto:test:123", privA);
    const vmB = buildVerificationMethod("did:eto:test:123#key-B", "did:eto:test:123", privB);
    const didDoc = makeDidDoc([vmA, vmB]);

    const jws = await signWithKid({ data: "secret" }, privC, "did:eto:test:123#key-C");

    await expect(verifyWithDid(jws, didDoc)).rejects.toMatchObject({
      name: "KeyRotationError",
      code: "UNKNOWN_KID",
    });
  });

  test("bad-signature rejection: tampered payload fails verification", async () => {
    const privA = makeKey();
    const vmA = buildVerificationMethod("did:eto:test:123#key-A", "did:eto:test:123", privA);
    const didDoc = makeDidDoc([vmA]);

    const jws = await signWithKid({ amount: 100 }, privA, "did:eto:test:123#key-A");

    // Tamper: replace the payload part with a different base64url payload
    const parts = jws.split(".");
    const tamperedPayload = Buffer.from(JSON.stringify({ amount: 99999 })).toString("base64url");
    const tamperedJws = `${parts[0]}.${tamperedPayload}.${parts[2]}`;

    await expect(verifyWithDid(tamperedJws, didDoc)).rejects.toMatchObject({
      name: "KeyRotationError",
      code: "BAD_SIGNATURE",
    });
  });

  test("malformed JWS (wrong number of parts) is rejected", async () => {
    const privA = makeKey();
    const vmA = buildVerificationMethod("did:eto:test:123#key-A", "did:eto:test:123", privA);
    const didDoc = makeDidDoc([vmA]);

    // Only two parts — missing signature
    const badJws = "header.payload";
    await expect(verifyWithDid(badJws, didDoc)).rejects.toMatchObject({
      name: "KeyRotationError",
      code: "INVALID_JWS",
    });
  });

  test("missing kid in header is rejected", async () => {
    const privA = makeKey();
    const vmA = buildVerificationMethod("did:eto:test:123#key-A", "did:eto:test:123", privA);
    const didDoc = makeDidDoc([vmA]);

    // Build a JWS with a header that has no kid
    const header = Buffer.from(JSON.stringify({ alg: "EdDSA", typ: "JWT" })).toString("base64url");
    const body = Buffer.from(JSON.stringify({ data: 1 })).toString("base64url");
    const signingInput = new TextEncoder().encode(`${header}.${body}`);
    const sig = await ed.sign(signingInput, privA);
    const fakeJws = `${header}.${body}.${Buffer.from(sig).toString("base64url")}`;

    await expect(verifyWithDid(fakeJws, didDoc)).rejects.toMatchObject({
      name: "KeyRotationError",
      code: "INVALID_JWS",
    });
  });
});

describe("buildVerificationMethod", () => {
  test("returns correct type and controller", () => {
    const priv = makeKey();
    const vm = buildVerificationMethod("did:eto:test:1#key-1", "did:eto:test:1", priv);
    expect(vm.id).toBe("did:eto:test:1#key-1");
    expect(vm.type).toBe("Ed25519VerificationKey2020");
    expect(vm.controller).toBe("did:eto:test:1");
    expect(vm.publicKeyJwk.kty).toBe("OKP");
    expect(vm.publicKeyJwk.crv).toBe("Ed25519");
  });

  test("publicKeyJwk.x decodes to the correct 32-byte public key", () => {
    const priv = makeKey();
    const expectedPub = ed.getPublicKey(priv);
    const vm = buildVerificationMethod("did:eto:test:1#key-1", "did:eto:test:1", priv);
    const decoded = new Uint8Array(Buffer.from(vm.publicKeyJwk.x, "base64url"));
    expect(decoded).toEqual(expectedPub);
  });

  test("round-trip: sign with private key, verify using built VM", async () => {
    const priv = makeKey();
    const vm = buildVerificationMethod("did:eto:test:1#k", "did:eto:test:1", priv);
    const didDoc = makeDidDoc([vm]);
    const payload = { hello: "world" };
    const jws = await signWithKid(payload, priv, "did:eto:test:1#k");
    const result = await verifyWithDid(jws, didDoc);
    expect(result).toEqual(payload);
  });
});

describe("KeyRotationError", () => {
  test("has correct name and code", () => {
    const err = new KeyRotationError("UNKNOWN_KID", "not found");
    expect(err.name).toBe("KeyRotationError");
    expect(err.code).toBe("UNKNOWN_KID");
    expect(err.message).toBe("not found");
    expect(err instanceof Error).toBe(true);
  });

  test("carries detail when provided", () => {
    const err = new KeyRotationError("INVALID_JWS", "bad format", { parts: 2 });
    expect(err.detail).toEqual({ parts: 2 });
  });
});
