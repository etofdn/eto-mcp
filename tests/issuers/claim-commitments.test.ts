/**
 * Unit tests for `computeClaimCommitments` (FN-077, §10.3.1).
 *
 * The tests pin the §10.3.1 contract:
 *   - byte-stable lex ordering of `fieldPath` → `idx` mapping,
 *   - per-leaf `commitment = Poseidon2_t3([value, salt, idx])`,
 *   - per-leaf `saltCommitment = Poseidon2_t3([salt, 0, idx])`,
 *   - 64-char lowercase LE hex serialization,
 *   - `encodeFr`-driven type encoding (number / string / bool / null).
 *
 * Salts are injected via a deterministic counter-based PRNG so commitment
 * hex is reproducible across runs.
 */

import { describe, expect, it } from "vitest";

import {
  bytesToHex32,
  encodeFr,
  encodeSalt,
  poseidon2,
} from "../../src/crypto/poseidon2.js";
import {
  computeClaimCommitments,
  type ClaimCommitment,
} from "../../src/issuers/claim-commitments.js";

/** Deterministic 32-byte salt: byte 0 = counter, rest 0. */
function makeCounterSalts(): (len: number) => Uint8Array {
  let counter = 0;
  return (len: number): Uint8Array => {
    if (len !== 32) throw new Error(`expected 32, got ${len}`);
    const out = new Uint8Array(32);
    out[0] = counter & 0xff;
    counter += 1;
    return out;
  };
}

/** Salt that emits all-zero bytes (so `salt_field === 0n`). */
function zeroSalts(len: number): Uint8Array {
  if (len !== 32) throw new Error(`expected 32, got ${len}`);
  return new Uint8Array(32);
}

