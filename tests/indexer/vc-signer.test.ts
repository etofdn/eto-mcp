// Unit tests for the VcSigner abstraction (FN-084).

import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Buffer } from "node:buffer";

import * as ed25519 from "@noble/ed25519";
import { sha256 } from "@noble/hashes/sha256";

import {
  Ed25519VcSigner,
  NoOpVcSigner,
  createVcSignerFromEnv,
  proofPreimage,
} from "../../src/services/indexer/vc-signer.js";
import { jcsCanonicalize } from "../../src/utils/jcs.js";

const ISSUER = "did:eto:test:issuer:v0";

function tmpFile(name: string): string {
  const dir = mkdtempSync(join(tmpdir(), "vc-signer-"));
  return join(dir, name);
}

describe("proofPreimage", () => {
  it("is invariant under input key reordering (JCS sorts keys)", () => {
    const a = proofPreimage({ b: 2, a: 1, c: 3 });
    const b = proofPreimage({ c: 3, a: 1, b: 2 });
    expect(Buffer.from(a).equals(Buffer.from(b))).toBe(true);
  });

  it("matches sha256(jcsCanonicalize(input)) byte-for-byte", () => {
    const doc = {
      "@context": ["https://www.w3.org/2018/credentials/v1"],
      issuer: "did:eto:test:audit:v0",
      type: ["VerifiableCredential", "AuditTrailFeed"],
      foo: 7,
    };
    const expected = sha256(new TextEncoder().encode(jcsCanonicalize(doc)));
    const actual = proofPreimage(doc);
    expect(Buffer.from(actual).equals(Buffer.from(expected))).toBe(true);
    expect(actual.length).toBe(32);
  });
});

