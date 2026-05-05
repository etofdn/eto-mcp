/**
 * FN-068 — Beckn HTTP-Signature verifier (inbound).
 *
 * Verifies Beckn v2.0 LTS `Authorization` / `Signature` headers per the
 * IETF http-signatures draft profile that the Beckn protocol mandates:
 *
 *     Signature keyId="<subscriber_id>|<unique_key_id>|ed25519",
 *               algorithm="ed25519",
 *               created=<unix>,
 *               expires=<unix>,
 *               headers="(created) (expires) digest",
 *               signature="<base64>"
 *
 * The signing string is produced by joining the listed `headers` lines
 * with `\n`:
 *
 *     (created): <unix>
 *     (expires): <unix>
 *     digest: BLAKE-512=<base64(blake2b-512(raw_body))>
 *
 * The Ed25519 signature is verified against the public key returned by
 * the injected `getPublicKey(keyId)` resolver (a registry stub in tests;
 * a real Beckn registry client in production).
 *
 * Verification is OFF by default in callers — the failure-code surface
 * here is intended to be opt-in via deps so existing routes / tests
 * that do not pass auth deps are unaffected.
 */

import { blake2b } from "@noble/hashes/blake2b";
import * as ed from "@noble/ed25519";
import { sha512 } from "@noble/hashes/sha512";

// Required one-time setup so `ed.verify` works synchronously on Node /
// Bun environments (mirrors `src/signing/local-signer.ts`). Idempotent.
ed.etc.sha512Sync = (...m: Uint8Array[]) => sha512(ed.etc.concatBytes(...m));

// ---------- Public types ----------

/** Failure codes — stable, machine-readable. */
export type BecknAuthFailureCode =
  | "MISSING_AUTH"
  | "MALFORMED_AUTH"
  | "WRONG_ALGORITHM"
  | "EXPIRED_AUTH"
  | "UNKNOWN_KEY"
  | "BAD_SIGNATURE";

export type BecknAuthResult =
  | { ok: true; keyId: string; subscriberId: string; uniqueKeyId: string }
  | { ok: false; code: BecknAuthFailureCode; reason?: string };

/**
 * Resolver injected by callers — returns the raw 32-byte Ed25519 public
 * key for `keyId` (the full `subscriber|unique|alg` string), or `null`
 * when the subscriber is unknown.
 */
export type PublicKeyResolver = (keyId: string) => Uint8Array | null | undefined;

// ---------- Header parser ----------

interface ParsedAuthHeader {
  keyId: string;
  algorithm: string;
  created: number;
  expires: number;
  headers: string[];
  signature: string;
}

/**
 * Parse a Beckn `Authorization` / `Signature` header.
 *
 * Tolerates optional `Signature ` prefix, optional whitespace, and
 * single- or double-quoted values. Returns `null` on any structural
 * failure — the caller maps that to `MALFORMED_AUTH`.
 */
export function parseBecknAuthHeader(header: string): ParsedAuthHeader | null {
  if (typeof header !== "string" || header.length === 0) return null;

  // Strip optional scheme prefix (Beckn uses "Signature ", but some
  // implementations omit it).
  const trimmed = header.trim().replace(/^Signature\s+/i, "");

  // Split on commas that are not inside quoted strings. The Beckn header
  // values never contain unescaped commas, so a simple state machine is
  // sufficient.
  const parts: string[] = [];
  let buf = "";
  let quote: '"' | "'" | null = null;
  for (const ch of trimmed) {
    if (quote) {
      buf += ch;
      if (ch === quote) quote = null;
    } else if (ch === '"' || ch === "'") {
      buf += ch;
      quote = ch;
    } else if (ch === ",") {
      parts.push(buf);
      buf = "";
    } else {
      buf += ch;
    }
  }
  if (buf.length > 0) parts.push(buf);

  const map: Record<string, string> = {};
  for (const raw of parts) {
    const eq = raw.indexOf("=");
    if (eq < 0) return null;
    const k = raw.slice(0, eq).trim();
    let v = raw.slice(eq + 1).trim();
    // Strip surrounding matched quotes.
    if (
      (v.startsWith('"') && v.endsWith('"')) ||
      (v.startsWith("'") && v.endsWith("'"))
    ) {
      v = v.slice(1, -1);
    }
    map[k] = v;
  }

  const keyId = map["keyId"];
  const algorithm = map["algorithm"];
  const created = map["created"];
  const expires = map["expires"];
  const headers = map["headers"];
  const signature = map["signature"];

  if (!keyId || !algorithm || !created || !expires || !headers || !signature) {
    return null;
  }
  const cNum = Number(created);
  const eNum = Number(expires);
  if (!Number.isFinite(cNum) || !Number.isFinite(eNum)) return null;

  return {
    keyId,
    algorithm,
    created: cNum,
    expires: eNum,
    headers: headers.split(/\s+/).filter(Boolean),
    signature,
  };
}

