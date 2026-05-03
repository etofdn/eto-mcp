// FN-030 — End-to-end indexer integration with JOSE / COSE signers.
//
// Asserts that `AuditTrailIndexer` and `TravelRuleReportGenerator` emit
// the correct proof block shapes when signed with `JoseVcSigner`
// (JsonWebSignature2020) and `CoseVcSigner` (DataIntegrityProof,
// cryptosuite="cose-2024"), and that the signer input never contains
// the `proof` key (W3C VC Data Integrity §11.4).

import { describe, expect, it } from "vitest";

import {
  AuditTrailIndexer,
  CoseVcSigner,
  InMemoryAmountResolver,
  InMemoryKytEventSource,
  InMemoryPartyDirectory,
  JoseVcSigner,
  TravelRuleReportGenerator,
  type Ivms101Party,
  type KytTraceEvent,
  type VcProof,
  type VcSigner,
} from "../../src/services/indexer/index.js";

const BAP = "5".repeat(44);
const BPP = "6".repeat(44);
const TX = ("CrossJur" + "1".repeat(44)).slice(0, 44);
const ONES_SEED = new Uint8Array(32).fill(1);

const FIXED_CLOCK = () => new Date("2026-01-01T00:00:00.000Z");

function auditFixture(): KytTraceEvent[] {
  return [
    {
      stage: "init",
      tx_signature: ("Sig1" + "1".repeat(44)).slice(0, 44),
      slot: 1000,
      timestamp: 1_700_000_000,
      parties: [
        { party: "bap", authority: BAP, cred_pointers: ["a".repeat(64)] },
        { party: "bpp", authority: BPP, cred_pointers: ["b".repeat(64)] },
      ],
    },
  ];
}

function trFixture(): KytTraceEvent[] {
  return [
    {
      stage: "confirm",
      tx_signature: TX,
      slot: 2_000,
      timestamp: 1_700_000_000,
      parties: [
        { party: "bap", authority: BAP, cred_pointers: ["a".repeat(64)] },
        { party: "bpp", authority: BPP, cred_pointers: ["b".repeat(64)] },
      ],
    },
  ];
}

const partyBap: Ivms101Party = {
  authority: BAP,
  accountNumber: "ACC-BAP-0001",
  name: { kind: "natural", primary: "Alice" },
  jurisdiction: "US",
};
const partyBpp: Ivms101Party = {
  authority: BPP,
  accountNumber: "ACC-BPP-0001",
  name: { kind: "legal", name: "Acme Bank GmbH" },
  jurisdiction: "DE",
};

/** Wraps any VcSigner and snapshots the input passed to sign(). */
class SpySigner implements VcSigner {
  public lastInput: Record<string, unknown> | undefined;
  public callCount = 0;
  public readonly issuerDid: string;
  public readonly suite;
  public constructor(private readonly inner: VcSigner) {
    this.issuerDid = inner.issuerDid;
    this.suite = inner.suite;
  }
  public async sign(vc: Record<string, unknown>): Promise<VcProof> {
    this.lastInput = structuredClone(vc);
    this.callCount += 1;
    return this.inner.sign(vc);
  }
}

function base64UrlDecode(s: string): Uint8Array {
  const pad = "=".repeat((4 - (s.length % 4)) % 4);
  const b64 = s.replace(/-/g, "+").replace(/_/g, "/") + pad;
  return new Uint8Array(Buffer.from(b64, "base64"));
}

describe("AuditTrailIndexer + JoseVcSigner (FN-030)", () => {
  const fakeDid = "did:eto:test:audit-jose";

  function makeIndexer() {
    const inner = new JoseVcSigner({
      issuerDid: fakeDid,
      secretKey: ONES_SEED,
      clock: FIXED_CLOCK,
    });
    const signer = new SpySigner(inner);
    const indexer = new AuditTrailIndexer({
      source: new InMemoryKytEventSource({ traces: auditFixture() }),
      clock: FIXED_CLOCK,
      signer,
    });
    return { indexer, signer };
  }

  it("emits a JsonWebSignature2020 proof and overrides issuer", async () => {
    const { indexer, signer } = makeIndexer();
    const feed = await indexer.buildAuditFeed(BAP);
    expect(feed.issuer).toBe(fakeDid);
    expect(feed.proof?.type).toBe("JsonWebSignature2020");
    if (feed.proof?.type === "JsonWebSignature2020") {
      expect(feed.proof.jws).toBe(feed.proof.proofValue);
      // Detached JWS: exactly two `.` separators (header..sig).
      expect(feed.proof.jws.split(".").length).toBe(3);
      const segments = feed.proof.jws.split(".");
      expect(segments[1]).toBe("");
    }
    // Proof MUST NOT be in the input passed to sign() (spec §11.4).
    expect(signer.lastInput).toBeDefined();
    expect("proof" in (signer.lastInput as object)).toBe(false);
  });

  it("is deterministic across two builds (same jws)", async () => {
    const a = await makeIndexer().indexer.buildAuditFeed(BAP);
    const b = await makeIndexer().indexer.buildAuditFeed(BAP);
    expect(a.proof?.type).toBe("JsonWebSignature2020");
    if (a.proof?.type === "JsonWebSignature2020" && b.proof?.type === "JsonWebSignature2020") {
      expect(a.proof.jws).toBe(b.proof.jws);
    }
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });
});

