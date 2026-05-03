// Integration tests for TravelRuleReportGenerator + VcSigner (FN-084).

import { describe, expect, it } from "vitest";
import { Buffer } from "node:buffer";
import * as ed25519 from "@noble/ed25519";
import { sha256 } from "@noble/hashes/sha256";

import {
  InMemoryKytEventSource,
  type KytTraceEvent,
} from "../../src/services/indexer/audit-trail.js";
import {
  InMemoryAmountResolver,
  InMemoryPartyDirectory,
  TRAVEL_RULE_ISSUER_DID,
  TravelRuleReportGenerator,
  type Ivms101Party,
  type TravelRuleReportJsonLd,
} from "../../src/services/indexer/travel-rule.js";
import {
  Ed25519Signature2020Proof,
  Ed25519VcSigner,
  NoOpVcSigner,
  VcSigner,
  proofPreimage,
} from "../../src/services/indexer/vc-signer.js";
import { jcsCanonicalize } from "../../src/utils/jcs.js";

const BAP = "AgentCardAuthority1111111111111111111111111111";
const BPP = "CounterpartyBpp222222222222222222222222222222";
const POINTER_A =
  "aaaa11112222333344445555666677778888999900001111222233334444aaaa";
const POINTER_B =
  "bbbb11112222333344445555666677778888999900001111222233334444bbbb";
const TX_SIG = "Sig" + "1".repeat(41);

const ORIGINATOR: Ivms101Party = {
  authority: BAP,
  accountNumber: "ACCT-BAP-001",
  name: { kind: "natural", primary: "Alice", secondary: "Doe" },
  jurisdiction: "US",
};

const BENEFICIARY: Ivms101Party = {
  authority: BPP,
  accountNumber: "ACCT-BPP-001",
  name: { kind: "legal", name: "Bob GmbH" },
  jurisdiction: "DE",
};

function fixtureTraces(): KytTraceEvent[] {
  return [
    {
      stage: "confirm",
      tx_signature: TX_SIG,
      slot: 1001,
      timestamp: 1_700_000_001,
      parties: [
        { party: "bap", authority: BAP, cred_pointers: [POINTER_A] },
        { party: "bpp", authority: BPP, cred_pointers: [POINTER_B] },
      ],
    },
  ];
}

function makeGen(signer?: VcSigner): TravelRuleReportGenerator {
  const deps: ConstructorParameters<typeof TravelRuleReportGenerator>[0] = {
    source: new InMemoryKytEventSource({ traces: fixtureTraces() }),
    partyDirectory: new InMemoryPartyDirectory({
      [BAP]: ORIGINATOR,
      [BPP]: BENEFICIARY,
    }),
    amountResolver: new InMemoryAmountResolver({
      [TX_SIG]: { amountUsd: 5_000, currency: "USD" },
    }),
    clock: () => new Date("2025-06-01T00:00:00Z"),
  };
  if (signer) deps.signer = signer;
  return new TravelRuleReportGenerator(deps);
}

class FakeSigner implements VcSigner {
  public readonly issuerDid = "did:eto:test:fake-tr";
  public lastInput?: Record<string, unknown>;
  public async sign(
    vcWithoutProof: Record<string, unknown>,
  ): Promise<Ed25519Signature2020Proof> {
    this.lastInput = vcWithoutProof;
    const digest = sha256(new TextEncoder().encode(jcsCanonicalize(vcWithoutProof)));
    return {
      type: "Ed25519Signature2020",
      verificationMethod: `${this.issuerDid}#key-1`,
      created: "2025-06-01T00:00:00.000Z",
      proofPurpose: "assertionMethod",
      proofValue: Buffer.from(digest).toString("base64url"),
    };
  }
}

describe("TravelRuleReportGenerator + VcSigner (FN-084)", () => {
  it("attaches a proof block with a fake signer and matches §11.4 preimage", async () => {
    const fake = new FakeSigner();
    const report = await makeGen(fake).buildReport(BAP);

    expect(report.issuer).toBe(fake.issuerDid);
    expect(report.proof).toBeDefined();
    expect(fake.lastInput?.proof).toBeUndefined();
    expect(fake.lastInput?.issuer).toBe(fake.issuerDid);

    const { proof: _drop, ...withoutProof } = report;
    const preimage = proofPreimage(withoutProof);
    expect(Buffer.from(preimage).toString("base64url")).toBe(
      report.proof?.proofValue,
    );
  });

  it("byte-identical to v0 unsigned output modulo overridden issuer", async () => {
    const fake = new FakeSigner();
    const signed = await makeGen(fake).buildReport(BAP);
    const unsigned = await makeGen().buildReport(BAP);

    const { proof: _drop, issuer: _si, ...signedRest } = signed;
    const { issuer: _ui, ...unsignedRest } = unsigned as TravelRuleReportJsonLd;
    expect(jcsCanonicalize(signedRest)).toBe(jcsCanonicalize(unsignedRest));
  });

  it("real Ed25519VcSigner produces a verifiable 86-char proofValue", async () => {
    const seed = new Uint8Array(32).fill(11);
    const signer = new Ed25519VcSigner({
      issuerDid: "did:eto:test:real-tr",
      secretKey: seed,
      clock: () => new Date("2025-06-01T00:00:00Z"),
    });
    const report = await makeGen(signer).buildReport(BAP);

    expect(report.issuer).toBe("did:eto:test:real-tr");
    expect(report.proof?.proofValue).toHaveLength(86);

    const { proof: _omit, ...withoutProof } = report;
    const digest = proofPreimage(withoutProof);
    const sig = Buffer.from(report.proof!.proofValue, "base64url");
    const pub = await ed25519.getPublicKeyAsync(seed);
    expect(await ed25519.verifyAsync(sig, digest, pub)).toBe(true);
  });

  it("backward compat: undefined signer ⇒ no proof, placeholder issuer", async () => {
    const report = await makeGen().buildReport(BAP);
    expect(report.issuer).toBe(TRAVEL_RULE_ISSUER_DID);
    expect(report.proof).toBeUndefined();
  });

  it("NoOpVcSigner short-circuits to v0 unsigned output", async () => {
    const report = await makeGen(new NoOpVcSigner("did:test:noop")).buildReport(BAP);
    expect(report.issuer).toBe(TRAVEL_RULE_ISSUER_DID);
    expect(report.proof).toBeUndefined();
  });
});
