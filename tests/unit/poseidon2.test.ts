/**
 * Unit tests for src/crypto/poseidon2.ts
 *
 * Known-answer vectors are derived from the Rust reference implementation in
 * `crates/eto-zk/src/poseidon.rs` (ark-crypto-primitives v0.5.0, Grain LFSR,
 * BN254 Fr, t=3, full=8, partial=56, alpha=5, skip_matrices=0).
 *
 * The LE-hex strings match `CanonicalSerialize::serialize_compressed` output
 * from arkworks (same representation as the `commitment` field in §10.3.1).
 */

import { describe, test, expect, beforeAll } from "vitest";
import {
  poseidon2,
  encodeFr,
  encodeSalt,
  bytesToHex32,
  merkleCompress,
} from "../../src/crypto/poseidon2.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const P =
  21888242871839275222246405745257275088548364400416034343698204186575808495617n;

// ---------------------------------------------------------------------------
// KAT vectors (from `crates/eto-zk/src/poseidon.rs`)
// ---------------------------------------------------------------------------

describe("poseidon2 — known-answer tests", () => {
  /**
   * commit(Fr::from(27), Fr::from(0xCAFEBABE), 0)
   * = c42177f4089d7f72ed325d3352ebc12e9df446a3f29855b0011a1d1753cc1f12
   *
   * In the Rust code `commit(value, salt, idx)` calls:
   *   hash_t3([value, salt, Fr::from(idx)])
   * = poseidon2([27n, 0xCAFEBABEn, 0n])
   */
  test("commit KAT: commit(27, 0xCAFEBABE, 0)", () => {
    const value = 27n;
    const salt = 0xcafe_baben;
    const idx = 0n;
    const result = poseidon2([value, salt, idx]);
    expect(bytesToHex32(result)).toBe(
      "c42177f4089d7f72ed325d3352ebc12e9df446a3f29855b0011a1d1753cc1f12",
    );
  });

  /**
   * compress(Fr::from(1), Fr::from(2))
   * = poseidon2([1n, 2n, DOMAIN_MERKLE])
   * = eebdff5b0933561279805c4b945b2afb69bc0da6b48af4565b1ac61e2bda6e23
   */
  test("compress KAT: compress(1, 2)", () => {
    const result = merkleCompress(1n, 2n);
    expect(bytesToHex32(result)).toBe(
      "eebdff5b0933561279805c4b945b2afb69bc0da6b48af4565b1ac61e2bda6e23",
    );
  });
});

// ---------------------------------------------------------------------------
// poseidon2 — determinism and sensitivity
// ---------------------------------------------------------------------------

describe("poseidon2 — determinism", () => {
  test("identical inputs produce identical outputs", () => {
    const a = poseidon2([42n, 0xcafe_baben, 0n]);
    const b = poseidon2([42n, 0xcafe_baben, 0n]);
    expect(a).toBe(b);
  });
});

describe("poseidon2 — input sensitivity", () => {
  const base = poseidon2([42n, 0xcafe_baben, 1n]);

  test("changes with value", () => {
    expect(poseidon2([43n, 0xcafe_baben, 1n])).not.toBe(base);
  });

  test("changes with salt", () => {
    expect(poseidon2([42n, 0xcafe_babe_0001n, 1n])).not.toBe(base);
  });

  test("changes with idx", () => {
    expect(poseidon2([42n, 0xcafe_baben, 2n])).not.toBe(base);
  });
});

describe("poseidon2 — output is a valid Fr element", () => {
  test("output < P", () => {
    const r = poseidon2([100n, 200n, 300n]);
    expect(r >= 0n).toBe(true);
    expect(r < P).toBe(true);
  });
});

describe("poseidon2 — range guard", () => {
  test("throws on negative input", () => {
    expect(() => poseidon2([-1n, 0n, 0n])).toThrow(RangeError);
  });

  test("throws on input >= P", () => {
    expect(() => poseidon2([P, 0n, 0n])).toThrow(RangeError);
  });
});

// ---------------------------------------------------------------------------
// merkleCompress
// ---------------------------------------------------------------------------

describe("merkleCompress", () => {
  test("is not symmetric", () => {
    const ab = merkleCompress(100n, 200n);
    const ba = merkleCompress(200n, 100n);
    expect(ab).not.toBe(ba);
  });

  test("differs from commit(a,b,0)", () => {
    // compress(a,b) = poseidon2([a, b, DOMAIN_MERKLE])
    // commit(a,b,0) = poseidon2([a, b, 0])
    // DOMAIN_MERKLE != 0 => they must differ
    const compress = merkleCompress(100n, 200n);
    const commit = poseidon2([100n, 200n, 0n]);
    expect(compress).not.toBe(commit);
  });
});

// ---------------------------------------------------------------------------
// encodeFr
// ---------------------------------------------------------------------------

describe("encodeFr — boolean", () => {
  test("false → 0n", () => {
    expect(encodeFr(false)).toBe(0n);
  });

  test("true → 1n", () => {
    expect(encodeFr(true)).toBe(1n);
  });
});

describe("encodeFr — null / undefined", () => {
  test("null → 0n", () => {
    expect(encodeFr(null)).toBe(0n);
  });

  test("undefined → 0n", () => {
    expect(encodeFr(undefined)).toBe(0n);
  });
});

