// FN-084: unit tests for src/services/indexer/vc-signer.ts.

import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import {
  Ed25519VcSigner,
  NoOpVcSigner,
  base64UrlEncode,
  canonicalizeJcs,
  createVcSignerFromEnv,
} from "../../src/services/indexer/vc-signer.js";

const FIXED_CLOCK = () => new Date("2026-01-01T00:00:00.000Z");
const ZERO_SEED = new Uint8Array(32);
const TEST_DID = "did:eto:test:signer";

// Precomputed (see PROMPT.md Step 5): signature over
// sha256(JCS({a:[1,2,3],hello:"world",n:42})) using all-zero seed.
const EXPECTED_PROOF_VALUE =
  "WWfyFEoKJzVAovZ4nQhNehe3I_FM4lQ3n7FUEvqw9LxO-IA1RTilC00D1GYvxOedJJmhv79Nn8NhmZhWQXN_Bg";
const EXPECTED_PROOF_VALUE_WITH_PROOF_KEY =
  "MkG33UbQWV2Hw0-F0SvGoTMpqblihxInyK734EdByPg36LWNiAUWvNi_lr4O3ZmR3SjDyYlpSdCY3zzFIrXQAA";

describe("canonicalizeJcs", () => {
  it("sorts object keys lexicographically", () => {
    expect(canonicalizeJcs({ b: 1, a: 2 })).toBe('{"a":2,"b":1}');
  });

  it("recursively sorts nested object keys", () => {
    expect(canonicalizeJcs({ z: { b: 1, a: 2 }, a: 1 })).toBe(
      '{"a":1,"z":{"a":2,"b":1}}',
    );
  });

  it("preserves array order", () => {
    expect(canonicalizeJcs([3, 1, 2])).toBe("[3,1,2]");
  });

  it("drops undefined values from objects", () => {
    expect(canonicalizeJcs({ a: 1, b: undefined, c: 3 })).toBe(
      '{"a":1,"c":3}',
    );
  });

  it("rejects undefined inside an array", () => {
    expect(() => canonicalizeJcs([1, undefined, 3])).toThrow(TypeError);
  });

  it("throws on NaN / Infinity", () => {
    expect(() => canonicalizeJcs(Number.NaN)).toThrow(TypeError);
    expect(() => canonicalizeJcs(Number.POSITIVE_INFINITY)).toThrow(TypeError);
    expect(() => canonicalizeJcs(Number.NEGATIVE_INFINITY)).toThrow(TypeError);
  });

  it("rejects BigInt, Date, function, symbol", () => {
    expect(() => canonicalizeJcs(1n)).toThrow(TypeError);
    expect(() => canonicalizeJcs(new Date())).toThrow(TypeError);
    expect(() => canonicalizeJcs(() => 0)).toThrow(TypeError);
    expect(() => canonicalizeJcs(Symbol("x"))).toThrow(TypeError);
  });

  it("escapes string contents like JSON.stringify", () => {
    expect(canonicalizeJcs('a"b\\c')).toBe('"a\\"b\\\\c"');
    expect(canonicalizeJcs("héllo")).toBe('"héllo"');
  });

  it("renders booleans and null", () => {
    expect(canonicalizeJcs(true)).toBe("true");
    expect(canonicalizeJcs(false)).toBe("false");
    expect(canonicalizeJcs(null)).toBe("null");
  });
});

