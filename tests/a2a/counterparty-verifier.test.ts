/**
 * Tests for FN-052: A2A Counterparty Verifier
 *
 * All tests use injected fetch + cache — no network calls.
 */

import { describe, test, expect, beforeEach } from "vitest";
import * as ed from "@noble/ed25519";
import { sha512 } from "@noble/hashes/sha512";
import {
  verifyCounterpartyAttestation,
  type JwksCache,
  type Jwks,
} from "../../src/a2a/counterparty-verifier.js";

// Set up sha512Sync for noble/ed25519 in test environment
ed.etc.sha512Sync = (...m: Uint8Array[]) => sha512(ed.etc.concatBytes(...m));

/* -------------------------------------------------------------------------- */
/* Helpers                                                                     */
/* -------------------------------------------------------------------------- */

function base64urlEncode(bytes: Uint8Array): string {
  const b64 = btoa(String.fromCharCode(...bytes));
  return b64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=/g, "");
}

function base64urlEncodeStr(str: string): string {
  return base64urlEncode(new TextEncoder().encode(str));
}

async function makeJws(
  privKey: Uint8Array,
  kid: string,
  payload: Record<string, unknown>,
): Promise<string> {
  const header = base64urlEncodeStr(JSON.stringify({ alg: "EdDSA", typ: "JWT", kid }));
  const body = base64urlEncodeStr(JSON.stringify(payload));
  const signingInput = new TextEncoder().encode(`${header}.${body}`);
  const sig = await ed.signAsync(signingInput, privKey);
  return `${header}.${body}.${base64urlEncode(sig)}`;
}

function makeJwks(pubKey: Uint8Array, kid: string): Jwks {
  return {
    keys: [{ kty: "OKP", crv: "Ed25519", kid, x: base64urlEncode(pubKey) }],
  };
}

function makeFetch(jwks: Jwks, etag = "\"v1\""): typeof globalThis.fetch {
  return async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    if (url.endsWith("/.well-known/jwks.json")) {
      const ifNoneMatch = (init?.headers as Record<string, string> | undefined)?.["If-None-Match"];
      if (ifNoneMatch === etag) {
        return new Response(null, { status: 304, headers: { etag } });
      }
      return new Response(JSON.stringify(jwks), {
        status: 200,
        headers: { "content-type": "application/json", etag },
      });
    }
    return new Response("not found", { status: 404 });
  };
}

const PEER_ORIGIN = "https://peer.example.com";
const MY_ORIGIN = "https://me.example.com";
const JWKS_URL = `${PEER_ORIGIN}/.well-known/jwks.json`;
const NOW_SEC = 1_700_000_000;
const NOW_MS = NOW_SEC * 1000;

function makeNow(): () => number {
  return () => NOW_MS;
}

function basePayload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    iss: PEER_ORIGIN,
    aud: MY_ORIGIN,
    iat: NOW_SEC - 10,
    exp: NOW_SEC + 300,
    model: "claude-opus-4",
    model_version: "4.0",
    sig_alg: "EdDSA",
    jti: "test-nonce-1",
    ...overrides,
  };
}

/* -------------------------------------------------------------------------- */
/* Tests                                                                       */
/* -------------------------------------------------------------------------- */