describe("TravelRuleReportGenerator + CoseVcSigner (FN-030)", () => {
  const fakeDid = "did:eto:test:travel-cose";

  function makeGenerator() {
    const inner = new CoseVcSigner({
      issuerDid: fakeDid,
      secretKey: ONES_SEED,
      clock: FIXED_CLOCK,
    });
    const signer = new SpySigner(inner);
    const indexer = new AuditTrailIndexer({
      source: new InMemoryKytEventSource({ traces: trFixture() }),
      clock: FIXED_CLOCK,
    });
    const gen = new TravelRuleReportGenerator({
      source: indexer,
      partyDirectory: new InMemoryPartyDirectory({ [BAP]: partyBap, [BPP]: partyBpp }),
      amountResolver: new InMemoryAmountResolver({
        [TX]: { amountUsd: 12_500.5, currency: "USD" },
      }),
      clock: FIXED_CLOCK,
      signer,
    });
    return { gen, signer };
  }

  it("emits a DataIntegrityProof / cose-2024 proof with valid CBOR shape", async () => {
    const { gen, signer } = makeGenerator();
    const report = await gen.buildReport(BAP);
    expect(report.issuer).toBe(fakeDid);
    expect(report.proof?.type).toBe("DataIntegrityProof");
    if (report.proof?.type === "DataIntegrityProof") {
      expect(report.proof.cryptosuite).toBe("cose-2024");
      const bytes = base64UrlDecode(report.proof.proofValue);
      // Tag 18 (COSE_Sign1).
      expect(bytes[0]).toBe(0xd2);
      // 4-element array head.
      expect(bytes[1]).toBe(0x84);
      // protected = bstr(3): 0x43 0xa1 0x01 0x27.
      expect(bytes[2]).toBe(0x43);
      expect(bytes[3]).toBe(0xa1);
      expect(bytes[4]).toBe(0x01);
      expect(bytes[5]).toBe(0x27);
      // unprotected = empty map (0xa0).
      expect(bytes[6]).toBe(0xa0);
      // payload = bstr(32): 0x58 0x20 then 32 bytes.
      expect(bytes[7]).toBe(0x58);
      expect(bytes[8]).toBe(0x20);
      // signature = bstr(64): 0x58 0x40 then 64 bytes.
      expect(bytes[9 + 32]).toBe(0x58);
      expect(bytes[9 + 32 + 1]).toBe(0x40);
      expect(bytes.length).toBe(9 + 32 + 2 + 64);
    }
    expect(signer.lastInput).toBeDefined();
    expect("proof" in (signer.lastInput as object)).toBe(false);
  });
});

describe("NoOp regression (FN-030 entry point)", () => {
  it("AuditTrailIndexer emits no proof key by default", async () => {
    const indexer = new AuditTrailIndexer({
      source: new InMemoryKytEventSource({ traces: auditFixture() }),
      clock: FIXED_CLOCK,
    });
    const feed = await indexer.buildAuditFeed(BAP);
    expect("proof" in feed).toBe(false);
  });

  it("TravelRuleReportGenerator emits no proof key by default", async () => {
    const indexer = new AuditTrailIndexer({
      source: new InMemoryKytEventSource({ traces: trFixture() }),
      clock: FIXED_CLOCK,
    });
    const gen = new TravelRuleReportGenerator({
      source: indexer,
      partyDirectory: new InMemoryPartyDirectory({ [BAP]: partyBap, [BPP]: partyBpp }),
      amountResolver: new InMemoryAmountResolver({
        [TX]: { amountUsd: 12_500.5, currency: "USD" },
      }),
      clock: FIXED_CLOCK,
    });
    const report = await gen.buildReport(BAP);
    expect("proof" in report).toBe(false);
  });
});
