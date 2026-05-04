/**
 * Ed25519 key rotation primitives for audit-trail / travel-rule signing
 * (FN-028).
 *
 * **Scope.** This module provides three things:
 *   1. `DidDocument` — a minimal DID document type with a
 *      `verificationMethod[]` array (multi-key support).
 *   2. `signWithKid(payload, privateKey, kid)` — signs an arbitrary JSON
 *      payload as a compact JWS (base64url(header).base64url(payload).sig),
 *      embedding `kid` in the JOSE header so the verifier can resolve the
 *      right public key.
 *   3. `verifyWithDid(jws, didDoc)` — parses the JWS header, resolves
 *      `kid` → public key from the DID document's `verificationMethod`
 *      array, verifies the Ed25519 signature, and returns the decoded
 *      payload. Throws `KeyRotationError` on unknown kid or bad signature.
 *
 * **JWS header.** `{ alg: "EdDSA", kid: <kid>, typ: "JWT" }`
 *
 * **Public key encoding.** Verification methods use `publicKeyJwk`
 * (`{ kty: "OKP", crv: "Ed25519", x: base64url(rawPubKey32) }`) — the
 * JOSE-native form that avoids a multibase/multicodec dependency.
 *
 * **Why a standalone module.** The audit-trail and travel-rule documents
 * are explicitly unsigned in v0 (see the UNSIGNED caveats in each file).
 * This module ships the rotation primitives so downstream consumers can
 * wire signing in without any refactor of those files.
 */

import * as ed from "@noble/ed25519";
import { sha512 } from "@noble/hashes/sha512";

// Configure synchronous sha512 required by @noble/ed25519 v2.
ed.etc.sha512Sync = (...m: Uint8Array[]) => sha512(ed.etc.concatBytes(...m));

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export type KeyRotationErrorCode =
  | "UNKNOWN_KID"
  | "INVALID_JWS"
  | "INVALID_PUBKEY"
  | "BAD_SIGNATURE";

export class KeyRotationError extends Error {
  public override readonly name = "KeyRotationError";
  public readonly code: KeyRotationErrorCode;
  public readonly detail?: unknown;

  public constructor(
    code: KeyRotationErrorCode,
    message: string,
    detail?: unknown,
  ) {
    super(message);
    this.code = code;
    if (detail !== undefined) this.detail = detail;
  }
}

// ---------------------------------------------------------------------------
// DID document types
// ---------------------------------------------------------------------------

/**
 * A single Ed25519 verification method entry in a DID document.
 *
 * `id` is the key identifier (kid). `publicKeyJwk.x` is the raw 32-byte
 * public key encoded as base64url (no padding).
 */
export interface VerificationMethod {
  /** Key identifier, e.g. `"did:example:123#key-1"`. Used as the JWS `kid`. */
  id: string;
  /** MUST be `"Ed25519VerificationKey2020"`. */
  type: "Ed25519VerificationKey2020";
  /** The DID that controls this key. */
  controller: string;
  /** Public key in JWK form: `{ kty: "OKP", crv: "Ed25519", x: base64url }`. */
  publicKeyJwk: {
    kty: "OKP";
    crv: "Ed25519";
    /** Raw 32-byte public key, base64url-encoded (no padding). */
    x: string;
  };
}

/**
 * Minimal DID document supporting multi-key rotation.
 *
 * `verificationMethod` carries all active (and recently-retired) keys so
 * that JWS tokens signed under any listed kid can still be verified during
 * a rotation window.
 */
export interface DidDocument {
  "@context": readonly string[];
  id: string;
  verificationMethod: readonly VerificationMethod[];
  /** Authentication references — ids of verificationMethod entries. */
  authentication?: readonly string[];
}

// ---------------------------------------------------------------------------
// JWS helpers
// ---------------------------------------------------------------------------

function b64uEncode(bytes: Uint8Array): string {
  // Node 20+ Buffer.from().toString("base64url") strips padding automatically.
  return Buffer.from(bytes).toString("base64url");
}

function b64uDecode(s: string): Uint8Array {
  return new Uint8Array(Buffer.from(s, "base64url"));
}