describe("Ed25519VcSigner", () => {
  const seed = new Uint8Array(32).fill(7);

  it("produces a base64url proofValue of exactly 86 chars and verifies", async () => {
    const signer = new Ed25519VcSigner({ issuerDid: ISSUER, secretKey: seed });
    const doc = { foo: 1, bar: "baz" };
    const proof = await signer.sign(doc);

    expect(proof.type).toBe("Ed25519Signature2020");
    expect(proof.proofPurpose).toBe("assertionMethod");
    expect(proof.verificationMethod).toBe(`${ISSUER}#key-1`);
    expect(proof.proofValue).toHaveLength(86); // 64 bytes base64url, no padding
    expect(/^[A-Za-z0-9_-]+$/.test(proof.proofValue)).toBe(true);

    const sig = Buffer.from(proof.proofValue, "base64url");
    expect(sig.length).toBe(64);
    const pub = await ed25519.getPublicKeyAsync(seed);
    const digest = proofPreimage(doc);
    const ok = await ed25519.verifyAsync(new Uint8Array(sig), digest, pub);
    expect(ok).toBe(true);
  });

  it("honours the injected clock for the `created` field", async () => {
    const signer = new Ed25519VcSigner({
      issuerDid: ISSUER,
      secretKey: seed,
      clock: () => new Date("2025-01-01T00:00:00Z"),
    });
    const p1 = await signer.sign({ a: 1 });
    const p2 = await signer.sign({ a: 2 });
    expect(p1.created).toBe("2025-01-01T00:00:00.000Z");
    expect(p2.created).toBe("2025-01-01T00:00:00.000Z");
  });

  it("fromKeyFile round-trips a 32-byte raw seed file", async () => {
    const path = tmpFile("seed.bin");
    writeFileSync(path, Buffer.from(seed));
    const fromFile = Ed25519VcSigner.fromKeyFile({ issuerDid: ISSUER, keyPath: path });
    const direct = new Ed25519VcSigner({ issuerDid: ISSUER, secretKey: seed });
    const doc = { hello: "world" };
    const a = await fromFile.sign(doc);
    const b = await direct.sign(doc);
    expect(a.proofValue).toBe(b.proofValue);
  });

  it("fromKeyFile accepts a 64-byte NaCl-style file (uses first 32 bytes)", async () => {
    const path = tmpFile("nacl.bin");
    const pub = await ed25519.getPublicKeyAsync(seed);
    const concat = Buffer.concat([Buffer.from(seed), Buffer.from(pub)]);
    writeFileSync(path, concat);
    const signer = Ed25519VcSigner.fromKeyFile({ issuerDid: ISSUER, keyPath: path });
    const direct = new Ed25519VcSigner({ issuerDid: ISSUER, secretKey: seed });
    const a = await signer.sign({ x: 1 });
    const b = await direct.sign({ x: 1 });
    expect(a.proofValue).toBe(b.proofValue);
  });

  it("fromKeyFile accepts a hex-encoded seed", async () => {
    const path = tmpFile("seed.hex");
    writeFileSync(path, Buffer.from(seed).toString("hex") + "\n");
    const signer = Ed25519VcSigner.fromKeyFile({ issuerDid: ISSUER, keyPath: path });
    const direct = new Ed25519VcSigner({ issuerDid: ISSUER, secretKey: seed });
    expect((await signer.sign({ k: 1 })).proofValue).toBe(
      (await direct.sign({ k: 1 })).proofValue,
    );
  });

  it("fromKeyFile accepts PKCS#8 PEM as produced by `openssl genpkey -algorithm ED25519`", async () => {
    // Construct a synthetic PKCS#8 Ed25519 DER:
    //   SEQUENCE { INTEGER 0, SEQUENCE { OID 1.3.101.112 }, OCTET STRING { OCTET STRING <32 seed> } }
    // Encoded canonical form (48 bytes):
    //   30 2e 02 01 00 30 05 06 03 2b 65 70 04 22 04 20 <32 seed bytes>
    const der = Buffer.concat([
      Buffer.from([
        0x30, 0x2e, 0x02, 0x01, 0x00, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70,
        0x04, 0x22, 0x04, 0x20,
      ]),
      Buffer.from(seed),
    ]);
    const b64 = der.toString("base64");
    const pem =
      "-----BEGIN PRIVATE KEY-----\n" +
      (b64.match(/.{1,64}/g) ?? []).join("\n") +
      "\n-----END PRIVATE KEY-----\n";
    const path = tmpFile("key.pem");
    writeFileSync(path, pem);
    const signer = Ed25519VcSigner.fromKeyFile({ issuerDid: ISSUER, keyPath: path });
    const direct = new Ed25519VcSigner({ issuerDid: ISSUER, secretKey: seed });
    expect((await signer.sign({ k: 1 })).proofValue).toBe(
      (await direct.sign({ k: 1 })).proofValue,
    );
  });

  it("fromKeyFile throws on unrecognised content", () => {
    const path = tmpFile("garbage.txt");
    writeFileSync(path, "this is not a key file");
    expect(() =>
      Ed25519VcSigner.fromKeyFile({ issuerDid: ISSUER, keyPath: path }),
    ).toThrow(/Ed25519VcSigner\.fromKeyFile/);
  });
});

describe("NoOpVcSigner", () => {
  it("returns the sentinel proof with empty proofValue", async () => {
    const signer = new NoOpVcSigner("did:test:noop");
    const proof = await signer.sign({ anything: 1 });
    expect(proof).toEqual({
      type: "Ed25519Signature2020",
      verificationMethod: "did:test:noop#key-1",
      created: "1970-01-01T00:00:00.000Z",
      proofPurpose: "assertionMethod",
      proofValue: "",
    });
  });
});

describe("createVcSignerFromEnv", () => {
  it("returns NoOpVcSigner when env is empty", () => {
    const s = createVcSignerFromEnv({ issuerDid: ISSUER, env: {} });
    expect(s).toBeInstanceOf(NoOpVcSigner);
    expect(s.issuerDid).toBe(ISSUER);
  });

  it("treats AUDIT_SIGNING_KEY_PATH='' as unset (NoOp)", () => {
    const s = createVcSignerFromEnv({
      issuerDid: ISSUER,
      env: { AUDIT_SIGNING_KEY_PATH: "" },
    });
    expect(s).toBeInstanceOf(NoOpVcSigner);
  });

  it("returns Ed25519VcSigner when AUDIT_SIGNING_KEY_PATH points at a valid file", () => {
    const path = tmpFile("envseed.bin");
    writeFileSync(path, Buffer.from(new Uint8Array(32).fill(3)));
    const s = createVcSignerFromEnv({
      issuerDid: ISSUER,
      env: { AUDIT_SIGNING_KEY_PATH: path },
    });
    expect(s).toBeInstanceOf(Ed25519VcSigner);
  });
});
