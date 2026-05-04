// FN-048 — JWKS document builder + key-rotation overlap state for eto-mcp.
//
// Rotation contract (authoritative):
//   1. Exactly ONE current key is always served at `GET /.well-known/jwks.json`.
//   2. On rotation, EXACTLY ONE previous key is also served until
//      `rotatedAt + overlapSeconds` so in-flight JWS minted under the old key
//      keep verifying.
//   3. The `kid` derivation guarantees that whenever the keypair OR the
//      rotation epoch changes, `kid` changes too. Consumers MUST treat
//      `kid` as opaque and resolve it via this endpoint.
//   4. The overlap window is configurable via `MCP_JWKS_OVERLAP_SECONDS`
//      and is bounded `[60, 86400]` (1 minute … 24 hours). Values outside
//      this range are rejected at rotation time.
//
// `kid` derivation:
//   `mcp-server-${b64url(sha256(serverInstance + ":" + rotationEpoch)).slice(0,16)}`
//   - `serverInstance` is the process's `last_restart_iso`
//     (see `src/signing/server-key.ts#getServerInstance`).
//   - `rotationEpoch` starts at 0 and increments on each `rotateServerKey()` call.
//
// `b64url` encoding follows RFC 7515 §2: standard base64 with `+` → `-`,
// `/` → `_`, and trailing `=` padding stripped. The same shape lives in
// `src/services/indexer/vc-signer.ts#base64UrlEncode`; we keep a local copy
// here so this module stays decoupled from the indexer's dependency graph.

import * as ed from "@noble/ed25519";
import { sha256 } from "@noble/hashes/sha256";
import {
  getServerSigningKey,
  getServerPublicKeyBytes,
  getServerInstance,
} from "./server-key.js";

/** RFC 7515 §2 base64url, no padding. */
function b64url(bytes: Uint8Array): string {
  const b64 = Buffer.from(bytes).toString("base64");
  return b64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

export interface Jwk {
  kty: "OKP";
  crv: "Ed25519";
  x: string;
  kid: string;
  use: "sig";
  alg: "EdDSA";
}

export interface Jwks {
  keys: Jwk[];
}

/** Pure: deterministic, changes with either input. */
export function computeKid(serverInstance: string, rotationEpoch: number): string {
  const digest = sha256(new TextEncoder().encode(`${serverInstance}:${rotationEpoch}`));
  return `mcp-server-${b64url(digest).slice(0, 16)}`;
}

/** Build an RFC 7517 / RFC 8037 JWK from a 32-byte Ed25519 public key. */
export function buildJwk(publicKey: Uint8Array, kid: string): Jwk {
  return {
    kty: "OKP",
    crv: "Ed25519",
    x: b64url(publicKey),
    kid,
    use: "sig",
    alg: "EdDSA",
  };
}

interface OverlapEntry {
  publicKey: Uint8Array;
  kid: string;
  rotatedAt: number; // epoch ms
  overlapSeconds: number;
}

const OVERLAP_MIN = 60;
const OVERLAP_MAX = 86400;
const OVERLAP_DEFAULT = 300;

let rotationEpoch = 0;
let overlap: OverlapEntry | null = null;

function defaultOverlapSeconds(): number {
  const raw = process.env.MCP_JWKS_OVERLAP_SECONDS;
  if (typeof raw !== "string" || raw.length === 0) return OVERLAP_DEFAULT;
  const n = parseInt(raw, 10);
  if (!Number.isFinite(n) || n < OVERLAP_MIN || n > OVERLAP_MAX) {
    return OVERLAP_DEFAULT;
  }
  return n;
}

function purgeExpired(now: Date): void {
  if (!overlap) return;
  const expiresAt = overlap.rotatedAt + overlap.overlapSeconds * 1000;
  if (now.getTime() > expiresAt) overlap = null;
}

/** Returns the JWKS to publish at the well-known endpoint. */
export function getCurrentJwks(now: Date = new Date()): Jwks {
  purgeExpired(now);
  const currentKid = computeKid(getServerInstance(), rotationEpoch);
  const currentJwk = buildJwk(getServerPublicKeyBytes(), currentKid);
  const keys: Jwk[] = [currentJwk];
  if (overlap) {
    keys.push(buildJwk(overlap.publicKey, overlap.kid));
  }
  return { keys };
}

export interface RotateOptions {
  overlapSeconds?: number;
  /** Test seam — defaults to `Date.now()`. */
  nowMs?: number;
}

/**
 * Install a new current keypair, demoting the previous one to the overlap
 * window. The new private key replaces the memoized server key.
 *
 * The previous key's public bytes are snapshotted BEFORE the in-place swap
 * so the overlap entry survives the mutation.
 */
export function rotateServerKey(
  newPrivateKey: Uint8Array,
  options: RotateOptions = {},
): void {
  if (!(newPrivateKey instanceof Uint8Array) || newPrivateKey.length !== 32) {
    throw new Error("rotateServerKey: expected 32-byte Ed25519 seed");
  }
  const overlapSeconds = options.overlapSeconds ?? defaultOverlapSeconds();
  if (
    !Number.isFinite(overlapSeconds) ||
    overlapSeconds < OVERLAP_MIN ||
    overlapSeconds > OVERLAP_MAX
  ) {
    throw new Error(
      `rotateServerKey: overlapSeconds must be in [${OVERLAP_MIN}, ${OVERLAP_MAX}]`,
    );
  }

  const slot = getServerSigningKey();
  // Snapshot BEFORE mutation — `slot.publicKey` is shared with the memoized cache.
  const prevPub = new Uint8Array(slot.publicKey);
  const prevKid = computeKid(getServerInstance(), rotationEpoch);
  const rotatedAt = options.nowMs ?? Date.now();

  const newPublicKey = ed.getPublicKey(newPrivateKey);
  slot.privateKey = newPrivateKey;
  slot.publicKey = newPublicKey;

  rotationEpoch += 1;
  overlap = {
    publicKey: prevPub,
    kid: prevKid,
    rotatedAt,
    overlapSeconds,
  };
}

/** Test-only: clear rotation/overlap state. Does NOT touch the server-key memo. */
export function __resetForTests(): void {
  rotationEpoch = 0;
  overlap = null;
}
