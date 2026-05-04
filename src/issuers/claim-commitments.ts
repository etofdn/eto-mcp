/**
 * `claimCommitments` — per-leaf Poseidon-2 commitments embedded into every
 * issuer VC body before computing `claim_hash` per
 * `spec/SINGULARITY-LAYER-1.md` §10.3.1.
 *
 * # Contract (§10.3.1)
 *
 * Each entry binds one leaf of `credentialSubject` to:
 *
 * | Field              | Definition                                                                |
 * |--------------------|---------------------------------------------------------------------------|
 * | `fieldPath`        | Dot-separated leaf path, prefixed by `pathPrefix` (default `credentialSubject`). |
 * | `idx`              | 0-based position in the **byte-stable** lex sort of `fieldPath`s.         |
 * | `commitment`       | 32-byte LE lowercase hex (no `0x`) of `Poseidon2_t3([value, salt, idx])`. |
 * | `saltCommitment`   | 32-byte LE lowercase hex (no `0x`) of `Poseidon2_t3([salt, 0, idx])`.     |
 *
 * `idx` MUST equal the `field_index` public input of
 * `verify_credential_predicate`, so the lex-sort over leaf paths is the
 * security-critical contract that lets selective-disclosure proofs match.
 *
 * # Encoding
 *
 * Value encoding is delegated to `encodeFr` (§10.3.1 type table: number /
 * bigint, string with NFC + 31-byte truncation + length byte, bool, null).
 * Salt encoding uses `encodeSalt` (LE → Fr) — never BE.
 *
 * Output hex serialization uses `bytesToHex32` which emits 32-byte LE
 * lowercase hex with no `0x` prefix (matches arkworks
 * `CanonicalSerialize::serialize_compressed` for BN254 Fr).
 *
 * # Array-leaf encoding (v0 caveat)
 *
 * §10.3.1's encoding table does not enumerate arrays. As a v0 convention
 * (pending §10.3.1 clarification), array leaves are encoded via
 * `encodeFr(JSON.stringify(arrayValue))` — i.e. the string path with NFC +
 * 31-byte truncation + length byte. This means two arrays whose
 * stringifications truncate to the same 31-byte prefix and same length-byte
 * collide; until §10.3.1 mandates per-element encoding, callers SHOULD avoid
 * embedding large arrays as `credentialSubject` leaves.
 *
 * # Salt CSPRNG hygiene
 *
 * Each entry gets 32 fresh CSPRNG bytes from `globalThis.crypto
 * .getRandomValues`. Tests can inject a deterministic `randomBytes` hook to
 * pin commitment outputs for KAT regression coverage.
 *
 * # Leaf flattening
 *
 * A *leaf* is any value that is not a non-null, non-Array plain object.
 * Strings, numbers, booleans, `null`, `undefined`, and arrays are all
 * leaves. Plain objects are recursed into; the recursion path is built by
 * dot-joining keys without bracket-quoting (paths stay byte-stable for the
 * lex sort).
 *
 * Implements §10.3.1 (FN-212 ratified, FN-082 land of Poseidon-2 t=3 BN254).
 */

import {
  bytesToHex32,
  encodeFr,
  encodeSalt,
  poseidon2,
} from "../crypto/poseidon2.js";

/** Per-leaf commitment entry per §10.3.1. */
export interface ClaimCommitment {
  /** Dot-separated path under `pathPrefix` (default `credentialSubject`). */
  readonly fieldPath: string;
  /** 0-based position in the lex-sorted `fieldPath` list. */
  readonly idx: number;
  /** 64-char lowercase LE hex (no `0x`) of Poseidon-2(value, salt, idx). */
  readonly commitment: string;
  /** 64-char lowercase LE hex (no `0x`) of Poseidon-2(salt, 0, idx). */
  readonly saltCommitment: string;
}

/** Options for `computeClaimCommitments`. */
export interface ComputeClaimCommitmentsOptions {
  /**
   * Deterministic CSPRNG hook for tests. Each call MUST return exactly
   * `len` cryptographically random bytes. Defaults to
   * `globalThis.crypto.getRandomValues`.
   */
  readonly randomBytes?: ((len: number) => Uint8Array) | undefined;
  /**
   * Path prefix prepended to every `fieldPath`. Defaults to
   * `"credentialSubject"` so canonical entries read
   * `credentialSubject.<leaf>` per §10.3.1.
   */
  readonly pathPrefix?: string | undefined;
}

