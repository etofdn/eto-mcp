// VC signer for audit-trail / travel-rule JSON-LD documents (FN-084,
// FN-030).
//
// Three proof suites are supported, all sharing the same canonical
// preimage `sha256(JCS(vcWithoutProof))` per W3C VC Data Integrity
// §11.4 — only the signature container differs:
//
//   - `Ed25519Signature2020` — legacy default. base64url(Ed25519(sha256(JCS))).
//   - `JsonWebSignature2020` — JOSE detached JWS, alg=EdDSA, b64=false.
//   - `DataIntegrityProof` (cryptosuite=`cose-2024`) — COSE_Sign1
//     (CBOR tag 18) over the digest, alg=EdDSA, base64url-wrapped.
//
// The active suite is selected by `createVcSignerFromEnv` via the
// `VC_PROOF_SUITE` env var (default `"Ed25519Signature2020"`). The
// proof block itself is always excluded from the hash input by the
// calling indexer (see `audit-trail.ts` / `travel-rule.ts`).
//
// **Backwards-compatible default.** `NoOpVcSigner` returns a sentinel
// proof with `proofValue === ""`; callers detect this and OMIT the
// `proof` key entirely from the emitted document so the v0 unsigned
// shape remains byte-stable.
//
// **Key material.** `Ed25519VcSigner` accepts a 32-byte Ed25519 seed
// (NOT the 64-byte expanded form). `createVcSignerFromEnv` reads
// `AUDIT_SIGNING_KEY_PATH`; the file may be raw 32 bytes, hex (with
// optional `0x` prefix), or base64 / base64url. The loaded secret is
// never logged, never thrown back inside an Error message, and never
// persisted by this module.

import { readFileSync } from "node:fs";
import * as ed25519 from "@noble/ed25519";
import { sha256 } from "@noble/hashes/sha256";

// ---------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------

export type ProofSuite =
  | "Ed25519Signature2020" // legacy (FN-084 default)
  | "JsonWebSignature2020" // JOSE detached JWS, alg=EdDSA
  | "DataIntegrityProof.cose-2024"; // COSE_Sign1 over sha256(JCS), alg=EdDSA

export interface Ed25519Signature2020Proof {
  type: "Ed25519Signature2020";
  /** ISO-8601 UTC timestamp, e.g. `2026-05-02T12:34:56.000Z`. */
  created: string;
  /** Always `<issuerDid>#key-1` for this v0 single-key implementation. */
  verificationMethod: string;
  proofPurpose: "assertionMethod";
  /** `base64url(sign(sha256(JCS(vcWithoutProof))))`. Empty for NoOp. */
  proofValue: string;
}

export interface JsonWebSignature2020Proof {
  type: "JsonWebSignature2020";
  /** ISO-8601 UTC timestamp. */
  created: string;
  /** `<issuerDid>#key-1`. */
  verificationMethod: string;
  proofPurpose: "assertionMethod";
  /** Detached JWS per RFC 7515 §A.5: `<encodedHeader>..<base64urlSig>`.
   *  Header = `{"alg":"EdDSA","b64":false,"crit":["b64"]}`.
   *  Signing input = `utf8(encodedHeader + ".")` || `sha256(JCS(vcWithoutProof))`. */
  jws: string;
  /** Mirrors `jws` when signing succeeds; empty string is the NoOp
   *  sentinel. Allows the indexer's `proofValue !== ""` guard to
   *  uniformly detect attached proofs across all suites. */
  proofValue: string;
}

export interface DataIntegrityCoseProof {
  type: "DataIntegrityProof";
  cryptosuite: "cose-2024";
  created: string;
  verificationMethod: string;
  proofPurpose: "assertionMethod";
  /** base64url(COSE_Sign1(payload = sha256(JCS(vcWithoutProof)),
   *                       protected = {1: -8} (alg = EdDSA),
   *                       unprotected = {})). Empty string is the
   *  NoOp sentinel. */
  proofValue: string;
}

