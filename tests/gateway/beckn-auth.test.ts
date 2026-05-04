/**
 * Tests for FN-068 — Beckn HTTP-signature verifier (`beckn-auth.ts`).
 *
 * Covers the five acceptance cases specified in the task spec:
 *   1. valid signature        → ok
 *   2. bad signature          → BAD_SIGNATURE
 *   3. expired (created in
 *      past, expires in past) → EXPIRED_AUTH
 *   4. missing header         → MISSING_AUTH
 *   5. wrong algorithm        → WRONG_ALGORITHM
 *
 * Plus a few sanity cases (unknown key, malformed header, round-trip
 * with `signBecknAuthHeader`) to guard against regressions.
 */

import { describe, it, expect } from "vitest";
import * as ed from "@noble/ed25519";
import { sha512 } from "@noble/hashes/sha512";

import {
  verifyBecknAuthHeader,
  signBecknAuthHeader,
  parseBecknAuthHeader,
  blake512Base64,
  buildSigningString,
} from "../../src/gateway/beckn-auth.js";

// Same one-time setup the production module performs — needed here so
// `getPublicKey` derivation works in test bootstrap.
ed.etc.sha512Sync = (...m: Uint8Array[]) => sha512(ed.etc.concatBytes(...m));

// ---------- Fixtures ----------

const KEY_ID = "test-bap.example.com|key-1|ed25519";
const RAW_BODY = JSON.stringify({
  context: { domain: "retail", action: "search", version: "2.0.0" },
  message: { intent: { foo: "bar" } },
});

async function freshKeyPair(): Promise<{ priv: Uint8Array; pub: Uint8Array }> {
  // Deterministic 32-byte private key so failures are reproducible.
  const priv = new Uint8Array(32);
  for (let i = 0; i < 32; i++) priv[i] = (i * 7 + 13) & 0xff;
  const pub = await ed.getPublicKeyAsync(priv);
  return { priv, pub };
}

function registry(pub: Uint8Array, knownKeyId = KEY_ID) {
  return (keyId: string) => (keyId === knownKeyId ? pub : null);
}

// ---------- Acceptance cases ----------

describe("verifyBecknAuthHeader — FN-068 acceptance matrix", () => {
  it("(1) valid signature → ok with subscriber/uniqueKey extracted", async () => {
    const { priv, pub } = await freshKeyPair();
    const now = 1_700_000_000;
    const header = await signBecknAuthHeader({
      privateKey: priv,
      keyId: KEY_ID,
      rawBody: RAW_BODY,
      created: now - 5,
      expires: now + 60,
    });

    const result = verifyBecknAuthHeader(header, RAW_BODY, registry(pub), { now });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.keyId).toBe(KEY_ID);
      expect(result.subscriberId).toBe("test-bap.example.com");
      expect(result.uniqueKeyId).toBe("key-1");
    }
  });

  it("(2) bad signature → BAD_SIGNATURE", async () => {
    const { priv, pub } = await freshKeyPair();
    const now = 1_700_000_000;
    const goodHeader = await signBecknAuthHeader({
      privateKey: priv,
      keyId: KEY_ID,
      rawBody: RAW_BODY,
      created: now - 5,
      expires: now + 60,
    });

    // Tamper with the body — the digest will no longer match the one
    // the signer signed over, so the signature must fail.
    const tamperedBody = RAW_BODY.replace('"foo":"bar"', '"foo":"baz"');
    const result = verifyBecknAuthHeader(goodHeader, tamperedBody, registry(pub), { now });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("BAD_SIGNATURE");
    }
  });

  it("(3) expired (created/expires in the past) → EXPIRED_AUTH", async () => {
    const { priv, pub } = await freshKeyPair();
    const now = 1_700_000_000;
    // Sign with a window that is fully in the past relative to `now`.
    const header = await signBecknAuthHeader({
      privateKey: priv,
      keyId: KEY_ID,
      rawBody: RAW_BODY,
      created: now - 600,
      expires: now - 60,
    });

    const result = verifyBecknAuthHeader(header, RAW_BODY, registry(pub), { now });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("EXPIRED_AUTH");
    }
  });

  it("(4) missing header → MISSING_AUTH", async () => {
    const { pub } = await freshKeyPair();
    const result = verifyBecknAuthHeader(undefined, RAW_BODY, registry(pub));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("MISSING_AUTH");
    }

    const empty = verifyBecknAuthHeader("", RAW_BODY, registry(pub));
    expect(empty.ok).toBe(false);
    if (!empty.ok) {
      expect(empty.code).toBe("MISSING_AUTH");
    }
  });

  it("(5) wrong algorithm → WRONG_ALGORITHM", async () => {
    const { pub } = await freshKeyPair();
    const now = 1_700_000_000;
    // Hand-build a syntactically valid header that declares a non-ed25519 alg.
    const header =
      `Signature keyId="${KEY_ID}",algorithm="rsa-sha256",` +
      `created=${now - 5},expires=${now + 60},` +
      `headers="(created) (expires) digest",` +
      `signature="${"A".repeat(88)}"`;

    const result = verifyBecknAuthHeader(header, RAW_BODY, registry(pub), { now });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("WRONG_ALGORITHM");
    }
  });
});