// ---------- Helpers ----------

/** RFC-4648 base64 (not base64url). */
function base64Decode(s: string): Uint8Array | null {
  try {
    return Uint8Array.from(Buffer.from(s, "base64"));
  } catch {
    return null;
  }
}

/** Parse a Beckn keyId of the form `<subscriber>|<unique>|<alg>`. */
function parseKeyId(keyId: string): { subscriberId: string; uniqueKeyId: string; alg: string } | null {
  const parts = keyId.split("|");
  if (parts.length !== 3) return null;
  const [subscriberId, uniqueKeyId, alg] = parts;
  if (!subscriberId || !uniqueKeyId || !alg) return null;
  return { subscriberId, uniqueKeyId, alg };
}

/**
 * Build the Beckn HTTP-signatures signing string.
 *
 * Exported so producers (e.g. an outbound signer or test fixture) can
 * generate the exact same bytes the verifier will hash.
 */
export function buildSigningString(opts: {
  created: number;
  expires: number;
  digestB64: string;
  /** Header field order — defaults to Beckn's mandatory `(created) (expires) digest`. */
  headers?: string[];
}): string {
  const headers = opts.headers ?? ["(created)", "(expires)", "digest"];
  const lines: string[] = [];
  for (const h of headers) {
    if (h === "(created)") lines.push(`(created): ${opts.created}`);
    else if (h === "(expires)") lines.push(`(expires): ${opts.expires}`);
    else if (h.toLowerCase() === "digest") lines.push(`digest: BLAKE-512=${opts.digestB64}`);
    else lines.push(`${h}:`); // unknown header — empty value, safe default
  }
  return lines.join("\n");
}

/** Compute base64(BLAKE2b-512(rawBody)). Beckn names this BLAKE-512. */
export function blake512Base64(rawBody: Uint8Array | string): string {
  const bytes = typeof rawBody === "string" ? new TextEncoder().encode(rawBody) : rawBody;
  const digest = blake2b(bytes, { dkLen: 64 });
  return Buffer.from(digest).toString("base64");
}

// ---------- Main entry ----------

export interface VerifyBecknAuthOptions {
  /** Inject `now` (unix seconds) for deterministic expiry tests. */
  now?: number;
}

/**
 * Verify a Beckn `Authorization` / `Signature` header against the raw
 * request body and a registry-style public-key resolver.
 *
 * @param header        — value of the `Authorization` (or `Signature`) HTTP header.
 * @param rawBody       — raw request bytes / string (the digest is computed over this).
 * @param getPublicKey  — registry resolver; receives the parsed `keyId`, returns the
 *                        32-byte Ed25519 public key or `null`/`undefined` when the
 *                        subscriber is unknown.
 * @param opts.now      — unix seconds; defaults to `Date.now()/1000`.
 *
 * Verification order (mirrors http-signatures draft):
 *   1. parse header           → MALFORMED_AUTH on structural failure
 *   2. algorithm == ed25519   → WRONG_ALGORITHM
 *   3. created/expires window → EXPIRED_AUTH
 *   4. registry lookup        → UNKNOWN_KEY
 *   5. signature verify       → BAD_SIGNATURE
 */