/** Default WebCrypto-backed CSPRNG. Throws if WebCrypto is unavailable. */
function defaultRandomBytes(len: number): Uint8Array {
  const c = globalThis.crypto;
  if (!c || typeof c.getRandomValues !== "function") {
    throw new Error(
      "computeClaimCommitments: globalThis.crypto.getRandomValues is " +
        "unavailable; cannot generate commitment salts",
    );
  }
  return c.getRandomValues(new Uint8Array(len));
}

/** True if `v` should be recursed into (plain object, non-Array, non-null). */
function isPlainObject(v: unknown): v is Record<string, unknown> {
  return (
    v !== null && typeof v === "object" && !Array.isArray(v)
  );
}

/** Flatten an object into `[fieldPath, value]` pairs (arrays are leaves). */
function flattenLeaves(
  prefix: string,
  obj: Record<string, unknown>,
  out: Array<{ path: string; value: unknown }>,
): void {
  for (const key of Object.keys(obj)) {
    const path = `${prefix}.${key}`;
    const v = obj[key];
    if (isPlainObject(v)) {
      flattenLeaves(path, v, out);
    } else {
      // Arrays, strings, numbers, booleans, null, undefined — all leaves.
      // Arrays go through `encodeFr(JSON.stringify(...))` below; see the
      // module-level "Array-leaf encoding" caveat.
      out.push({ path, value: v });
    }
  }
}

/**
 * Compute the §10.3.1 `claimCommitments` array for a `credentialSubject`.
 *
 * @param credentialSubject The VC `credentialSubject` block (must be a plain
 *                          object). Leaves are flattened recursively.
 * @param opts              Optional CSPRNG hook + path prefix override.
 * @returns Lex-sorted `ClaimCommitment[]` with sequential `idx` 0..n-1.
 */
export function computeClaimCommitments(
  credentialSubject: Record<string, unknown>,
  opts?: ComputeClaimCommitmentsOptions,
): ClaimCommitment[] {
  if (!isPlainObject(credentialSubject)) {
    throw new TypeError(
      "computeClaimCommitments: credentialSubject must be a plain object",
    );
  }
  const pathPrefix = opts?.pathPrefix ?? "credentialSubject";
  const randomBytes = opts?.randomBytes ?? defaultRandomBytes;

  // 1. Flatten leaves (arrays are leaves, not recursion targets).
  const leaves: Array<{ path: string; value: unknown }> = [];
  flattenLeaves(pathPrefix, credentialSubject, leaves);

  // 2. Byte-stable lex sort over `fieldPath`. Do NOT use `localeCompare` —
  //    locale-aware comparison can reorder code points and break the
  //    `idx ↔ field_index` invariant that selective-disclosure proofs rely
  //    on.
  leaves.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));

  // 3. Commit each leaf at its sorted `idx`.
  const out: ClaimCommitment[] = [];
  for (let idx = 0; idx < leaves.length; idx += 1) {
    const { path, value } = leaves[idx]!;

    // Value encoding per §10.3.1 (with v0 array-as-string caveat).
    let valueField: bigint;
    if (Array.isArray(value)) {
      valueField = encodeFr(JSON.stringify(value));
    } else {
      valueField = encodeFr(value);
    }

    // Fresh 32-byte CSPRNG salt per attribute.
    const saltBytes = randomBytes(32);
    if (!(saltBytes instanceof Uint8Array) || saltBytes.length !== 32) {
      throw new Error(
        "computeClaimCommitments: randomBytes must return a 32-byte Uint8Array",
      );
    }
    const saltField = encodeSalt(saltBytes);
    const idxField = BigInt(idx);

    const commitmentFr = poseidon2([valueField, saltField, idxField]);
    const saltCommitmentFr = poseidon2([saltField, 0n, idxField]);

    out.push({
      fieldPath: path,
      idx,
      commitment: bytesToHex32(commitmentFr),
      saltCommitment: bytesToHex32(saltCommitmentFr),
    });
  }

  return out;
}
