// Ed25519 Verifiable Credential signer (FN-084).
//
// Implements the W3C VC Data Integrity `Ed25519Signature2020` proof
// suite for the audit-trail (FN-130) and travel-rule (FN-133)
// indexers. The signer abstraction is injectable so:
//
//   - tests can substitute a deterministic fake signer,
//   - the production wiring can load the secret key from disk via
//     `AUDIT_SIGNING_KEY_PATH` (raw 32/64-byte, hex, or PKCS#8 PEM),
//   - and the v0 default behaviour (no proof, placeholder issuer DID)
//     is preserved by `NoOpVcSigner`.
//
// **Hash convention (spec §11.4).**
//
//   proofValue = base64url( ed25519_sign( sha256( JCS(vcWithoutProof) ) ) )
//
// The signer signs the **digest**, not the raw JCS bytes. The
// `vcWithoutProof` invariant means the document passed to `sign()` MUST
// NOT contain a `proof` field (callers attach the proof afterwards).

import { readFileSync } from "node:fs";
import { Buffer } from "node:buffer";

import * as ed25519 from "@noble/ed25519";
import { sha256 } from "@noble/hashes/sha256";

import { jcsCanonicalize } from "../../utils/jcs.js";

// ---------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------

/**
 * W3C VC Data Integrity `Ed25519Signature2020` proof block.
 * `proofValue` is `base64url(64-byte Ed25519 signature)` with no padding.
 */
export interface Ed25519Signature2020Proof {
  type: "Ed25519Signature2020";
  /** `${issuerDid}#key-1` — the assertion key for the issuer DID. */
  verificationMethod: string;
  /** ISO-8601 UTC timestamp at which the proof was generated. */
  created: string;
  proofPurpose: "assertionMethod";
  /** `base64url(ed25519_sign(sha256(jcsCanonicalize(vcWithoutProof))))`. */
  proofValue: string;
}

/**
 * Signing surface for VC documents. Implementations are responsible
 * for canonicalising the input, hashing, signing, and returning a
 * fully-populated proof block.
 */
export interface VcSigner {
  readonly issuerDid: string;
  sign(vcWithoutProof: Record<string, unknown>): Promise<Ed25519Signature2020Proof>;
}

// ---------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------

/**
 * Returns `sha256(jcsCanonicalize(vcWithoutProof))` as a 32-byte
 * Uint8Array. This is the digest that downstream `claim_hash`
 * consumers (spec §11.4) expect, and the digest the Ed25519 signer
 * actually signs over.
 */
export function proofPreimage(vcWithoutProof: Record<string, unknown>): Uint8Array {
  const canonical = jcsCanonicalize(vcWithoutProof);
  const bytes = new TextEncoder().encode(canonical);
  return sha256(bytes);
}

/** base64url-encode (no padding) using Node's Buffer. */
function base64url(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64url");
}

// ---------------------------------------------------------------------
// NoOpVcSigner
// ---------------------------------------------------------------------

/**
 * Sentinel signer that satisfies the `VcSigner` interface but returns
 * an empty `proofValue`. Intended as a placeholder for callers who
 * want a uniform interface without enabling cryptographic signing.
 *
 * The audit-trail / travel-rule indexers detect a `NoOpVcSigner`
 * instance and short-circuit: they do NOT attach the sentinel proof
 * to the emitted VC and they leave the placeholder issuer DID
 * unchanged. This preserves byte-identical output with the v0
 * unsigned default.
 */
export class NoOpVcSigner implements VcSigner {
  public readonly issuerDid: string;

  public constructor(issuerDid = "did:eto:indexer:noop:v0") {
    this.issuerDid = issuerDid;
  }

  public async sign(_vcWithoutProof: Record<string, unknown>): Promise<Ed25519Signature2020Proof> {
    return {
      type: "Ed25519Signature2020",
      verificationMethod: `${this.issuerDid}#key-1`,
      created: "1970-01-01T00:00:00.000Z",
      proofPurpose: "assertionMethod",
      proofValue: "",
    };
  }
}

// ---------------------------------------------------------------------
// Ed25519VcSigner
// ---------------------------------------------------------------------

export interface Ed25519VcSignerInit {
  issuerDid: string;
  /** 32-byte Ed25519 seed, or 64-byte expanded secret (seed || pubkey). */
  secretKey: Uint8Array;
  /** Defaults to `() => new Date()`. Tests inject a fixed clock. */
  clock?: () => Date;
}

export interface Ed25519VcSignerFromKeyFileInit {
  issuerDid: string;
  keyPath: string;
  clock?: () => Date;
}

/**
 * Production `VcSigner` that signs the SHA-256 digest of the
 * canonicalised VC bytes with an Ed25519 private key.
 *
 * Note: the signer signs the 32-byte digest, NOT the raw JCS bytes.
 * This matches the spec §11.4 formula
 *   `proofValue = base64url(sign(sha256(JCS(vcWithoutProof))))`.
 */
export class Ed25519VcSigner implements VcSigner {
  public readonly issuerDid: string;
  private readonly seed: Uint8Array;
  private readonly clock: () => Date;

  public constructor(init: Ed25519VcSignerInit) {
    this.issuerDid = init.issuerDid;
    this.seed = normaliseSecretKey(init.secretKey);
    this.clock = init.clock ?? (() => new Date());
  }