export function verifyBecknAuthHeader(
  header: string | undefined | null,
  rawBody: Uint8Array | string,
  getPublicKey: PublicKeyResolver,
  opts: VerifyBecknAuthOptions = {},
): BecknAuthResult {
  if (header === undefined || header === null || header === "") {
    return { ok: false, code: "MISSING_AUTH" };
  }

  const parsed = parseBecknAuthHeader(header);
  if (!parsed) {
    return { ok: false, code: "MALFORMED_AUTH", reason: "header structure" };
  }

  if (parsed.algorithm.toLowerCase() !== "ed25519") {
    return { ok: false, code: "WRONG_ALGORITHM", reason: parsed.algorithm };
  }

  const keyParts = parseKeyId(parsed.keyId);
  if (!keyParts) {
    return { ok: false, code: "MALFORMED_AUTH", reason: "keyId" };
  }
  if (keyParts.alg.toLowerCase() !== "ed25519") {
    return { ok: false, code: "WRONG_ALGORITHM", reason: `keyId alg=${keyParts.alg}` };
  }

  const now = opts.now ?? Math.floor(Date.now() / 1000);
  if (parsed.created > now + 60) {
    // Allow 60 s clock skew on the leading edge.
    return { ok: false, code: "EXPIRED_AUTH", reason: "created in future" };
  }
  if (parsed.expires < now) {
    return { ok: false, code: "EXPIRED_AUTH", reason: "expires in past" };
  }

  const pubKey = getPublicKey(parsed.keyId);
  if (!pubKey || pubKey.length === 0) {
    return { ok: false, code: "UNKNOWN_KEY", reason: parsed.keyId };
  }

  const sigBytes = base64Decode(parsed.signature);
  if (!sigBytes || sigBytes.length !== 64) {
    return { ok: false, code: "MALFORMED_AUTH", reason: "signature bytes" };
  }

  const digestB64 = blake512Base64(rawBody);
  const signingString = buildSigningString({
    created: parsed.created,
    expires: parsed.expires,
    digestB64,
    headers: parsed.headers,
  });
  const msgBytes = new TextEncoder().encode(signingString);

  let verified = false;
  try {
    verified = ed.verify(sigBytes, msgBytes, pubKey);
  } catch {
    verified = false;
  }
  if (!verified) {
    return { ok: false, code: "BAD_SIGNATURE" };
  }

  return {
    ok: true,
    keyId: parsed.keyId,
    subscriberId: keyParts.subscriberId,
    uniqueKeyId: keyParts.uniqueKeyId,
  };
}

/**
 * Convenience signer for tests / outbound producers — builds an
 * Authorization header value from the inputs.
 *
 * @internal — not part of the FN-068 acceptance surface, but kept here
 * so the test fixture can produce a header the verifier accepts without
 * leaking signing-string assembly into the test file.
 */
export async function signBecknAuthHeader(opts: {
  privateKey: Uint8Array;
  keyId: string;
  rawBody: Uint8Array | string;
  created: number;
  expires: number;
}): Promise<string> {
  const digestB64 = blake512Base64(opts.rawBody);
  const signingString = buildSigningString({
    created: opts.created,
    expires: opts.expires,
    digestB64,
  });
  const msgBytes = new TextEncoder().encode(signingString);
  const sig = await ed.signAsync(msgBytes, opts.privateKey);
  const sigB64 = Buffer.from(sig).toString("base64");
  return (
    `Signature keyId="${opts.keyId}",algorithm="ed25519",` +
    `created=${opts.created},expires=${opts.expires},` +
    `headers="(created) (expires) digest",signature="${sigB64}"`
  );
}
