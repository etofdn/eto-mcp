// FN-049 — Session attestation JWS minter.
//
// Produces a compact-JWS (RFC 7515) signed by the server's Ed25519 key from
// `src/signing/server-key.ts`. The JWS body encodes a minimal attestation
// claim set tying the session identity to a model declaration.
//
// This module is intentionally decoupled from `src/gateway/auth.ts` to keep
// the attestation logic testable in isolation. `authenticate()` in auth.ts
// calls `mintSessionAttestation()` after verifying the session token for
// non-stdio, non-dev sessions.
//
// Attestation payload fields:
//   iss  — "eto-mcp" (fixed issuer)
//   sub  — session subject (from SessionPayload.sub)
//   jti  — session token id (from SessionPayload.jti)
//   aud  — "eto-agent" (fixed audience)
//   iat  — seconds since epoch, minted now
//   exp  — session expiry (from SessionPayload.exp)
//   model_id     — caller-declared model id (optional, string)
//   provider     — caller-declared provider  (optional, string)
//
// The JWS header carries `{ alg: "EdDSA", kid: <current-kid> }`.

import * as ed from "@noble/ed25519";
import { sha512 } from "@noble/hashes/sha512";
import {
  getServerSigningKey,
} from "../signing/server-key.js";
import { getCurrentKid } from "../signing/jwks.js";

// Ensure sha512Sync is installed (idempotent).
ed.etc.sha512Sync = (...m: Uint8Array[]) => sha512(ed.etc.concatBytes(...m));

/** RFC 7515 §2 base64url (no padding). */
function b64url(bytes: Uint8Array): string {
  return Buffer.from(bytes)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

function b64urlJson(obj: unknown): string {
  return b64url(new TextEncoder().encode(JSON.stringify(obj)));
}

export interface SessionAttestationInput {
  /** SessionPayload.sub */
  sub: string;
  /** SessionPayload.jti */
  jti: string;
  /** SessionPayload.exp (seconds since epoch) */
  exp: number;
  /** Caller-declared model id (optional) */
  model_id_declared?: string;
  /** Caller-declared provider (optional) */
  provider_declared?: string;
  /** Audience; defaults to "eto-agent" */
  aud?: string;
}

/** Compact-JWS attestation token. Verify with the server's published JWKS. */
export type SessionAttestationJws = string;

/**
 * Mint a compact-JWS session attestation signed by the server's Ed25519 key.
 *
 * Returns the JWS string. Throws only on signing failure (e.g., missing key
 * in production). Call-sites in `authenticate()` catch and fall back to null
 * to ensure auth never hard-fails due to attestation minting.
 */
export function mintSessionAttestation(
  input: SessionAttestationInput,
): SessionAttestationJws {
  const kid = getCurrentKid();

  const header = b64urlJson({ alg: "EdDSA", kid });

  const payload: Record<string, unknown> = {
    iss: "eto-mcp",
    sub: input.sub,
    jti: input.jti,
    aud: input.aud ?? "eto-agent",
    iat: Math.floor(Date.now() / 1000),
    exp: input.exp,
  };
  if (typeof input.model_id_declared === "string") {
    payload["model_id"] = input.model_id_declared;
  }
  if (typeof input.provider_declared === "string") {
    payload["provider"] = input.provider_declared;
  }

  const body = b64urlJson(payload);
  const signingInput = `${header}.${body}`;
  const signingInputBytes = new TextEncoder().encode(signingInput);

  const { privateKey } = getServerSigningKey();
  const sig = ed.sign(signingInputBytes, privateKey);

  return `${signingInput}.${b64url(sig)}`;
}
