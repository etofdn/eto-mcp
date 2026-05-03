// Integration tests for AuditTrailIndexer + VcSigner (FN-084).

import { describe, expect, it } from "vitest";
import { Buffer } from "node:buffer";
import * as ed25519 from "@noble/ed25519";
import { sha256 } from "@noble/hashes/sha256";

import {
  AUDIT_TRAIL_ISSUER_DID,
  AuditTrailIndexer,
  InMemoryKytEventSource,
  type AuditFeedJsonLd,
  type KytTraceEvent,
} from "../../src/services/indexer/audit-trail.js";
import {
  Ed25519Signature2020Proof,
  Ed25519VcSigner,
  NoOpVcSigner,
  VcSigner,
  proofPreimage,
} from "../../src/services/indexer/vc-signer.js";
import { jcsCanonicalize } from "../../src/utils/jcs.js";

const AUTH = "AgentCardAuthority1111111111111111111111111111";
const CP = "CounterpartyBpp222222222222222222222222222222";
const POINTER_A =
  "aaaa11112222333344445555666677778888999900001111222233334444aaaa";
const POINTER_B =
  "bbbb11112222333344445555666677778888999900001111222233334444bbbb";

function fixtureTraces(): KytTraceEvent[] {
  return [
    {
      stage: "confirm",
      tx_signature: "Sig" + "1".repeat(41),
      slot: 1001,
      timestamp: 1_700_000_001,
      parties: [
        { party: "bap", authority: AUTH, cred_pointers: [POINTER_A] },
        { party: "bpp", authority: CP, cred_pointers: [POINTER_B] },
      ],
    },
  ];
}

function makeIndexer(signer?: VcSigner): AuditTrailIndexer {
  const deps: ConstructorParameters<typeof AuditTrailIndexer>[0] = {
    source: new InMemoryKytEventSource({ traces: fixtureTraces() }),
    clock: () => new Date("2025-06-01T00:00:00Z"),
  };
  if (signer) deps.signer = signer;
  return new AuditTrailIndexer(deps);
}

class FakeSigner implements VcSigner {
  public readonly issuerDid = "did:eto:test:fake-audit";
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

describe("AuditTrailIndexer + VcSigner (FN-084)", () => {
  it("attaches a proof block when a real signer is injected (FakeSigner)", async () => {
    const fake = new FakeSigner();
    const feed = await makeIndexer(fake).buildAuditFeed(AUTH);

    expect(feed.issuer).toBe(fake.issuerDid);
    expect(feed.proof).toBeDefined();
    expect(feed.proof?.type).toBe("Ed25519Signature2020");
    expect(feed.proof?.verificationMethod).toBe(`${fake.issuerDid}#key-1`);
    expect(feed.proof?.proofPurpose).toBe("assertionMethod");

    // The signer's input is the document WITHOUT the proof block, with
    // the issuer DID overridden to the signer's. Re-derive the expected
    // proofValue and compare.
    expect(fake.lastInput).toBeDefined();
    expect(fake.lastInput?.proof).toBeUndefined();
    expect(fake.lastInput?.issuer).toBe(fake.issuerDid);

    const { proof: _drop, ...withoutProof } = feed;
    const expectedDigest = sha256(
      new TextEncoder().encode(jcsCanonicalize(withoutProof)),
    );
    expect(feed.proof?.proofValue).toBe(
      Buffer.from(expectedDigest).toString("base64url"),
    );
  });

  it("§11.4 invariant: proof preimage excludes the proof block itself", async () => {
    const fake = new FakeSigner();
    const feed = await makeIndexer(fake).buildAuditFeed(AUTH);

    const { proof: _omit, ...withoutProof } = feed;
    const preimage = proofPreimage(withoutProof);
    expect(Buffer.from(preimage).toString("base64url")).toBe(
      feed.proof?.proofValue,
    );
  });

  it("byte-identical to v0 unsigned output modulo overridden issuer", async () => {
    const fake = new FakeSigner();
    const signedFeed = await makeIndexer(fake).buildAuditFeed(AUTH);
    const unsignedFeed = await makeIndexer().buildAuditFeed(AUTH);

    const { proof: _drop, issuer: _signedIssuer, ...signedRest } = signedFeed;
    const { issuer: _unsignedIssuer, ...unsignedRest } = unsignedFeed as AuditFeedJsonLd;
    expect(jcsCanonicalize(signedRest)).toBe(jcsCanonicalize(unsignedRest));
  });

  it("real Ed25519VcSigner produces a verifiable 86-char proofValue", async () => {
    const seed = new Uint8Array(32).fill(7);
    const signer = new Ed25519VcSigner({
      issuerDid: "did:eto:test:real-audit",
      secretKey: seed,
      clock: () => new Date("2025-06-01T00:00:00Z"),
    });
    const feed = await makeIndexer(signer).buildAuditFeed(AUTH);

    expect(feed.issuer).toBe("did:eto:test:real-audit");
    expect(feed.proof?.proofValue).toHaveLength(86);

    const { proof: _omit, ...withoutProof } = feed;
    const digest = proofPreimage(withoutProof);
    const sig = Buffer.from(feed.proof!.proofValue, "base64url");
    const pub = await ed25519.getPublicKeyAsync(seed);
    expect(await ed25519.verifyAsync(sig, digest, pub)).toBe(true);
  });

  it("backward compat: signer undefined ⇒ no proof, original placeholder issuer", async () => {
    const feed = await makeIndexer().buildAuditFeed(AUTH);
    expect(feed.issuer).toBe(AUDIT_TRAIL_ISSUER_DID);
    expect(feed.proof).toBeUndefined();
  });

  it("NoOpVcSigner short-circuits to v0 unsigned output", async () => {
    const feed = await makeIndexer(new NoOpVcSigner("did:test:noop")).buildAuditFeed(
      AUTH,
    );
    expect(feed.issuer).toBe(AUDIT_TRAIL_ISSUER_DID);
    expect(feed.proof).toBeUndefined();
  });
});
