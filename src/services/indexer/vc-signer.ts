// VC signer for audit-trail / travel-rule JSON-LD documents (FN-084).
//
// Implements `Ed25519Signature2020` proof blocks per the W3C VC Data
// Integrity 1.0 spec. The proof preimage is `sha256(JCS(vcWithoutProof))`
// per spec §11.4 — the proof block itself is excluded from the hash
// input by the calling indexer (see `audit-trail.ts` / `travel-rule.ts`).
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

export interface VcSigner {
  readonly issuerDid: string;
  sign(vcWithoutProof: Record<string, unknown>): Promise<Ed25519Signature2020Proof>;
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
  private readonly clock: () => Date;

  public constructor(issuerDid: string = DEFAULT_UNSIGNED_DID, clock?: () => Date) {
    this.issuerDid = issuerDid;
    this.clock = clock ?? (() => new Date());
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

export class Ed25519VcSigner implements VcSigner {
  public readonly issuerDid: string;
  readonly #secretKey: Uint8Array;
  readonly #clock: () => Date;

  public constructor(init: Ed25519VcSignerInit) {
    if (!(init.secretKey instanceof Uint8Array) || init.secretKey.length !== 32) {
      throw new Error("expected 32-byte Ed25519 seed");
    }
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
    const canon = canonicalizeJcs(vcWithoutProof);
    const digest = sha256(new TextEncoder().encode(canon));
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
// Env factory
// ---------------------------------------------------------------------

export interface CreateVcSignerFromEnvOpts {
  issuerDid: string;
  env?: NodeJS.ProcessEnv;
  clock?: () => Date;
}

/**
 * If `AUDIT_SIGNING_KEY_PATH` is set in the provided env (defaulting to
 * `process.env`), load an `Ed25519VcSigner` from that key file.
 * Otherwise return a `NoOpVcSigner` so the caller emits a byte-stable
 * unsigned document.
 */
export function createVcSignerFromEnv(opts: CreateVcSignerFromEnvOpts): VcSigner {
  const env = opts.env ?? process.env;
  const path = env.AUDIT_SIGNING_KEY_PATH;
  if (typeof path === "string" && path.length > 0) {
    const fileOpts: Ed25519VcSignerFromKeyFileOpts = { issuerDid: opts.issuerDid };
    if (opts.clock) fileOpts.clock = opts.clock;
    return Ed25519VcSigner.fromKeyFile(path, fileOpts);
  }
  return opts.clock
    ? new NoOpVcSigner(opts.issuerDid, opts.clock)
    : new NoOpVcSigner(opts.issuerDid);
}