describe("base64UrlEncode", () => {
  it("emits padding-free base64url", () => {
    expect(base64UrlEncode(new Uint8Array([0xff, 0xee, 0xdd]))).toBe("/+7d".replace(/\+/g, "-").replace(/\//g, "_"));
    // No `+`, `/`, or `=`.
    const out = base64UrlEncode(new Uint8Array([1, 2, 3, 4, 5]));
    expect(out).not.toMatch(/[+/=]/u);
  });
});

describe("NoOpVcSigner", () => {
  it("returns a proof block with empty proofValue and configured DID", async () => {
    const signer = new NoOpVcSigner(TEST_DID, FIXED_CLOCK);
    const proof = await signer.sign({ any: "thing" });
    expect(proof).toEqual({
      type: "Ed25519Signature2020",
      created: "2026-01-01T00:00:00.000Z",
      verificationMethod: `${TEST_DID}#key-1`,
      proofPurpose: "assertionMethod",
      proofValue: "",
    });
  });

  it("defaults to the unsigned-indexer DID", () => {
    const signer = new NoOpVcSigner();
    expect(signer.issuerDid).toBe("did:eto:indexer:unsigned:v0");
  });
});

describe("Ed25519VcSigner", () => {
  it("produces a deterministic proof for a fixed seed/input/clock", async () => {
    const signer = new Ed25519VcSigner({
      issuerDid: TEST_DID,
      secretKey: ZERO_SEED,
      clock: FIXED_CLOCK,
    });
    const proof = await signer.sign({ hello: "world", a: [1, 2, 3], n: 42 });
    expect(proof.type).toBe("Ed25519Signature2020");
    expect(proof.created).toBe("2026-01-01T00:00:00.000Z");
    expect(proof.verificationMethod).toBe(`${TEST_DID}#key-1`);
    expect(proof.proofPurpose).toBe("assertionMethod");
    expect(proof.proofValue).toBe(EXPECTED_PROOF_VALUE);
    expect(proof.proofValue).not.toMatch(/[+/=]/u);
  });

  it("signs whatever it's given (proof block is the caller's contract)", async () => {
    // The signer itself signs the entire input. The contract that the
    // `proof` key MUST be excluded is enforced by the indexer wiring,
    // not by the signer. This test asserts both signatures and verifies
    // they differ — which is why the indexer wiring strips `proof`
    // before calling sign().
    const signer = new Ed25519VcSigner({
      issuerDid: TEST_DID,
      secretKey: ZERO_SEED,
      clock: FIXED_CLOCK,
    });
    const proofWithout = await signer.sign({
      hello: "world",
      a: [1, 2, 3],
      n: 42,
    });
    const proofWith = await signer.sign({
      hello: "world",
      a: [1, 2, 3],
      n: 42,
      proof: { ignore: "me" },
    });
    expect(proofWithout.proofValue).toBe(EXPECTED_PROOF_VALUE);
    expect(proofWith.proofValue).toBe(EXPECTED_PROOF_VALUE_WITH_PROOF_KEY);
    expect(proofWith.proofValue).not.toBe(proofWithout.proofValue);
  });

  it("rejects non-32-byte seeds", () => {
    expect(
      () =>
        new Ed25519VcSigner({
          issuerDid: TEST_DID,
          secretKey: new Uint8Array(31),
        }),
    ).toThrow(/32-byte/u);
    expect(
      () =>
        new Ed25519VcSigner({
          issuerDid: TEST_DID,
          secretKey: new Uint8Array(64),
        }),
    ).toThrow(/32-byte/u);
  });

  describe("fromKeyFile", () => {
    const dir = mkdtempSync(join(tmpdir(), "vc-signer-"));

    it("loads a 32-raw-byte seed file", async () => {
      const path = join(dir, "raw.bin");
      writeFileSync(path, ZERO_SEED);
      const signer = Ed25519VcSigner.fromKeyFile(path, {
        issuerDid: TEST_DID,
        clock: FIXED_CLOCK,
      });
      const proof = await signer.sign({ hello: "world", a: [1, 2, 3], n: 42 });
      expect(proof.proofValue).toBe(EXPECTED_PROOF_VALUE);
    });

    it("loads a hex-encoded seed file (with 0x prefix and whitespace)", async () => {
      const path = join(dir, "hex.txt");
      writeFileSync(path, "0x" + "00".repeat(32) + "\n");
      const signer = Ed25519VcSigner.fromKeyFile(path, {
        issuerDid: TEST_DID,
        clock: FIXED_CLOCK,
      });
      const proof = await signer.sign({ hello: "world", a: [1, 2, 3], n: 42 });
      expect(proof.proofValue).toBe(EXPECTED_PROOF_VALUE);
    });

    it("loads a base64url-encoded seed file", async () => {
      const path = join(dir, "b64.txt");
      // base64 of 32 zero bytes
      writeFileSync(path, "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA");
      const signer = Ed25519VcSigner.fromKeyFile(path, {
        issuerDid: TEST_DID,
        clock: FIXED_CLOCK,
      });
      const proof = await signer.sign({ hello: "world", a: [1, 2, 3], n: 42 });
      expect(proof.proofValue).toBe(EXPECTED_PROOF_VALUE);
    });

    it("throws on wrong-length seed", () => {
      const path = join(dir, "bad.bin");
      writeFileSync(path, new Uint8Array(16));
      expect(() =>
        Ed25519VcSigner.fromKeyFile(path, { issuerDid: TEST_DID }),
      ).toThrow(/32-byte/u);
    });
  });
});

describe("createVcSignerFromEnv", () => {
  it("returns NoOpVcSigner when AUDIT_SIGNING_KEY_PATH is unset", () => {
    const signer = createVcSignerFromEnv({
      issuerDid: TEST_DID,
      env: {},
    });
    expect(signer).toBeInstanceOf(NoOpVcSigner);
    expect(signer.issuerDid).toBe(TEST_DID);
  });

  it("returns NoOpVcSigner when AUDIT_SIGNING_KEY_PATH is empty", () => {
    const signer = createVcSignerFromEnv({
      issuerDid: TEST_DID,
      env: { AUDIT_SIGNING_KEY_PATH: "" },
    });
    expect(signer).toBeInstanceOf(NoOpVcSigner);
  });

  it("returns Ed25519VcSigner when AUDIT_SIGNING_KEY_PATH points at a valid seed", async () => {
    const dir = mkdtempSync(join(tmpdir(), "vc-signer-env-"));
    const path = join(dir, "seed.bin");
    writeFileSync(path, ZERO_SEED);
    const signer = createVcSignerFromEnv({
      issuerDid: TEST_DID,
      env: { AUDIT_SIGNING_KEY_PATH: path },
      clock: FIXED_CLOCK,
    });
    expect(signer).toBeInstanceOf(Ed25519VcSigner);
    const proof = await signer.sign({ hello: "world", a: [1, 2, 3], n: 42 });
    expect(proof.proofValue).toBe(EXPECTED_PROOF_VALUE);
  });
});
