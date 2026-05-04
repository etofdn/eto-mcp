/**
 * A2A Counterparty Verifier — FN-052
 *
 * Reference module: how an A2A peer fetches a remote MCP origin's JWKS,
 * verifies a `model_attestation_jws` compact JWS, checks the `aud` claim,
 * and projects the result into a `ModelAttestation` value.
 *
 * Consumed by FN-060 A2A wire format. All crypto is Ed25519 via @noble/ed25519.
 *
 * JWS payload shape (standard JWT claims + model fields):
 * {
 *   iss: string;           // issuing MCP origin (e.g. "https://peer.example.com")
 *   aud: string;           // intended recipient MCP origin — MUST equal expectedAudience
 *   iat: number;           // issued-at (Unix seconds)
 *   exp: number;           // expiry (Unix seconds)
 *   jti?: string;          // optional nonce / replay protection
 *   model: string;         // model identifier (e.g. "claude-opus-4")
 *   model_version?: string;
 *   sig_alg?: string;      // e.g. "EdDSA"
 * }
 */

import * as ed from "@noble/ed25519";

/* -------------------------------------------------------------------------- */
/* Public types                                                                */
/* -------------------------------------------------------------------------- */

export interface ModelAttestation {
  readonly iss: string;
  readonly aud: string;
  readonly iat: number;
  readonly exp: number;
  readonly jti?: string;
  readonly model: string;
  readonly model_version?: string;
  readonly sig_alg?: string;
}

export type VerifyErrorCode =
  | "malformed-jws"
  | "unknown-kid"
  | "bad-aud"
  | "expired"
  | "tampered-signature"
  | "jwks-fetch-failed";

export interface VerifyError {
  readonly code: VerifyErrorCode;
  readonly message: string;
}

export type VerifyResult =
  | { readonly ok: true; readonly attestation: ModelAttestation }
  | { readonly ok: false; readonly error: VerifyError };

/* -------------------------------------------------------------------------- */
/* JWKS types                                                                  */
/* -------------------------------------------------------------------------- */

export interface JwkEd25519 {
  readonly kty: string;
  readonly crv: string;
  readonly kid: string;
  readonly x: string; // base64url-encoded 32-byte public key
}

export interface Jwks {
  readonly keys: JwkEd25519[];
}

/* -------------------------------------------------------------------------- */
/* Cache                                                                       */
/* -------------------------------------------------------------------------- */

export interface JwksCacheEntry {
  etag?: string;
  jwks: Jwks;
  fetchedAt: number;
}

/** Pass a shared Map instance across calls to enable ETag / 304 caching. */
export type JwksCache = Map<string, JwksCacheEntry>;

/* -------------------------------------------------------------------------- */
/* Deps interface                                                              */
/* -------------------------------------------------------------------------- */

export interface VerifierDeps {
  /** Injected fetch so tests don't hit the network. */
  readonly fetch: typeof globalThis.fetch;
  /** Shared JWKS cache across calls. Create once and reuse. */
  readonly cache: JwksCache;
  /** Clock injection for expiry checks. Defaults to () => Date.now(). */
  readonly now?: () => number;
}

/* -------------------------------------------------------------------------- */
/* Base64url helpers                                                           */
/* -------------------------------------------------------------------------- */

