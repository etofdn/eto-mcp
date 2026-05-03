// FN-084 — AuditTrailIndexer + VcSigner integration tests.

import { describe, expect, it } from "vitest";

import {
  AUDIT_TRAIL_ISSUER_DID,
  AuditTrailIndexer,
  InMemoryKytEventSource,
  type Ed25519Signature2020Proof,
  type KytTraceEvent,
  type VcSigner,
} from "../../src/services/indexer/index.js";

const AUTHORITY = "5".repeat(44);
const COUNTERPARTY = "6".repeat(44);

function fixture(): KytTraceEvent[] {
  return [
    {
      stage: "init",
      tx_signature: ("Sig1" + "1".repeat(44)).slice(0, 44),
      slot: 1000,
      timestamp: 1_700_000_000,
      parties: [
        { party: "bap", authority: AUTHORITY, cred_pointers: ["a".repeat(64)] },
        { party: "bpp", authority: COUNTERPARTY, cred_pointers: ["b".repeat(64)] },
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
    // Snapshot via structured clone so subsequent caller mutations
    // (e.g. attaching the returned proof to the same object) do not
    // pollute the captured input.
    this.lastInput = structuredClone(vcWithoutProof);
    this.callCount += 1;
    return {
      type: "Ed25519Signature2020",
      created: "2026-01-01T00:00:00.000Z",
      verificationMethod: `${this.issuerDid}#key-1`,
      proofPurpose: "assertionMethod",
      proofValue: "FAKE_PROOF_VALUE_BASE64URL",
    };
  }
}

describe("AuditTrailIndexer + VcSigner (FN-084)", () => {
  it("default (NoOp) emits no proof key and keeps the v0 issuer DID", async () => {
    const indexer = new AuditTrailIndexer({
      source: new InMemoryKytEventSource({ traces: fixture() }),
      clock: FIXED_CLOCK,
    });
    const feed = await indexer.buildAuditFeed(AUTHORITY);
    expect("proof" in feed).toBe(false);
    expect(feed.issuer).toBe(AUDIT_TRAIL_ISSUER_DID);
  });

  it("attaches the proof block when a signer is injected and overrides issuer", async () => {
    const fakeDid = "did:eto:test:audit-signer";
    const signer = new FakeSigner(fakeDid);
    const indexer = new AuditTrailIndexer({
      source: new InMemoryKytEventSource({ traces: fixture() }),
      clock: FIXED_CLOCK,
      signer,
    });
    const feed = await indexer.buildAuditFeed(AUTHORITY);

    expect(feed.issuer).toBe(fakeDid);
    expect(feed.proof).toEqual({
      type: "Ed25519Signature2020",
      created: "2026-01-01T00:00:00.000Z",
      verificationMethod: `${fakeDid}#key-1`,
      proofPurpose: "assertionMethod",
      proofValue: "FAKE_PROOF_VALUE_BASE64URL",
    });
    // Proof block MUST NOT be in the input passed to sign() (spec §11.4).
    expect(signer.lastInput).toBeDefined();
    expect("proof" in (signer.lastInput as object)).toBe(false);
  });

  it("is deterministic across two builds with identical inputs and a fixed clock", async () => {
    const signer = new FakeSigner("did:eto:test:audit-signer");
    const make = () =>
      new AuditTrailIndexer({
        source: new InMemoryKytEventSource({ traces: fixture() }),
        clock: FIXED_CLOCK,
        signer,
      });
    const a = await make().buildAuditFeed(AUTHORITY);
    const b = await make().buildAuditFeed(AUTHORITY);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });
});