export type VcProof =
  | Ed25519Signature2020Proof
  | JsonWebSignature2020Proof
  | DataIntegrityCoseProof;

export interface VcSigner {
  readonly issuerDid: string;
  readonly suite: ProofSuite;
  sign(vcWithoutProof: Record<string, unknown>): Promise<VcProof>;
}

// ---------------------------------------------------------------------
// JCS canonicalization (RFC 8785 subset — sufficient for these docs)
// ---------------------------------------------------------------------

const LINE_SEP_RE = /\u2028/g;
const PARA_SEP_RE = /\u2029/g;

/**
 * Canonicalize a JSON-shaped value to a stable string per RFC 8785
 * (subset). Sorting is by UTF-16 code unit order on object keys (the
 * default `Array.prototype.sort()` order on strings, which matches the
 * RFC for the BMP characters used in our payloads). Rejects NaN /
 * Infinity / Date / BigInt / functions / symbols. `undefined` values
 * are dropped from objects but rejected inside arrays.
 *
 * Exported for unit testing and advanced consumers.
 */
export function canonicalizeJcs(value: unknown): string {
  return canonValue(value, /* insideArray */ false);
}

function canonValue(value: unknown, insideArray: boolean): string {
  if (value === null) return "null";
  if (value === undefined) {
    if (insideArray) {
      throw new TypeError("JCS: undefined is not a valid array element");
    }
    // Caller must drop undefined object entries before recursing.
    throw new TypeError("JCS: undefined leaked into canonicalizer");
  }
  switch (typeof value) {
    case "boolean":
      return value ? "true" : "false";
    case "number": {
      if (!Number.isFinite(value)) {
        throw new TypeError("JCS: non-finite number");
      }
      if (Number.isInteger(value) && Number.isSafeInteger(value)) {
        return String(value);
      }
      // Acceptable for our schema (no floats are produced today).
      return JSON.stringify(value);
    }
    case "string":
      return canonString(value);
    case "bigint":
      throw new TypeError("JCS: bigint is not supported");
    case "function":
      throw new TypeError("JCS: function is not supported");
    case "symbol":
      throw new TypeError("JCS: symbol is not supported");
    case "object":
      if (value instanceof Date) {
        throw new TypeError("JCS: Date is not supported (encode as ISO-8601 string)");
      }
      if (Array.isArray(value)) {
        const parts = value.map((v) => canonValue(v, /* insideArray */ true));
        return "[" + parts.join(",") + "]";
      }
      return canonObject(value as Record<string, unknown>);
    default:
      throw new TypeError(`JCS: unsupported type ${typeof value}`);
  }
}

function canonString(s: string): string {
  // Node's JSON.stringify is RFC 8785-compatible for the BMP escape
  // forms we care about. Post-process U+2028 / U+2029 to their \u
  // escapes (RFC 8785 does not require this, but it keeps the output
  // safe to embed in any JSON-in-JS context).
  const raw = JSON.stringify(s);
  return raw.replace(LINE_SEP_RE, "\\u2028").replace(PARA_SEP_RE, "\\u2029");
}

function canonObject(obj: Record<string, unknown>): string {
  // Drop entries whose value is `undefined`; sort keys by UTF-16
  // code-unit order (default string sort).
  const keys = Object.keys(obj)
    .filter((k) => obj[k] !== undefined)
    .sort();
  const parts = keys.map(
    (k) => canonString(k) + ":" + canonValue(obj[k], /* insideArray */ false),
  );
  return "{" + parts.join(",") + "}";
}

// ---------------------------------------------------------------------
// base64url
// ---------------------------------------------------------------------