describe("encodeFr — number / bigint (numeric)", () => {
  test("0 → canonical BE encoding of '0'", () => {
    // "0" as UTF-8 is [0x30]; 32-byte BE pad: [0x00...0x30]; reduce mod P
    const bytes = new Uint8Array(32);
    bytes[31] = 0x30; // '0' in ASCII
    let expected = 0n;
    for (const b of bytes) expected = (expected << 8n) | BigInt(b);
    expected = expected % P;
    expect(encodeFr(0)).toBe(expected);
  });

  test("42 → same as bigint 42n", () => {
    expect(encodeFr(42)).toBe(encodeFr(42n));
  });

  test("distinct numbers produce distinct field elements", () => {
    expect(encodeFr(1)).not.toBe(encodeFr(2));
  });

  test("bigint: large value reduces mod P", () => {
    // P + 1 as decimal string encodes as 1n (same as encodeFr(1) if the decimal
    // string itself fits in 32 bytes — but P+1 has 78 decimal digits > 32 chars,
    // so we just check it doesn't throw and stays in [0, P)
    const big = P + 1n;
    const result = encodeFr(big);
    expect(result >= 0n).toBe(true);
    expect(result < P).toBe(true);
  });
});

describe("encodeFr — string", () => {
  test('"active" → deterministic non-zero value', () => {
    const r = encodeFr("active");
    expect(r > 0n).toBe(true);
    expect(r < P).toBe(true);
  });

  test('"active" → same value on repeated calls', () => {
    expect(encodeFr("active")).toBe(encodeFr("active"));
  });

  test("short strings produce distinct results", () => {
    expect(encodeFr("active")).not.toBe(encodeFr("checking"));
  });

  test("≤31 bytes: left-zero-pad encoding", () => {
    // 6 UTF-8 bytes for "active" = [0x61,0x63,0x74,0x69,0x76,0x65]
    // BE 32-byte pad: 26 zeros, then the 6 bytes
    const utf8 = new TextEncoder().encode("active");
    const bytes = new Uint8Array(32);
    bytes.set(utf8, 32 - utf8.length); // right-align
    let expected = 0n;
    for (const b of bytes) expected = (expected << 8n) | BigInt(b);
    expected = expected % P;
    expect(encodeFr("active")).toBe(expected);
  });

  test(">31 bytes: first 31 + length byte", () => {
    // 32-char string (32 UTF-8 bytes)
    const s = "a".repeat(32);
    const utf8 = new TextEncoder().encode(s);
    const bytes = new Uint8Array(32);
    bytes.set(utf8.subarray(0, 31), 0);
    bytes[31] = utf8.length & 0xff;
    let expected = 0n;
    for (const b of bytes) expected = (expected << 8n) | BigInt(b);
    expected = expected % P;
    expect(encodeFr(s)).toBe(expected);
  });

  test("NFC normalization: composed and decomposed forms match", () => {
    // 'é' can be U+00E9 (precomposed) or U+0065 U+0301 (decomposed)
    const precomposed = "\u00e9";
    const decomposed = "\u0065\u0301";
    expect(encodeFr(precomposed)).toBe(encodeFr(decomposed));
  });
});

describe("encodeFr — unsupported type", () => {
  test("throws TypeError for object", () => {
    expect(() => encodeFr({ foo: "bar" })).toThrow(TypeError);
  });
});

// ---------------------------------------------------------------------------
// encodeSalt
// ---------------------------------------------------------------------------

describe("encodeSalt", () => {
  test("32-byte salt encodes deterministically", () => {
    const salt = new Uint8Array(32).fill(0xab);
    const r = encodeSalt(salt);
    expect(r >= 0n).toBe(true);
    expect(r < P).toBe(true);
  });

  test("throws on wrong length", () => {
    expect(() => encodeSalt(new Uint8Array(16))).toThrow(RangeError);
  });

  test("same salt bytes → same result", () => {
    const salt = new Uint8Array(32);
    salt[0] = 0xde;
    salt[1] = 0xad;
    expect(encodeSalt(salt)).toBe(encodeSalt(salt));
  });
});

// ---------------------------------------------------------------------------
// bytesToHex32
// ---------------------------------------------------------------------------

describe("bytesToHex32", () => {
  test("0n → all-zero hex string", () => {
    expect(bytesToHex32(0n)).toBe("0".repeat(64));
  });

  test("1n → correct LE hex", () => {
    expect(bytesToHex32(1n)).toBe(
      "0100000000000000000000000000000000000000000000000000000000000000",
    );
  });

  test("round-trip: hex matches known KAT", () => {
    // From the commit KAT above
    const result = poseidon2([27n, 0xcafe_baben, 0n]);
    expect(bytesToHex32(result)).toBe(
      "c42177f4089d7f72ed325d3352ebc12e9df446a3f29855b0011a1d1753cc1f12",
    );
  });

  test("output is always 64 chars", () => {
    const r = poseidon2([1n, 2n, 3n]);
    expect(bytesToHex32(r).length).toBe(64);
  });

  test("throws on negative input", () => {
    expect(() => bytesToHex32(-1n)).toThrow(RangeError);
  });

  test("throws on value >= P", () => {
    expect(() => bytesToHex32(P)).toThrow(RangeError);
  });
});

// ---------------------------------------------------------------------------
// §10.3.1 worked example — salt_commit domain separation
// ---------------------------------------------------------------------------

describe("salt commitment domain separation", () => {
  /**
   * saltCommitment = poseidon2([salt, 0n, idx])
   * The middle zero distinguishes it from a value commitment
   * poseidon2([value, salt, idx]) where value != 0.
   */
  test("salt_commit(s, i) differs from commit(v!=0, s, i)", () => {
    const s = 7n;
    const idx = 0n;
    const v = 99n;
    const saltCommit = poseidon2([s, 0n, idx]);
    const valueCommit = poseidon2([v, s, idx]);
    expect(saltCommit).not.toBe(valueCommit);
  });
});