// ---------- Extra coverage on parser + side branches ----------

describe("verifyBecknAuthHeader — sanity cases", () => {
  it("rejects unknown subscriber with UNKNOWN_KEY", async () => {
    const { priv, pub } = await freshKeyPair();
    const now = 1_700_000_000;
    const header = await signBecknAuthHeader({
      privateKey: priv,
      keyId: KEY_ID,
      rawBody: RAW_BODY,
      created: now - 5,
      expires: now + 60,
    });

    const result = verifyBecknAuthHeader(header, RAW_BODY, registry(pub, "not-this-key|x|ed25519"), { now });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("UNKNOWN_KEY");
    }
  });

  it("rejects malformed header structure with MALFORMED_AUTH", () => {
    const result = verifyBecknAuthHeader("totally bogus", RAW_BODY, () => null);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("MALFORMED_AUTH");
    }
  });

  it("rejects header missing the keyId field with MALFORMED_AUTH", () => {
    const header =
      `Signature algorithm="ed25519",created=1,expires=2,` +
      `headers="(created) (expires) digest",signature="AA=="`;
    const result = verifyBecknAuthHeader(header, RAW_BODY, () => null);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("MALFORMED_AUTH");
    }
  });
});

describe("parseBecknAuthHeader", () => {
  it("parses a canonical Beckn header with quoted values", () => {
    const h =
      `Signature keyId="sub|uk|ed25519",algorithm="ed25519",` +
      `created=100,expires=200,headers="(created) (expires) digest",signature="AA=="`;
    const p = parseBecknAuthHeader(h);
    expect(p).not.toBeNull();
    if (p) {
      expect(p.keyId).toBe("sub|uk|ed25519");
      expect(p.algorithm).toBe("ed25519");
      expect(p.created).toBe(100);
      expect(p.expires).toBe(200);
      expect(p.headers).toEqual(["(created)", "(expires)", "digest"]);
      expect(p.signature).toBe("AA==");
    }
  });

  it("returns null when required fields are absent", () => {
    expect(parseBecknAuthHeader("")).toBeNull();
    expect(parseBecknAuthHeader("Signature keyId=x")).toBeNull();
  });
});

describe("buildSigningString + blake512Base64", () => {
  it("matches the documented Beckn signing-string layout", () => {
    const digestB64 = blake512Base64("hello");
    const s = buildSigningString({ created: 1, expires: 2, digestB64 });
    expect(s).toBe(`(created): 1\n(expires): 2\ndigest: BLAKE-512=${digestB64}`);
  });

  it("produces stable digest for identical input", () => {
    expect(blake512Base64("hello")).toBe(blake512Base64("hello"));
    expect(blake512Base64("hello")).not.toBe(blake512Base64("hellp"));
  });
});