/** Padding-free base64url encoding (RFC 4648 §5). */
export function base64UrlEncode(bytes: Uint8Array): string {
  const b64 = Buffer.from(bytes).toString("base64");
  return b64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

// ---------------------------------------------------------------------
// NoOpVcSigner
// ---------------------------------------------------------------------

export const DEFAULT_UNSIGNED_DID = "did:eto:indexer:unsigned:v0";

/**
 * Sentinel signer that returns a proof with `proofValue === ""`.
 * Indexer wiring detects this and omits the `proof` key entirely from
 * the emitted document, preserving the historical (v0) unsigned shape.
 */
export class NoOpVcSigner implements VcSigner {
  public readonly issuerDid: string;
  public readonly suite: ProofSuite;
  private readonly clock: () => Date;

  public constructor(
    issuerDid: string = DEFAULT_UNSIGNED_DID,
    clock?: () => Date,
    suite: ProofSuite = "Ed25519Signature2020",
  ) {
    this.issuerDid = issuerDid;
    this.clock = clock ?? (() => new Date());
    this.suite = suite;
  }

  public async sign(
    _vcWithoutProof: Record<string, unknown>,
  ): Promise<Ed25519Signature2020Proof> {
    return {
      type: "Ed25519Signature2020",
      created: this.clock().toISOString(),
      verificationMethod: `${this.issuerDid}#key-1`,
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
  /** 32-byte Ed25519 seed (NOT the 64-byte expanded form). */
  secretKey: Uint8Array;
  /** Defaults to `() => new Date()`. */
  clock?: () => Date;
}

export interface Ed25519VcSignerFromKeyFileOpts {
  issuerDid: string;
  clock?: () => Date;
}

const HEX_RE = /^[0-9a-fA-F]+$/;
const BASE64_RE = /^[A-Za-z0-9+/_-]+={0,2}$/;

/**
 * Decode a 32-byte Ed25519 seed from a key file. Accepts raw 32 bytes,
 * hex (with optional `0x` prefix), or base64 / base64url. Exported so
 * all three signer classes share the same loader semantics; failures
 * surface uniformly with a generic "expected 32-byte Ed25519 seed"
 * message that does not echo any key bytes.
 */
export function decodeEd25519Seed(buf: Buffer): Uint8Array {
  return decodeKeyBytes(buf);
}

function decodeKeyBytes(buf: Buffer): Uint8Array {
  // 1) Raw 32 bytes.
  if (buf.length === 32) {
    return new Uint8Array(buf);
  }
  // 2) Text-encoded forms — try in order.
  const text = buf.toString("utf8").trim().replace(/\s+/g, "");
  // 2a) Hex (optional `0x` prefix). 64 hex chars → 32 bytes.
  let candidate = text.startsWith("0x") || text.startsWith("0X") ? text.slice(2) : text;
  if (candidate.length === 64 && HEX_RE.test(candidate)) {
    return new Uint8Array(Buffer.from(candidate, "hex"));
  }
  // 2b) base64 / base64url.
  if (BASE64_RE.test(text)) {
    // Normalize base64url → base64.
    const padded =
      text.replace(/-/g, "+").replace(/_/g, "/") +
      "===".slice((text.length + 3) % 4);
    try {
      const decoded = Buffer.from(padded, "base64");
      if (decoded.length === 32) return new Uint8Array(decoded);
    } catch {
      // fall through to error below
    }
  }
  throw new Error("expected 32-byte Ed25519 seed");
}

function validateSeed(secretKey: Uint8Array): void {
  if (!(secretKey instanceof Uint8Array) || secretKey.length !== 32) {
    throw new Error("expected 32-byte Ed25519 seed");
  }
}

/** Compute the canonical preimage `sha256(JCS(vcWithoutProof))`. */
function claimDigest(vcWithoutProof: Record<string, unknown>): Uint8Array {
  const canon = canonicalizeJcs(vcWithoutProof);
  return sha256(new TextEncoder().encode(canon));
}

export class Ed25519VcSigner implements VcSigner {
  public readonly issuerDid: string;
  public readonly suite: ProofSuite = "Ed25519Signature2020";
  readonly #secretKey: Uint8Array;
  readonly #clock: () => Date;

  public constructor(init: Ed25519VcSignerInit) {
    validateSeed(init.secretKey);
    this.issuerDid = init.issuerDid;
    // Defensive copy so callers can't mutate the secret post-construction.
    this.#secretKey = new Uint8Array(init.secretKey);
    this.#clock = init.clock ?? (() => new Date());
  }

  public static fromKeyFile(
    path: string,
    opts: Ed25519VcSignerFromKeyFileOpts,
  ): Ed25519VcSigner {
    const buf = readFileSync(path);
    const secretKey = decodeKeyBytes(buf);
    const init: Ed25519VcSignerInit = { issuerDid: opts.issuerDid, secretKey };
    if (opts.clock) init.clock = opts.clock;
    return new Ed25519VcSigner(init);
  }

  public async sign(
    vcWithoutProof: Record<string, unknown>,
  ): Promise<Ed25519Signature2020Proof> {
    const digest = claimDigest(vcWithoutProof);
    const sig = await ed25519.signAsync(digest, this.#secretKey);
    return {
      type: "Ed25519Signature2020",
      created: this.#clock().toISOString(),
      verificationMethod: `${this.issuerDid}#key-1`,
      proofPurpose: "assertionMethod",
      proofValue: base64UrlEncode(sig),
    };
  }
}

// ---------------------------------------------------------------------
// JoseVcSigner — JsonWebSignature2020 (detached JWS, EdDSA)
// ---------------------------------------------------------------------

/**
 * Canonical encoded JOSE header for our detached-JWS suite. RFC 7515
 * §A.5 — `b64=false` means the payload bytes (the SHA-256 digest) are
 * appended raw to the signing input rather than base64url-encoded.
 *
 * Header value: `{"alg":"EdDSA","b64":false,"crit":["b64"]}`.
 */
const JWS_PROTECTED_HEADER_JSON = '{"alg":"EdDSA","b64":false,"crit":["b64"]}';
const JWS_ENCODED_HEADER = base64UrlEncode(
  new TextEncoder().encode(JWS_PROTECTED_HEADER_JSON),
);

export class JoseVcSigner implements VcSigner {
  public readonly issuerDid: string;
  public readonly suite: ProofSuite = "JsonWebSignature2020";
  readonly #secretKey: Uint8Array;
  readonly #clock: () => Date;

  public constructor(init: Ed25519VcSignerInit) {
    validateSeed(init.secretKey);
    this.issuerDid = init.issuerDid;
    this.#secretKey = new Uint8Array(init.secretKey);
    this.#clock = init.clock ?? (() => new Date());
  }

  public static fromKeyFile(
    path: string,
    opts: Ed25519VcSignerFromKeyFileOpts,
  ): JoseVcSigner {
    const buf = readFileSync(path);
    const secretKey = decodeKeyBytes(buf);
    const init: Ed25519VcSignerInit = { issuerDid: opts.issuerDid, secretKey };
    if (opts.clock) init.clock = opts.clock;
    return new JoseVcSigner(init);
  }

  public async sign(
    vcWithoutProof: Record<string, unknown>,
  ): Promise<JsonWebSignature2020Proof> {
    const digest = claimDigest(vcWithoutProof);
    // Detached JWS signing input per RFC 7515 §A.5 with b64=false:
    //   ASCII(encodedHeader || ".") || payloadBytes
    const headerDot = new TextEncoder().encode(`${JWS_ENCODED_HEADER}.`);
    const signingInput = new Uint8Array(headerDot.length + digest.length);
    signingInput.set(headerDot, 0);
    signingInput.set(digest, headerDot.length);
    const sig = await ed25519.signAsync(signingInput, this.#secretKey);
    const jws = `${JWS_ENCODED_HEADER}..${base64UrlEncode(sig)}`;
    return {
      type: "JsonWebSignature2020",
      created: this.#clock().toISOString(),
      verificationMethod: `${this.issuerDid}#key-1`,
      proofPurpose: "assertionMethod",
      jws,
      proofValue: jws,
    };
  }
}

// ---------------------------------------------------------------------
// CoseVcSigner — DataIntegrityProof (cryptosuite="cose-2024")
// ---------------------------------------------------------------------
//
// Minimal canonical-CBOR encoder. Supports only the shapes we emit:
//   - small unsigned ints (major 0)
//   - small negative ints (major 1)
//   - byte strings up to 2^32-1 (major 2)
//   - text strings up to 2^32-1 (major 3, only used for "Signature1")
//   - fixed-size arrays (major 4) and maps (major 5)
//   - tag wrapping (major 6)
// Anything outside this surface throws so future drift is obvious.

function cborHead(major: number, value: number): Uint8Array {
  if (value < 0 || !Number.isInteger(value)) {
    throw new Error("cborHead: non-negative integer required");
  }
  const mt = (major & 0x07) << 5;
  if (value < 24) return new Uint8Array([mt | value]);
  if (value < 0x100) return new Uint8Array([mt | 24, value]);
  if (value < 0x10000)
    return new Uint8Array([mt | 25, (value >>> 8) & 0xff, value & 0xff]);
  if (value < 0x100000000)
    return new Uint8Array([
      mt | 26,
      (value >>> 24) & 0xff,
      (value >>> 16) & 0xff,
      (value >>> 8) & 0xff,
      value & 0xff,
    ]);
  throw new Error("cborHead: value exceeds 2^32-1");
}

function cborConcat(parts: Uint8Array[]): Uint8Array {
  let total = 0;
  for (const p of parts) total += p.length;
  const out = new Uint8Array(total);
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.length;
  }
  return out;
}

function cborUint(n: number): Uint8Array {
  return cborHead(0, n);
}
function cborNint(n: number): Uint8Array {
  // Encodes a negative integer (n < 0) as major type 1 with value -1-n.
  if (n >= 0 || !Number.isInteger(n)) {
    throw new Error("cborNint: negative integer required");
  }
  return cborHead(1, -1 - n);
}
function cborInt(n: number): Uint8Array {
  return n >= 0 ? cborUint(n) : cborNint(n);
}
function cborBytes(b: Uint8Array): Uint8Array {
  return cborConcat([cborHead(2, b.length), b]);
}
function cborText(s: string): Uint8Array {
  const bytes = new TextEncoder().encode(s);
  return cborConcat([cborHead(3, bytes.length), bytes]);
}
function cborArray(items: Uint8Array[]): Uint8Array {
  return cborConcat([cborHead(4, items.length), ...items]);
}
function cborMapIntKeys(entries: ReadonlyArray<readonly [number, Uint8Array]>): Uint8Array {
  // Canonical CBOR: map keys must be sorted by encoded-key bytewise
  // lexicographic order. We only emit one or zero entries for now,
  // but sort defensively for forward-compat.
  const encoded = entries.map(([k, v]) => ({
    keyBytes: cborInt(k),
    valueBytes: v,
  }));
  encoded.sort((a, b) => {
    const al = a.keyBytes.length;
    const bl = b.keyBytes.length;
    if (al !== bl) return al - bl;
    for (let i = 0; i < al; i++) {
      const ai = a.keyBytes[i] ?? 0;
      const bi = b.keyBytes[i] ?? 0;
      if (ai !== bi) return ai - bi;
    }
    return 0;
  });
  const head = cborHead(5, encoded.length);
  const parts: Uint8Array[] = [head];
  for (const e of encoded) {
    parts.push(e.keyBytes, e.valueBytes);
  }
  return cborConcat(parts);
}
function cborTag(tag: number, inner: Uint8Array): Uint8Array {
  return cborConcat([cborHead(6, tag), inner]);
}

export class CoseVcSigner implements VcSigner {
  public readonly issuerDid: string;
  public readonly suite: ProofSuite = "DataIntegrityProof.cose-2024";
  readonly #secretKey: Uint8Array;
  readonly #clock: () => Date;

  public constructor(init: Ed25519VcSignerInit) {
    validateSeed(init.secretKey);
    this.issuerDid = init.issuerDid;
    this.#secretKey = new Uint8Array(init.secretKey);
    this.#clock = init.clock ?? (() => new Date());
  }

  public static fromKeyFile(
    path: string,
    opts: Ed25519VcSignerFromKeyFileOpts,
  ): CoseVcSigner {
    const buf = readFileSync(path);
    const secretKey = decodeKeyBytes(buf);
    const init: Ed25519VcSignerInit = { issuerDid: opts.issuerDid, secretKey };
    if (opts.clock) init.clock = opts.clock;
    return new CoseVcSigner(init);
  }

  public async sign(
    vcWithoutProof: Record<string, unknown>,
  ): Promise<DataIntegrityCoseProof> {
    const digest = claimDigest(vcWithoutProof);

    // Protected header: CBOR map {1: -8} = 0xa1 0x01 0x27, wrapped as bstr.
    const protectedMap = cborMapIntKeys([[1, cborNint(-8)]]);
    const protectedBstr = cborBytes(protectedMap);

    // Sig_structure per RFC 9052 §4.4:
    //   ["Signature1", protected, external_aad = h'', payload]
    const sigStructure = cborArray([
      cborText("Signature1"),
      protectedBstr,
      cborBytes(new Uint8Array(0)),
      cborBytes(digest),
    ]);
    const sig = await ed25519.signAsync(sigStructure, this.#secretKey);

    // COSE_Sign1 = [protected, unprotected, payload, signature], tag 18.
    const coseSign1 = cborArray([
      protectedBstr,
      cborMapIntKeys([]),
      cborBytes(digest),
      cborBytes(sig),
    ]);
    const tagged = cborTag(18, coseSign1);
    const proofValue = base64UrlEncode(tagged);
    return {
      type: "DataIntegrityProof",
      cryptosuite: "cose-2024",
      created: this.#clock().toISOString(),
      verificationMethod: `${this.issuerDid}#key-1`,
      proofPurpose: "assertionMethod",
      proofValue,
    };
  }
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
 * If `AUDIT_SIGNING_KEY_PATH` is set in the provided env (defaulting to
 * `process.env`), load a key-bound signer from that key file. The
 * concrete signer class is selected by `VC_PROOF_SUITE`:
 *
 *   - unset / `"Ed25519Signature2020"` → `Ed25519VcSigner` (default)
 *   - `"JsonWebSignature2020"`         → `JoseVcSigner`
 *   - `"cose-2024"`                    → `CoseVcSigner`
 *
 * If `AUDIT_SIGNING_KEY_PATH` is unset/empty, return a `NoOpVcSigner`
 * regardless of `VC_PROOF_SUITE` (preserves the byte-stable v0
 * unsigned shape). Unknown `VC_PROOF_SUITE` values throw.
 */
export function createVcSignerFromEnv(opts: CreateVcSignerFromEnvOpts): VcSigner {
  const env = opts.env ?? process.env;
  const path = env.AUDIT_SIGNING_KEY_PATH;
  const suiteRaw = env.VC_PROOF_SUITE;
  const suite =
    typeof suiteRaw === "string" && suiteRaw.length > 0
      ? suiteRaw
      : "Ed25519Signature2020";
  if (
    suite !== "Ed25519Signature2020" &&
    suite !== "JsonWebSignature2020" &&
    suite !== "cose-2024"
  ) {
    throw new Error(`VC_PROOF_SUITE: unsupported value ${suite}`);
  }
  if (typeof path === "string" && path.length > 0) {
    const fileOpts: Ed25519VcSignerFromKeyFileOpts = { issuerDid: opts.issuerDid };
    if (opts.clock) fileOpts.clock = opts.clock;
    if (suite === "JsonWebSignature2020") {
      return JoseVcSigner.fromKeyFile(path, fileOpts);
    }
    if (suite === "cose-2024") {
      return CoseVcSigner.fromKeyFile(path, fileOpts);
    }
    return Ed25519VcSigner.fromKeyFile(path, fileOpts);
  }
  return opts.clock
    ? new NoOpVcSigner(opts.issuerDid, opts.clock)
    : new NoOpVcSigner(opts.issuerDid);
}
