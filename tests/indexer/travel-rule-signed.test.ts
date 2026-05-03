// FN-084 — TravelRuleReportGenerator + VcSigner integration tests.

import { describe, expect, it } from "vitest";

import {
  AuditTrailIndexer,
  InMemoryAmountResolver,
  InMemoryKytEventSource,
  InMemoryPartyDirectory,
  TRAVEL_RULE_ISSUER_DID,
  TravelRuleReportGenerator,
  type Ed25519Signature2020Proof,
  type Ivms101Party,
  type KytTraceEvent,
  type VcSigner,
} from "../../src/services/indexer/index.js";

const BAP = "5".repeat(44);
const BPP = "6".repeat(44);
const TX = ("CrossJur" + "1".repeat(44)).slice(0, 44);

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

function fixture(): KytTraceEvent[] {
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

const FIXED_CLOCK = () => new Date("2026-01-01T00:00:00.000Z");

class FakeSigner implements VcSigner {
  public lastInput: Record<string, unknown> | undefined;
  public callCount = 0;
  public constructor(public readonly issuerDid: string) {}
  public async sign(
    vcWithoutProof: Record<string, unknown>,
  ): Promise<Ed25519Signature2020Proof> {
    this.lastInput = vcWithoutProof;
    this.callCount += 1;
    return {
      type: "Ed25519Signature2020",
      created: "2026-01-01T00:00:00.000Z",
      verificationMethod: `${this.issuerDid}#key-1`,
      proofPurpose: "assertionMethod",
      proofValue: "TR_FAKE_PROOF_BASE64URL",
    };
  }
}

function buildGenerator(signer?: VcSigner) {
  const indexer = new AuditTrailIndexer({
    source: new InMemoryKytEventSource({ traces: fixture() }),
    clock: FIXED_CLOCK,
  });
  return new TravelRuleReportGenerator({
    source: indexer,
    partyDirectory: new InMemoryPartyDirectory({ [BAP]: partyBap, [BPP]: partyBpp }),
    amountResolver: new InMemoryAmountResolver({
      [TX]: { amountUsd: 12_500.5, currency: "USD" },
    }),
    clock: FIXED_CLOCK,
    ...(signer ? { signer } : {}),
  });
}

describe("TravelRuleReportGenerator + VcSigner (FN-084)", () => {
  it("default (NoOp) emits no proof key and keeps the v0 issuer DID", async () => {
    const gen = buildGenerator();
    const report = await gen.buildReport(BAP);
    expect("proof" in report).toBe(false);
    expect(report.issuer).toBe(TRAVEL_RULE_ISSUER_DID);
  });

  it("attaches the proof block when a signer is injected and overrides issuer", async () => {
    const fakeDid = "did:eto:test:travel-rule-signer";
    const signer = new FakeSigner(fakeDid);
    const gen = buildGenerator(signer);
    const report = await gen.buildReport(BAP);

    expect(report.issuer).toBe(fakeDid);
    expect(report.proof).toEqual({
      type: "Ed25519Signature2020",
      created: "2026-01-01T00:00:00.000Z",
      verificationMethod: `${fakeDid}#key-1`,
      proofPurpose: "assertionMethod",
      proofValue: "TR_FAKE_PROOF_BASE64URL",
    });
    // Proof block MUST NOT be in the input passed to sign() (spec §11.4).
    expect(signer.lastInput).toBeDefined();
    expect("proof" in (signer.lastInput as object)).toBe(false);
    expect(signer.callCount).toBe(1);
  });
});