describe("computeClaimCommitments — §10.3.1", () => {
  it("ordering invariant: insertion order does not affect output", () => {
    const a = computeClaimCommitments(
      { id: "did:eto:agent:abc", verificationLevel: "orb", action: "x" },
      { randomBytes: makeCounterSalts() },
    );
    const b = computeClaimCommitments(
      { action: "x", verificationLevel: "orb", id: "did:eto:agent:abc" },
      { randomBytes: makeCounterSalts() },
    );
    expect(a).toEqual(b);
    // idx → fieldPath mapping is `action(0), id(1), verificationLevel(2)`.
    expect(a.map((e) => `${e.idx}:${e.fieldPath}`)).toEqual([
      "0:credentialSubject.action",
      "1:credentialSubject.id",
      "2:credentialSubject.verificationLevel",
    ]);
  });

  it("nested objects yield dot-separated paths under credentialSubject.", () => {
    const out = computeClaimCommitments(
      {
        id: "did:eto:agent:abc",
        profile: { name: "Ada", dob: "1815-12-10" },
      },
      { randomBytes: makeCounterSalts() },
    );
    expect(out.map((e) => e.fieldPath)).toEqual([
      "credentialSubject.id",
      "credentialSubject.profile.dob",
      "credentialSubject.profile.name",
    ]);
  });

  it("null and false both encode to 0n at the same salt+idx → identical commitment", () => {
    const nullOut = computeClaimCommitments(
      { x: null },
      { randomBytes: zeroSalts },
    );
    const falseOut = computeClaimCommitments(
      { x: false },
      { randomBytes: zeroSalts },
    );
    expect(nullOut[0]!.commitment).toBe(falseOut[0]!.commitment);
    expect(nullOut[0]!.saltCommitment).toBe(falseOut[0]!.saltCommitment);
  });

  it("true and false produce distinct commitments", () => {
    const t = computeClaimCommitments({ x: true }, { randomBytes: zeroSalts });
    const f = computeClaimCommitments({ x: false }, { randomBytes: zeroSalts });
    expect(t[0]!.commitment).not.toBe(f[0]!.commitment);
  });

  it("§10.3.1 numeric vs short-string encoding: short reps collide (intentional)", () => {
    // Both 42 and "42" right-align to bytes[30..31]=[0x34,0x32]; this is a
    // known §10.3.1 property — numeric strings <= 31 bytes share the encoded
    // field with their string form. Discrimination is done via fieldPath/idx.
    const intOut = computeClaimCommitments(
      { x: 42 },
      { randomBytes: zeroSalts },
    );
    const strOut = computeClaimCommitments(
      { x: "42" },
      { randomBytes: zeroSalts },
    );
    expect(intOut[0]!.commitment).toBe(strOut[0]!.commitment);
  });

  it("numeric vs long-string encoding: distinct when string > 31 bytes", () => {
    // String of 32 bytes triggers the length-byte path → distinct from any
    // numeric encoding.
    const intOut = computeClaimCommitments(
      { x: 42 },
      { randomBytes: zeroSalts },
    );
    const longStr = computeClaimCommitments(
      { x: "4".repeat(32) },
      { randomBytes: zeroSalts },
    );
    expect(intOut[0]!.commitment).not.toBe(longStr[0]!.commitment);
  });

  it("KAT: numeric 42 with zero salt at idx=0 matches Poseidon-2 reference", () => {
    const out = computeClaimCommitments(
      { x: 42 },
      { randomBytes: zeroSalts },
    );
    const valueField = encodeFr(42);
    const saltField = encodeSalt(new Uint8Array(32));
    const expected = bytesToHex32(poseidon2([valueField, saltField, 0n]));
    expect(out[0]!.commitment).toBe(expected);
    const expectedSalt = bytesToHex32(poseidon2([saltField, 0n, 0n]));
    expect(out[0]!.saltCommitment).toBe(expectedSalt);
  });

  it("string >31 bytes: changing length byte changes the commitment", () => {
    // 31-byte string → fits in left-zero-pad, length byte is 0
    const short = "a".repeat(31);
    // 32-byte string → first 31 bytes + length=32 in slot 31
    const long32 = "a".repeat(32);
    // 33-byte string → first 31 bytes + length=33 in slot 31
    const long33 = "a".repeat(33);

    const a = computeClaimCommitments(
      { x: short },
      { randomBytes: zeroSalts },
    );
    const b = computeClaimCommitments(
      { x: long32 },
      { randomBytes: zeroSalts },
    );
    const c = computeClaimCommitments(
      { x: long33 },
      { randomBytes: zeroSalts },
    );
    expect(a[0]!.commitment).not.toBe(b[0]!.commitment);
    expect(b[0]!.commitment).not.toBe(c[0]!.commitment);
    // All hex outputs are 64 chars.
    for (const out of [a, b, c]) {
      expect(out[0]!.commitment).toMatch(/^[0-9a-f]{64}$/);
      expect(out[0]!.saltCommitment).toMatch(/^[0-9a-f]{64}$/);
    }
  });

  it("idx mirrors lex order over fieldPath", () => {
    const out = computeClaimCommitments(
      { z: 1, a: 1, m: 1 },
      { randomBytes: makeCounterSalts() },
    );
    expect(out.map((e) => [e.idx, e.fieldPath])).toEqual([
      [0, "credentialSubject.a"],
      [1, "credentialSubject.m"],
      [2, "credentialSubject.z"],
    ]);
  });

  it("saltCommitment formula matches Poseidon-2([salt, 0, idx]) per entry", () => {
    const rb = makeCounterSalts();
    // Re-derive same salt sequence to compute expectations.
    const rb2 = makeCounterSalts();
    const out = computeClaimCommitments(
      { a: "foo", b: "bar" },
      { randomBytes: rb },
    );
    for (const entry of out) {
      const salt = rb2(32);
      const saltField = encodeSalt(salt);
      const expected = bytesToHex32(
        poseidon2([saltField, 0n, BigInt(entry.idx)]),
      );
      expect(entry.saltCommitment).toBe(expected);
    }
  });

  it("output hex shape: every commitment + saltCommitment is 64 lowercase hex chars", () => {
    const out = computeClaimCommitments(
      {
        id: "did:eto:agent:abc",
        n: 7,
        b: true,
        s: null,
        nested: { a: "x", b: "y" },
      },
      { randomBytes: makeCounterSalts() },
    );
    for (const e of out) {
      expect(e.commitment).toMatch(/^[0-9a-f]{64}$/);
      expect(e.saltCommitment).toMatch(/^[0-9a-f]{64}$/);
    }
  });

  it("array leaves are encoded via JSON.stringify (v0 convention)", () => {
    const out = computeClaimCommitments(
      { tags: ["a", "b"] },
      { randomBytes: zeroSalts },
    );
    const expected = bytesToHex32(
      poseidon2([
        encodeFr(JSON.stringify(["a", "b"])),
        encodeSalt(new Uint8Array(32)),
        0n,
      ]),
    );
    expect(out[0]!.commitment).toBe(expected);
  });

  it("default WebCrypto path emits unique salts (smoke test)", () => {
    // Just verify the no-opts call path runs and returns 64-char hex.
    const out: ClaimCommitment[] = computeClaimCommitments({ a: 1, b: 2 });
    expect(out).toHaveLength(2);
    for (const e of out) {
      expect(e.commitment).toMatch(/^[0-9a-f]{64}$/);
      expect(e.saltCommitment).toMatch(/^[0-9a-f]{64}$/);
    }
    // Re-run should produce different commitments (random salts).
    const out2 = computeClaimCommitments({ a: 1, b: 2 });
    expect(out2[0]!.commitment).not.toBe(out[0]!.commitment);
  });
});