function encodeJson(obj: unknown): string {
  return b64uEncode(new TextEncoder().encode(JSON.stringify(obj)));
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Sign `payload` with `privateKey` and embed `kid` in the JWS header.
 *
 * Returns a compact JWS string:
 *   `base64url(header) + "." + base64url(payload) + "." + base64url(sig)`
 *
 * where `header = { alg: "EdDSA", kid, typ: "JWT" }`.
 *
 * `payload` can be any JSON-serialisable value. The bytes signed are
 * `ascii(headerPart + "." + payloadPart)` (standard JWS signing input).
 */
export async function signWithKid(
  payload: unknown,
  privateKey: Uint8Array,
  kid: string,
): Promise<string> {
  const header = encodeJson({ alg: "EdDSA", kid, typ: "JWT" });
  const body = encodeJson(payload);
  const signingInput = new TextEncoder().encode(`${header}.${body}`);
  const sig = await ed.sign(signingInput, privateKey);
  return `${header}.${body}.${b64uEncode(sig)}`;
}

/**
 * Verify a compact JWS produced by `signWithKid` against a DID document.
 *
 * Steps:
 *   1. Split the JWS into header / payload / signature parts.
 *   2. Decode and parse the header; extract `kid`.
 *   3. Find the `verificationMethod` entry in `didDoc` whose `id === kid`.
 *   4. Decode `publicKeyJwk.x` to the raw 32-byte Ed25519 public key.
 *   5. Verify the signature over `header + "." + payload` bytes.
 *   6. Return the decoded payload as `unknown`.
 *
 * Throws `KeyRotationError` on:
 *   - Malformed JWS structure (`INVALID_JWS`)
 *   - No matching verificationMethod for `kid` (`UNKNOWN_KID`)
 *   - Malformed or wrong-length public key (`INVALID_PUBKEY`)
 *   - Signature verification failure (`BAD_SIGNATURE`)
 */
export async function verifyWithDid(
  jws: string,
  didDoc: DidDocument,
): Promise<unknown> {
  const parts = jws.split(".");
  if (parts.length !== 3) {
    throw new KeyRotationError(
      "INVALID_JWS",
      `JWS must have exactly 3 parts separated by '.'; got ${parts.length}`,
    );
  }

  const [headerPart, payloadPart, sigPart] = parts as [string, string, string];

  // Parse header.
  let header: Record<string, unknown>;
  try {
    header = JSON.parse(new TextDecoder().decode(b64uDecode(headerPart))) as Record<string, unknown>;
  } catch (e) {
    throw new KeyRotationError("INVALID_JWS", "failed to decode JWS header", e);
  }

  const kid = header["kid"];
  if (typeof kid !== "string" || kid.length === 0) {
    throw new KeyRotationError(
      "INVALID_JWS",
      "JWS header must contain a non-empty 'kid' string",
    );
  }

  // Resolve kid → verificationMethod.
  const method = didDoc.verificationMethod.find((vm) => vm.id === kid);
  if (method === undefined) {
    throw new KeyRotationError(
      "UNKNOWN_KID",
      `kid '${kid}' not found in DID document '${didDoc.id}'`,
      { kid, availableKids: didDoc.verificationMethod.map((vm) => vm.id) },
    );
  }

  // Decode the public key.
  let pubKey: Uint8Array;
  try {
    pubKey = b64uDecode(method.publicKeyJwk.x);
  } catch (e) {
    throw new KeyRotationError(
      "INVALID_PUBKEY",
      `failed to decode publicKeyJwk.x for kid '${kid}'`,
      e,
    );
  }
  if (pubKey.length !== 32) {
    throw new KeyRotationError(
      "INVALID_PUBKEY",
      `publicKeyJwk.x for kid '${kid}' decoded to ${pubKey.length} bytes; expected 32`,
    );
  }

  // Verify signature over the standard JWS signing input.
  const signingInput = new TextEncoder().encode(`${headerPart}.${payloadPart}`);
  let sig: Uint8Array;
  try {
    sig = b64uDecode(sigPart);
  } catch (e) {
    throw new KeyRotationError("INVALID_JWS", "failed to decode JWS signature", e);
  }

  const valid = await ed.verify(sig, signingInput, pubKey);
  if (!valid) {
    throw new KeyRotationError(
      "BAD_SIGNATURE",
      `Ed25519 signature verification failed for kid '${kid}'`,
    );
  }

  // Decode and return the payload.
  let decoded: unknown;
  try {
    decoded = JSON.parse(new TextDecoder().decode(b64uDecode(payloadPart)));
  } catch (e) {
    throw new KeyRotationError("INVALID_JWS", "failed to decode JWS payload", e);
  }
  return decoded;
}

// ---------------------------------------------------------------------------
// Helper: build a VerificationMethod from a raw Ed25519 private key
// ---------------------------------------------------------------------------

/**
 * Derive the `VerificationMethod` entry for a given private key and kid.
 *
 * Useful in tests and for DID document construction: given a raw 32-byte
 * Ed25519 private key, returns the `VerificationMethod` object that should
 * be placed in `didDoc.verificationMethod`.
 */
export function buildVerificationMethod(
  kid: string,
  controller: string,
  privateKey: Uint8Array,
): VerificationMethod {
  const pubKey = ed.getPublicKey(privateKey);
  return {
    id: kid,
    type: "Ed25519VerificationKey2020",
    controller,
    publicKeyJwk: {
      kty: "OKP",
      crv: "Ed25519",
      x: Buffer.from(pubKey).toString("base64url"),
    },
  };
}