describe("verifyCounterpartyAttestation", () => {
  let privKey: Uint8Array;
  let pubKey: Uint8Array;
  const KID = "key-1";

  beforeEach(async () => {
    privKey = new Uint8Array(32);
    crypto.getRandomValues(privKey);
    pubKey = await ed.getPublicKeyAsync(privKey);
  });

  test("happy path — returns ok:true with projected ModelAttestation", async () => {
    const jwks = makeJwks(pubKey, KID);
    const cache: JwksCache = new Map();
    const jws = await makeJws(privKey, KID, basePayload());

    const result = await verifyCounterpartyAttestation({
      jws,
      expectedAudience: MY_ORIGIN,
      jwksUrl: JWKS_URL,
      fetch: makeFetch(jwks),
      cache,
      now: makeNow(),
    });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected ok");

    expect(result.attestation.iss).toBe(PEER_ORIGIN);
    expect(result.attestation.aud).toBe(MY_ORIGIN);
    expect(result.attestation.model).toBe("claude-opus-4");
    expect(result.attestation.model_version).toBe("4.0");
    expect(result.attestation.sig_alg).toBe("EdDSA");
    expect(result.attestation.jti).toBe("test-nonce-1");
    expect(result.attestation.exp).toBe(NOW_SEC + 300);
  });

  test("bad-aud rejection — aud does not match expectedAudience", async () => {
    const jwks = makeJwks(pubKey, KID);
    const cache: JwksCache = new Map();
    const jws = await makeJws(privKey, KID, basePayload({ aud: "https://wrong.example.com" }));

    const result = await verifyCounterpartyAttestation({
      jws,
      expectedAudience: MY_ORIGIN,
      jwksUrl: JWKS_URL,
      fetch: makeFetch(jwks),
      cache,
      now: makeNow(),
    });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected error");
    expect(result.error.code).toBe("bad-aud");
    expect(result.error.message).toContain(MY_ORIGIN);
  });

  test("expired-jws rejection — exp is in the past", async () => {
    const jwks = makeJwks(pubKey, KID);
    const cache: JwksCache = new Map();
    // exp is 60 seconds before NOW
    const jws = await makeJws(privKey, KID, basePayload({ exp: NOW_SEC - 60 }));

    const result = await verifyCounterpartyAttestation({
      jws,
      expectedAudience: MY_ORIGIN,
      jwksUrl: JWKS_URL,
      fetch: makeFetch(jwks),
      cache,
      now: makeNow(),
    });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected error");
    expect(result.error.code).toBe("expired");
  });

  test("cache hit (304 Not Modified) — JWKS served from cache", async () => {
    const jwks = makeJwks(pubKey, KID);
    const cache: JwksCache = new Map();
    let fetchCallCount = 0;

    const trackingFetch: typeof globalThis.fetch = async (input, init) => {
      fetchCallCount++;
      return makeFetch(jwks)(input, init);
    };

    const args = {
      expectedAudience: MY_ORIGIN,
      jwksUrl: JWKS_URL,
      fetch: trackingFetch,
      cache,
      now: makeNow(),
    };

    // First call — populates cache with ETag
    const jws1 = await makeJws(privKey, KID, basePayload({ jti: "nonce-1" }));
    const r1 = await verifyCounterpartyAttestation({ ...args, jws: jws1 });
    expect(r1.ok).toBe(true);
    expect(fetchCallCount).toBe(1);

    // Second call — should send If-None-Match and get 304
    const jws2 = await makeJws(privKey, KID, basePayload({ jti: "nonce-2" }));
    const r2 = await verifyCounterpartyAttestation({ ...args, jws: jws2 });
    expect(r2.ok).toBe(true);
    expect(fetchCallCount).toBe(2); // fetch was called but returned 304

    // Verify cache has the entry (was served from cache after 304)
    const cached = cache.get(JWKS_URL);
    expect(cached).toBeDefined();
    expect(cached?.jwks).toEqual(jwks);
  });

  test("tampered-signature rejection — signature bytes altered", async () => {
    const jwks = makeJwks(pubKey, KID);
    const cache: JwksCache = new Map();
    const jws = await makeJws(privKey, KID, basePayload());

    // Tamper: flip a bit in the signature (last segment)
    const parts = jws.split(".");
    const sigBytes = Uint8Array.from(atob(
      (parts[2] ?? "").replace(/-/g, "+").replace(/_/g, "/")
    ), c => c.charCodeAt(0));
    sigBytes[0] ^= 0xff; // flip first byte
    const tamperedSig = btoa(String.fromCharCode(...sigBytes))
      .replace(/\+/g, "-").replace(/\//g, "_").replace(/=/g, "");
    const tamperedJws = `${parts[0]}.${parts[1]}.${tamperedSig}`;

    const result = await verifyCounterpartyAttestation({
      jws: tamperedJws,
      expectedAudience: MY_ORIGIN,
      jwksUrl: JWKS_URL,
      fetch: makeFetch(jwks),
      cache,
      now: makeNow(),
    });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected error");
    expect(result.error.code).toBe("tampered-signature");
  });
});