  public async sign(vcWithoutProof: Record<string, unknown>): Promise<Ed25519Signature2020Proof> {
    const digest = proofPreimage(vcWithoutProof);
    const sig = await ed25519.signAsync(digest, this.seed);
    return {
      type: "Ed25519Signature2020",
      verificationMethod: `${this.issuerDid}#key-1`,
      created: this.clock().toISOString(),
      proofPurpose: "assertionMethod",
      proofValue: base64url(sig),
    };
  }

  /**
   * Construct an `Ed25519VcSigner` by loading a private key from
   * disk. Supports four file formats (auto-detected by content):
   *
   *   - raw 32 bytes: Ed25519 seed
   *   - raw 64 bytes: NaCl-style `seed || pubkey` (first 32 bytes used)
   *   - hex text (64 or 128 hex chars, optional trailing newline)
   *   - PKCS#8 PEM (`-----BEGIN PRIVATE KEY-----` ... `-----END PRIVATE KEY-----`),
   *     as produced by `openssl genpkey -algorithm ED25519`.
   */
  public static fromKeyFile(init: Ed25519VcSignerFromKeyFileInit): Ed25519VcSigner {
    const raw = readFileSync(init.keyPath);
    const seed = parseKeyFileContents(raw);
    const args: Ed25519VcSignerInit = {
      issuerDid: init.issuerDid,
      secretKey: seed,
    };
    if (init.clock) args.clock = init.clock;
    return new Ed25519VcSigner(args);
  }
}

// ---------------------------------------------------------------------
// Key-file parsing
// ---------------------------------------------------------------------

function normaliseSecretKey(key: Uint8Array): Uint8Array {
  if (key.length === 32) return Uint8Array.from(key);
  if (key.length === 64) {
    // NaCl-style concatenated `seed || pubkey`. Use the first 32 bytes.
    return Uint8Array.from(key.subarray(0, 32));
  }
  throw new Error(
    `Ed25519VcSigner: secretKey must be 32 or 64 bytes, got ${key.length}`,
  );
}

const HEX_RE = /^[0-9a-fA-F]+$/;
const PEM_BEGIN = "-----BEGIN PRIVATE KEY-----";
const PEM_END = "-----END PRIVATE KEY-----";

function parseKeyFileContents(buf: Buffer): Uint8Array {
  // 1) Raw 32 / 64 byte file.
  if (buf.length === 32 || buf.length === 64) {
    return normaliseSecretKey(new Uint8Array(buf));
  }

  // 2) Try to interpret as text.
  const text = buf.toString("utf8").trim();

  // 2a) PKCS#8 PEM.
  if (text.startsWith(PEM_BEGIN)) {
    const endIdx = text.indexOf(PEM_END);
    if (endIdx < 0) {
      throw new Error("Ed25519VcSigner.fromKeyFile: PEM missing END marker");
    }
    const b64 = text
      .slice(PEM_BEGIN.length, endIdx)
      .replace(/\s+/g, "");
    let der: Buffer;
    try {
      der = Buffer.from(b64, "base64");
    } catch {
      throw new Error("Ed25519VcSigner.fromKeyFile: invalid base64 in PEM");
    }
    // PKCS#8 Ed25519 (RFC 8410): the inner private key OCTET STRING
    // wrapping the 32-byte seed appears as `0x04 0x20 <32 bytes>` at
    // the END of the DER. This is sufficient for the canonical form
    // produced by `openssl genpkey -algorithm ED25519`.
    if (der.length < 34) {
      throw new Error(
        "Ed25519VcSigner.fromKeyFile: PEM DER too short for Ed25519 PKCS#8",
      );
    }
    const tail = der.subarray(der.length - 34);
    if (tail[0] !== 0x04 || tail[1] !== 0x20) {
      throw new Error(
        "Ed25519VcSigner.fromKeyFile: PEM does not look like Ed25519 PKCS#8 (missing 04 20 OCTET STRING tail)",
      );
    }
    return new Uint8Array(tail.subarray(2));
  }

  // 2b) Hex (64 or 128 chars).
  if ((text.length === 64 || text.length === 128) && HEX_RE.test(text)) {
    const bytes = Buffer.from(text, "hex");
    return normaliseSecretKey(new Uint8Array(bytes));
  }

  throw new Error(
    `Ed25519VcSigner.fromKeyFile: unrecognised key file format (length=${buf.length})`,
  );
}

// ---------------------------------------------------------------------
// Env factory
// ---------------------------------------------------------------------

export interface CreateVcSignerFromEnvOpts {
  issuerDid: string;
  env?: NodeJS.ProcessEnv;
  clock?: () => Date;
}

/**
 * Construct a `VcSigner` from environment configuration.
 *
 * If `env.AUDIT_SIGNING_KEY_PATH` is a non-empty string, returns an
 * `Ed25519VcSigner` loaded from that file. Otherwise returns a
 * `NoOpVcSigner` (the v0 default — no signing).
 */
export function createVcSignerFromEnv(opts: CreateVcSignerFromEnvOpts): VcSigner {
  const env = opts.env ?? process.env;
  const path = env.AUDIT_SIGNING_KEY_PATH;
  if (typeof path === "string" && path.length > 0) {
    const args: Ed25519VcSignerFromKeyFileInit = {
      issuerDid: opts.issuerDid,
      keyPath: path,
    };
    if (opts.clock) args.clock = opts.clock;
    return Ed25519VcSigner.fromKeyFile(args);
  }
  return new NoOpVcSigner(opts.issuerDid);
}
