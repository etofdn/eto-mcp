// FN-048 — Process-scoped Ed25519 keypair for server-issued JWS / JWKS publication.
//
// This module owns the eto-mcp server's signing identity. The keypair is
// memoized for the lifetime of the process; consumers (`src/signing/jwks.ts`,
// future FN-049 session-attestation minter, etc.) read the public key bytes
// to advertise the `kid` and to verify minted JWS tokens.
//
// Loader contract:
//   - If `MCP_SERVER_SIGNING_KEY_PATH` is set, read 32 raw bytes (or hex /
//     base64 / base64url text) from that file. Decoding mirrors
//     `src/services/indexer/vc-signer.ts#decodeKeyBytes`.
//   - If unset and `NODE_ENV === "production"`, fail fatally on first call —
//     mirrors the SESSION_SIGNING_KEY pattern in `src/gateway/session.ts`.
//   - If unset and non-production, generate an ephemeral keypair via
//     `ed.utils.randomPrivateKey()` and warn that JWS issued by this process
//     will stop verifying after restart.
//
// `getServerInstance()` owns the canonical `last_restart_iso` timestamp; the
// existing `src/tools/session.ts` re-sources from here so the JWKS module's
// `kid` derivation never circular-imports through the tools layer.

import { readFileSync } from "fs";
import * as ed from "@noble/ed25519";
import { sha512 } from "@noble/hashes/sha512";

// `@noble/ed25519` v2 needs a sync sha512 wired up for sync APIs. Other
// modules (`local-signer.ts`) install the same hook, but importing this
// module ahead of them must not break either side: the assignment is
// idempotent.
ed.etc.sha512Sync = (...m: Uint8Array[]) => sha512(ed.etc.concatBytes(...m));

const HEX_RE = /^[0-9a-fA-F]+$/;
const BASE64_RE = /^[A-Za-z0-9+/_-]+={0,2}$/;

/**
 * Decode 32-byte Ed25519 seed material from a file's contents.
 * Accepts: raw 32 bytes, hex (with optional `0x`), or base64 / base64url.
 * Mirrors the decoder in `src/services/indexer/vc-signer.ts`.
 */
function decodeKeyBytes(buf: Buffer): Uint8Array {
  if (buf.length === 32) return new Uint8Array(buf);
  const text = buf.toString("utf8").trim().replace(/\s+/g, "");
  const hex = text.startsWith("0x") || text.startsWith("0X") ? text.slice(2) : text;
  if (hex.length === 64 && HEX_RE.test(hex)) {
    return new Uint8Array(Buffer.from(hex, "hex"));
  }
  if (BASE64_RE.test(text)) {
    const padded =
      text.replace(/-/g, "+").replace(/_/g, "/") +
      "===".slice((text.length + 3) % 4);
    try {
      const decoded = Buffer.from(padded, "base64");
      if (decoded.length === 32) return new Uint8Array(decoded);
    } catch {
      // fall through
    }
  }
  throw new Error("expected 32-byte Ed25519 seed");
}

export interface ServerSigningKey {
  privateKey: Uint8Array;
  publicKey: Uint8Array;
  loadedFrom: "env-path" | "ephemeral";
}

let memoized: ServerSigningKey | null = null;
let serverInstance: string | null = null;

function loadKey(): ServerSigningKey {
  const path = process.env.MCP_SERVER_SIGNING_KEY_PATH;
  if (typeof path === "string" && path.length > 0) {
    const buf = readFileSync(path);
    const privateKey = decodeKeyBytes(buf);
    const publicKey = ed.getPublicKey(privateKey);
    return { privateKey, publicKey, loadedFrom: "env-path" };
  }
  if (process.env.NODE_ENV === "production") {
    throw new Error(
      "FATAL: MCP_SERVER_SIGNING_KEY_PATH must be set in production so JWS issued by this server are verifiable across restarts.",
    );
  }
  const privateKey = ed.utils.randomPrivateKey();
  const publicKey = ed.getPublicKey(privateKey);
  console.error(
    "[eto-mcp] WARN: MCP_SERVER_SIGNING_KEY_PATH not set — using an ephemeral signing key. JWS issued by this process will NOT verify after restart.",
  );
  return { privateKey, publicKey, loadedFrom: "ephemeral" };
}

/** Returns the memoized server signing keypair, loading on first call. */
export function getServerSigningKey(): ServerSigningKey {
  if (!memoized) memoized = loadKey();
  return memoized;
}

/** Convenience: the public key bytes used by the JWKS builder. */
export function getServerPublicKeyBytes(): Uint8Array {
  return getServerSigningKey().publicKey;
}

/**
 * Stable per-process identifier — the ISO timestamp of process start.
 * This is the value `session_info.last_restart_iso` returns; centralizing
 * here avoids a circular import between `tools/session.ts` and `jwks.ts`.
 */
export function getServerInstance(): string {
  if (serverInstance === null) serverInstance = new Date().toISOString();
  return serverInstance;
}

/** Test-only: clear the memoized keypair and instance timestamp. */
export function __resetForTests(): void {
  memoized = null;
  serverInstance = null;
}