function base64urlDecode(input: string): Uint8Array {
  // Convert base64url → base64, then decode
  const b64 = input.replace(/-/g, "+").replace(/_/g, "/");
  const padded = b64.padEnd(b64.length + ((4 - (b64.length % 4)) % 4), "=");
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

function base64urlDecodeToString(input: string): string | null {
  try {
    const bytes = base64urlDecode(input);
    return new TextDecoder().decode(bytes);
  } catch {
    return null;
  }
}

/* -------------------------------------------------------------------------- */
/* JWS parsing                                                                 */
/* -------------------------------------------------------------------------- */

interface ParsedJws {
  header: Record<string, unknown>;
  payload: Record<string, unknown>;
  signingInput: Uint8Array;
  signature: Uint8Array;
}

function parseJwsCompact(jws: string): ParsedJws | null {
  const parts = jws.split(".");
  if (parts.length !== 3) return null;

  const [headerB64, payloadB64, sigB64] = parts;
  if (!headerB64 || !payloadB64 || !sigB64) return null;

  const headerStr = base64urlDecodeToString(headerB64);
  if (!headerStr) return null;

  const payloadStr = base64urlDecodeToString(payloadB64);
  if (!payloadStr) return null;

  let header: Record<string, unknown>;
  let payload: Record<string, unknown>;

  try {
    header = JSON.parse(headerStr) as Record<string, unknown>;
  } catch {
    return null;
  }

  try {
    payload = JSON.parse(payloadStr) as Record<string, unknown>;
  } catch {
    return null;
  }

  let signature: Uint8Array;
  try {
    signature = base64urlDecode(sigB64);
  } catch {
    return null;
  }

  const signingInput = new TextEncoder().encode(`${headerB64}.${payloadB64}`);

  return { header, payload, signingInput, signature };
}

/* -------------------------------------------------------------------------- */
/* JWKS fetch with ETag cache                                                  */
/* -------------------------------------------------------------------------- */

async function fetchJwksWithCache(
  url: string,
  deps: VerifierDeps,
): Promise<Jwks | { error: string }> {
  const cached = deps.cache.get(url);
  const headers: Record<string, string> = {};

  if (cached?.etag) {
    headers["If-None-Match"] = cached.etag;
  }

  let response: Response;
  try {
    response = await deps.fetch(url, { headers });
  } catch (err) {
    if (cached) {
      // Network failure — serve stale cache rather than failing
      return cached.jwks;
    }
    return { error: `fetch failed: ${String(err)}` };
  }

  if (response.status === 304) {
    if (cached) {
      // Bump fetchedAt to track when the 304 was received
      const updated: JwksCacheEntry = { jwks: cached.jwks, fetchedAt: (deps.now ?? Date.now)() };
      if (cached.etag !== undefined) {
        updated.etag = cached.etag;
      }
      deps.cache.set(url, updated);
      return cached.jwks;
    }
    return { error: "received 304 but no cached JWKS available" };
  }

  if (!response.ok) {
    return { error: `JWKS endpoint returned HTTP ${response.status}` };
  }

  let jwks: Jwks;
  try {
    jwks = (await response.json()) as Jwks;
  } catch {
    return { error: "JWKS response is not valid JSON" };
  }

  const entry: JwksCacheEntry = { jwks, fetchedAt: (deps.now ?? Date.now)() };
  const etag = response.headers.get("etag");
  if (etag !== null) {
    entry.etag = etag;
  }
  deps.cache.set(url, entry);

  return jwks;
}

/* -------------------------------------------------------------------------- */
/* Public API                                                                  */
/* -------------------------------------------------------------------------- */

export interface VerifyCounterpartyAttestationArgs {
  /** Compact JWS string (header.payload.signature). */
  readonly jws: string;
  /** The verifying peer's MCP origin — must match `aud` claim. */
  readonly expectedAudience: string;
  /** Full URL to the remote peer's JWKS endpoint. */
  readonly jwksUrl: string;
  /** Injected fetch function. */
  readonly fetch: typeof globalThis.fetch;
  /** Shared JWKS cache. */
  readonly cache: JwksCache;
  /** Clock override for expiry tests. */
  readonly now?: () => number;
}

/**
 * Verify a `model_attestation_jws` from an A2A counterparty.
 *
 * Returns `{ ok: true, attestation }` on success or `{ ok: false, error }` on
 * any failure — never throws.
 */
export async function verifyCounterpartyAttestation(
  args: VerifyCounterpartyAttestationArgs,
): Promise<VerifyResult> {
  const nowMs = (args.now ?? Date.now)();
  const nowSec = Math.floor(nowMs / 1000);

  const deps: VerifierDeps = { fetch: args.fetch, cache: args.cache, now: args.now };

  // 1. Parse the compact JWS
  const parsed = parseJwsCompact(args.jws);
  if (!parsed) {
    return { ok: false, error: { code: "malformed-jws", message: "JWS is not a valid compact serialization" } };
  }

  const { header, payload, signingInput, signature } = parsed;

  // 2. Extract kid from header
  const kid = header["kid"];
  if (typeof kid !== "string" || kid.length === 0) {
    return { ok: false, error: { code: "malformed-jws", message: "JWS header missing or invalid `kid`" } };
  }

  // 3. Fetch JWKS (with ETag cache)
  const jwksResult = await fetchJwksWithCache(args.jwksUrl, deps);
  if ("error" in jwksResult) {
    return { ok: false, error: { code: "jwks-fetch-failed", message: jwksResult.error } };
  }

  // 4. Find the key by kid
  const jwk = jwksResult.keys.find((k) => k.kid === kid);
  if (!jwk) {
    return { ok: false, error: { code: "unknown-kid", message: `No key with kid="${kid}" in JWKS` } };
  }

  // 5. Decode the public key
  let pubKey: Uint8Array;
  try {
    pubKey = base64urlDecode(jwk.x);
  } catch {
    return { ok: false, error: { code: "malformed-jws", message: "JWK `x` is not valid base64url" } };
  }

  // 6. Verify signature
  let valid: boolean;
  try {
    valid = await ed.verifyAsync(signature, signingInput, pubKey);
  } catch {
    return { ok: false, error: { code: "tampered-signature", message: "Signature verification threw an error" } };
  }

  if (!valid) {
    return { ok: false, error: { code: "tampered-signature", message: "Signature verification failed" } };
  }

  // 7. Check aud
  const aud = payload["aud"];
  if (typeof aud !== "string" || aud !== args.expectedAudience) {
    return {
      ok: false,
      error: {
        code: "bad-aud",
        message: `Expected aud="${args.expectedAudience}", got "${String(aud)}"`,
      },
    };
  }

  // 8. Check exp
  const exp = payload["exp"];
  if (typeof exp !== "number" || exp < nowSec) {
    return { ok: false, error: { code: "expired", message: `JWS expired at ${String(exp)} (now ${nowSec})` } };
  }

  // 9. Project into ModelAttestation
  const iss = payload["iss"];
  const iat = payload["iat"];
  const model = payload["model"];

  if (typeof iss !== "string" || typeof iat !== "number" || typeof model !== "string") {
    return { ok: false, error: { code: "malformed-jws", message: "JWS payload missing required fields: iss, iat, model" } };
  }

  const attestation: ModelAttestation = {
    iss,
    aud,
    iat,
    exp: exp as number,
    model,
    ...(typeof payload["jti"] === "string" ? { jti: payload["jti"] } : {}),
    ...(typeof payload["model_version"] === "string" ? { model_version: payload["model_version"] } : {}),
    ...(typeof payload["sig_alg"] === "string" ? { sig_alg: payload["sig_alg"] } : {}),
  };

  return { ok: true, attestation };
}
