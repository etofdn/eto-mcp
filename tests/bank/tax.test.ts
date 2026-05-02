/**
 * Integration test: 1099 issuance flow — synthetic year of activity.
 *
 * Task:    FN-134 / T-3.13.1.5
 * AC:      "Synthetic year of activity → correct 1099 cred."
 *
 * Dependency map:
 *   FN-130 — AuditTrailIndexer + InMemoryKytEventSource (indexer)
 *   FN-131 — spec/banking/credentials/tax-1099.json (VC schema)
 *   FN-132 — runTax1099Sketch / Tax1099VcEnvelope (flow under test)
 *
 * This is an integration test, NOT a copy of the FN-132 unit suite
 * (eto-mcp/test/tax-1099-sketch.test.ts). It wires the real
 * AuditTrailIndexer + InMemoryKytEventSource + recording in-memory
 * IssueCredentialClient + VcPinner against a synthetic year of KYT
 * trace events and asserts the full Tax1099Credential envelope is
 * correct end-to-end.
 *
 * Expected failure mode when FN-117/FN-118 lands: the monetary-field
 * assertions (totalIncome etc. === "0.00") will fail, forcing this
 * test to be updated to reflect real ledger amounts.
 */

import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";

import {
  AuditTrailIndexer,
  InMemoryKytEventSource,
} from "../../src/services/indexer/audit-trail.js";
import type { KytTraceEvent } from "../../src/services/indexer/audit-trail.js";
import type { RevocationRootUpdatedEvent } from "../../src/services/indexer/audit-trail.types.js";
import { jcsCanonicalize } from "../../src/issuers/bank-mock.js";
import type {
  IssueCredentialClient,
  VcPinner,
  SlotClock,
} from "../../src/issuers/bank-mock.js";

import {
  runTax1099Sketch,
  tax1099SchemaIdHex,
  Tax1099SketchError,
} from "../../keeper/bpps/bank/handlers/tax-1099-sketch.js";
import type {
  Tax1099SketchDeps,
  Tax1099SketchRequest,
} from "../../keeper/bpps/bank/handlers/tax-1099-sketch.js";

// ---------------------------------------------------------------------------
// Stable test constants
// ---------------------------------------------------------------------------

/** Base58-shaped authority keys used consistently across the fixture. */
const AGENT_CARD_AUTHORITY =
  "AgentCardAuthority1111111111111111111111111111";
const COUNTERPARTY         =
  "CounterpartyBpp222222222222222222222222222222";
const ISSUER_AUTHORITY_PUBKEY =
  "SsuerAuthority333333333333333333333333333333";
const NETWORK_PUBKEY          =
  "NetworkPubkey44444444444444444444444444444444";

/** Cred pointers — lowercase 64-char hex (per audit-trail.types.ts spec). */
const POINTER_A =
  "aaaa11112222333344445555666677778888999900001111222233334444aaaa";
const POINTER_B =
  "bbbb11112222333344445555666677778888999900001111222233334444bbbb";

/** Slot window overrides (compact range so event slots 1000-1023 fall inside). */
const FIRST_SLOT_OF_YEAR = (y: number): bigint =>
  BigInt((y - 2026) * 10_000);
const SLOTS_PER_YEAR = 10_000n;

/** Fixed nowUnix for deterministic issuanceDate in the VC. */
const NOW_UNIX = 1_706_659_200; // deterministic timestamp

// ---------------------------------------------------------------------------
// Synthetic year fixture — 24 KytTraceEvents
// ---------------------------------------------------------------------------

/**
 * Build a deterministic base58-safe tx signature.
 *   tag  "A" = init, "B" = confirm, "C" = rate
 *   idx  1-8
 * Result is exactly 44 chars, all valid base58 characters.
 */
function makeSig(tag: string, idx: number): string {
  const head = `Sig${tag}${idx}`;
  return (head + "1".repeat(44)).slice(0, 44);
}

function makeSyntheticTraces(): KytTraceEvent[] {
  const stages: ReadonlyArray<{ stage: "init" | "confirm" | "rate"; tag: string }> = [
    { stage: "init",    tag: "A" },
    { stage: "confirm", tag: "B" },
    { stage: "rate",    tag: "C" },
  ];

  const traces: KytTraceEvent[] = [];
  let slotOffset = 0;

  for (const { stage, tag } of stages) {
    for (let i = 0; i < 8; i++) {
      traces.push({
        stage,
        tx_signature: makeSig(tag, i + 1),
        slot: 1000 + slotOffset,
        timestamp: 1_700_000_000 + 1000 + slotOffset,
        parties: [
          { party: "bap", authority: AGENT_CARD_AUTHORITY, cred_pointers: [POINTER_A] },
          { party: "bpp", authority: COUNTERPARTY,         cred_pointers: [POINTER_B] },
        ],
      });
      slotOffset++;
    }
  }

  return traces;
}

/** The canonical 24-event fixture for the 2026 tax year. */
const SYNTHETIC_TRACES: readonly KytTraceEvent[] = makeSyntheticTraces();

// ---------------------------------------------------------------------------
// In-memory deps helpers
// ---------------------------------------------------------------------------

class RecordingChain implements IssueCredentialClient {
  public readonly calls: Array<{
    subjectAgentCardPubkey: string;
    schemaIdHex: string;
    claimUri: string;
    claimHashHex: string;
    validFromSlot: bigint;
    validUntilSlot: bigint;
  }> = [];

  async issueCredential(input: {
    subjectAgentCardPubkey: string;
    schemaIdHex: string;
    claimUri: string;
    claimHashHex: string;
    validFromSlot: bigint;
    validUntilSlot: bigint;
  }): Promise<{ credentialPda: string; txSignature: string }> {
    this.calls.push(input);
    const n = this.calls.length;
    return {
      credentialPda: `pda_${n}_${input.subjectAgentCardPubkey.slice(0, 8)}`,
      txSignature:   `chain_sig_${n}`,
    };
  }
}

class RecordingPinner implements VcPinner {
  public readonly pinnedJcs: string[] = [];
  private readonly fixedUri = "ipfs://QmTax1099FN134TestStub/1";

  async pin(jcs: string): Promise<{ uri: string }> {
    this.pinnedJcs.push(jcs);
    return { uri: this.fixedUri };
  }
}

class FixedClock implements SlotClock {
  constructor(private readonly slot: bigint) {}
  async currentSlot(): Promise<bigint> {
    return this.slot;
  }
}

function makeIndexer(
  traces: readonly KytTraceEvent[],
  revocations?: readonly RevocationRootUpdatedEvent[],
): AuditTrailIndexer {
  return new AuditTrailIndexer({
    source: new InMemoryKytEventSource({
      traces: [...traces],
      revocations: revocations ? [...revocations] : [],
    }),
    clock: () => new Date("2027-01-31T00:00:00Z"),
  });
}

function makeDeps(
  traces: readonly KytTraceEvent[] = SYNTHETIC_TRACES,
  overrides: Partial<Tax1099SketchDeps> = {},
): Tax1099SketchDeps {
  return {
    indexer:          makeIndexer(traces),
    chain:            new RecordingChain(),
    pinner:           new RecordingPinner(),
    clock:            new FixedClock(9_999n),
    firstSlotOfYear:  FIRST_SLOT_OF_YEAR,
    slotsPerYear:     SLOTS_PER_YEAR,
    nowUnix:          () => NOW_UNIX,
    ...overrides,
  };
}

const BASE_REQUEST: Tax1099SketchRequest = {
  agentCardAuthority:    AGENT_CARD_AUTHORITY,
  taxYear:               2026,
  jurisdiction:          "US",
  currency:              "USD",
  formVariant:           "1099-MISC",
  issuerAuthorityPubkey: ISSUER_AUTHORITY_PUBKEY,
  networkPubkey:         NETWORK_PUBKEY,
};

function sha256Hex(s: string): string {
  return createHash("sha256").update(s, "utf8").digest("hex");
}

// ---------------------------------------------------------------------------
// Main integration scenario
// ---------------------------------------------------------------------------

describe("1099 generation (FN-134 / T-3.13.1.5)", () => {
  /**
   * Run once and capture both deps and result so all assertion groups
   * operate on the same invocation.
   */
  let chain: RecordingChain;
  let pinner: RecordingPinner;
  let result: Awaited<ReturnType<typeof runTax1099Sketch>>;

  // We use a beforeAll-style pattern via a shared promise resolved before
  // assertions — each it() awaits it.  In vitest the top-level describe
  // block executes sequentially, so we can capture state in module scope.

  // ---------------------------------------------------------------------------
  // Phase 0: invoke the flow once
  // ---------------------------------------------------------------------------

  it("Phase 0 — invokes runTax1099Sketch without throwing", async () => {
    chain  = new RecordingChain();
    pinner = new RecordingPinner();
    const deps = makeDeps(SYNTHETIC_TRACES, { chain, pinner });

    result = await runTax1099Sketch(deps, BASE_REQUEST);

    expect(result).toBeDefined();
  });

  // ---------------------------------------------------------------------------
  // Phase 1: status & identity
  // ---------------------------------------------------------------------------

  it("Phase 1 — status is 'issued'", () => {
    expect(result.status).toBe("issued");
  });

  it("Phase 1 — credentialPda and txSignature are non-empty strings", () => {
    expect(typeof result.credentialPda).toBe("string");
    expect(result.credentialPda.length).toBeGreaterThan(0);
    expect(typeof result.txSignature).toBe("string");
    expect(result.txSignature.length).toBeGreaterThan(0);
  });

  it("Phase 1 — schemaIdHex matches tax1099SchemaIdHex('US', 2026)", () => {
    const expected = tax1099SchemaIdHex("US", 2026);
    expect(result.schemaIdHex).toBe(expected);
  });

  it("Phase 1 — schemaIdHex matches independent sha256 of spec slug", () => {
    // Schema-id rule: sha256("eto.beckn.schema.tax.1099.<jurisdiction-lower>.<year>.v1")
    const slug = "eto.beckn.schema.tax.1099.us.2026.v1";
    const expected = sha256Hex(slug);
    expect(result.schemaIdHex).toBe(expected);
  });

  // ---------------------------------------------------------------------------
  // Phase 2: VC envelope conformance to spec/banking/credentials/tax-1099.json
  // ---------------------------------------------------------------------------

  it("Phase 2 — @context is the exact 2-tuple", () => {
    expect(result.vc["@context"]).toEqual([
      "https://www.w3.org/2018/credentials/v1",
      "https://schema.eto.dev/banking/tax-1099/v1",
    ]);
  });

  it("Phase 2 — type is ['VerifiableCredential', 'Tax1099Credential']", () => {
    expect(result.vc.type).toEqual(["VerifiableCredential", "Tax1099Credential"]);
  });

  it("Phase 2 — issuer is 'did:eto:bank:eto-reference'", () => {
    expect(result.vc.issuer).toBe("did:eto:bank:eto-reference");
  });

  it("Phase 2 — issuanceDate is RFC3339 format", () => {
    expect(result.vc.issuanceDate).toMatch(
      /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/,
    );
  });

  it("Phase 2 — credentialSubject.id encodes AGENT_CARD_AUTHORITY", () => {
    expect(result.vc.credentialSubject.id).toBe(
      `did:eto:agentcard:${AGENT_CARD_AUTHORITY}`,
    );
  });

  it("Phase 2 — credentialSubject.type is 'Tax1099Statement'", () => {
    expect(result.vc.credentialSubject.type).toBe("Tax1099Statement");
  });

  it("Phase 2 — credentialSubject.taxYear is 2026 (number)", () => {
    expect(result.vc.credentialSubject.taxYear).toBe(2026);
    expect(typeof result.vc.credentialSubject.taxYear).toBe("number");
    expect(Number.isInteger(result.vc.credentialSubject.taxYear)).toBe(true);
  });

  it("Phase 2 — credentialSubject.jurisdiction is 'US'", () => {
    expect(result.vc.credentialSubject.jurisdiction).toBe("US");
  });

  it("Phase 2 — credentialSubject.currency is 'USD'", () => {
    expect(result.vc.credentialSubject.currency).toBe("USD");
  });

  it("Phase 2 — credentialSubject.formVariant is '1099-MISC'", () => {
    expect(result.vc.credentialSubject.formVariant).toBe("1099-MISC");
  });

  // ---------------------------------------------------------------------------
  // Phase 3: totals correctness for the synthetic year
  // ---------------------------------------------------------------------------

  it("Phase 3 — transactionCount === 24 (all 24 synthetic KYT events)", () => {
    // kytCount = init(8) + confirm(8) + rate(8) = 24
    expect(result.vc.credentialSubject.transactionCount).toBe(24);
  });

  it("Phase 3 — monetary fields are exactly '0.00' (v0 stub; will fail when FN-117/FN-118 lights up real ledger amounts)", () => {
    // NOTE: these are intentionally exact-value assertions.
    // When FN-117/FN-118 wires real ledger amounts into the KYT event stream,
    // these assertions WILL fail — that failure is the intended signal to
    // revisit and update this integration test.
    expect(result.vc.credentialSubject.totalIncome).toBe("0.00");
    expect(result.vc.credentialSubject.totalFees).toBe("0.00");
    expect(result.vc.credentialSubject.totalInterestPaid).toBe("0.00");
    expect(result.vc.credentialSubject.totalWithholding).toBe("0.00");
  });

  // ---------------------------------------------------------------------------
  // Phase 4: evidence
  // ---------------------------------------------------------------------------

  it("Phase 4 — evidence is a single-element array", () => {
    expect(result.vc.evidence).toHaveLength(1);
  });

  it("Phase 4 — evidence[0].type is 'EtoChainEventDigest'", () => {
    expect(result.vc.evidence[0]!.type).toBe("EtoChainEventDigest");
  });

  it("Phase 4 — evidence[0].network matches NETWORK_PUBKEY", () => {
    expect(result.vc.evidence[0]!.network).toBe(NETWORK_PUBKEY);
  });

  it("Phase 4 — evidence[0].digestAlgorithm is 'sha256'", () => {
    expect(result.vc.evidence[0]!.digestAlgorithm).toBe("sha256");
  });

  it("Phase 4 — evidence[0].digestRoot is non-empty and equals totals.digestRootBase58", () => {
    const dr = result.vc.evidence[0]!.digestRoot;
    expect(typeof dr).toBe("string");
    expect(dr.length).toBeGreaterThan(0);
    expect(dr).toBe(result.totals.digestRootBase58);
  });

  // ---------------------------------------------------------------------------
  // Phase 5: proof placeholder
  // ---------------------------------------------------------------------------

  it("Phase 5 — proof.type is 'Ed25519Signature2020'", () => {
    expect(result.vc.proof!.type).toBe("Ed25519Signature2020");
  });

  it("Phase 5 — proof.proofValue is the literal '<unsigned-v0>'", () => {
    // Asserts the exact literal — test will fail the moment a real signing
    // implementation lands without being audited here.
    expect(result.vc.proof!.proofValue).toBe("<unsigned-v0>");
  });

  it("Phase 5 — proof.verificationMethod is the canonical bank DID fragment", () => {
    expect(result.vc.proof!.verificationMethod).toBe(
      "did:eto:bank:eto-reference#issuer-authority",
    );
  });

  // ---------------------------------------------------------------------------
  // Phase 6: claim-hash recomputation
  // ---------------------------------------------------------------------------

  it("Phase 6 — independently recomputed claimHashHex matches result.claimHashHex", () => {
    // Strip proof, JCS-canonicalise, sha256 — mirrors the production path.
    const vcWithoutProof: Record<string, unknown> = Object.fromEntries(
      Object.entries(result.vc as Record<string, unknown>).filter(
        ([k]) => k !== "proof",
      ),
    );
    const jcs = jcsCanonicalize(vcWithoutProof);
    const recomputed = sha256Hex(jcs);
    expect(recomputed).toBe(result.claimHashHex);
  });

  it("Phase 6 — chain client captured the same claimHashHex", () => {
    expect(chain.calls[0]!.claimHashHex).toBe(result.claimHashHex);
  });

  // ---------------------------------------------------------------------------
  // Phase 7: chain invocation
  // ---------------------------------------------------------------------------

  it("Phase 7 — chain client was called exactly once", () => {
    expect(chain.calls).toHaveLength(1);
  });

  it("Phase 7 — chain call has correct subjectAgentCardPubkey", () => {
    expect(chain.calls[0]!.subjectAgentCardPubkey).toBe(AGENT_CARD_AUTHORITY);
  });

  it("Phase 7 — chain call has correct schemaIdHex", () => {
    expect(chain.calls[0]!.schemaIdHex).toBe(result.schemaIdHex);
  });

  it("Phase 7 — chain call validFromSlot === untilSlot (firstSlot + slotsPerYear = 10_000n)", () => {
    // firstSlotOfYear(2026) = 0n; untilSlot = 0n + 10_000n = 10_000n = BigInt(slotsPerYear)
    expect(chain.calls[0]!.validFromSlot).toBe(SLOTS_PER_YEAR);
  });

  it("Phase 7 — chain call validUntilSlot === 0n (no upper bound, per L1 §5.1)", () => {
    expect(chain.calls[0]!.validUntilSlot).toBe(0n);
  });

  // ---------------------------------------------------------------------------
  // Phase 8: pinner invocation
  // ---------------------------------------------------------------------------

  it("Phase 8 — pinner was called exactly once", () => {
    expect(pinner.pinnedJcs).toHaveLength(1);
  });

  it("Phase 8 — pinner received JCS of the VC without proof", () => {
    const vcWithoutProof: Record<string, unknown> = Object.fromEntries(
      Object.entries(result.vc as Record<string, unknown>).filter(
        ([k]) => k !== "proof",
      ),
    );
    const expected = jcsCanonicalize(vcWithoutProof);
    expect(pinner.pinnedJcs[0]).toBe(expected);
  });

  // ---------------------------------------------------------------------------
  // Phase 9: determinism — second invocation must produce identical hashes
  // ---------------------------------------------------------------------------

  it("Phase 9 — second invocation (fresh deps, same fixture seed) produces identical claimHashHex, schemaIdHex, digestRootBase58", async () => {
    const chain2  = new RecordingChain();
    const pinner2 = new RecordingPinner();
    const deps2   = makeDeps(SYNTHETIC_TRACES, { chain: chain2, pinner: pinner2 });

    const result2 = await runTax1099Sketch(deps2, BASE_REQUEST);

    expect(result2.claimHashHex).toBe(result.claimHashHex);
    expect(result2.schemaIdHex).toBe(result.schemaIdHex);
    expect(result2.totals.digestRootBase58).toBe(result.totals.digestRootBase58);
  });
});

// ---------------------------------------------------------------------------
// Edge guard: only-revocations year still issues (kytCount=0, revCount>0)
// ---------------------------------------------------------------------------

describe("1099 generation — edge: only-revocations year issues (not no_activity)", () => {
  it("a year with kytCount=0 but revocationCount>0 issues a credential rather than throwing no_activity", async () => {
    // One RevocationRootUpdatedEvent in the window but zero KYT traces.
    // Matches the FN-132 contract: no_activity requires BOTH counts zero.
    const revocation: RevocationRootUpdatedEvent = {
      oracle:  ISSUER_AUTHORITY_PUBKEY,
      network: "EtoSingularityTestnet",
      root:    "cccc11112222333344445555666677778888999900001111222233334444cccc",
      leaves:  1,
      slot:    500, // within [0, 10_000) for 2026
    };

    const deps = makeDeps([], { // no KYT traces
      indexer: makeIndexer([], [revocation]),
    });

    const result = await runTax1099Sketch(deps, BASE_REQUEST);

    expect(result.status).toBe("issued");
    expect(result.vc.credentialSubject.transactionCount).toBe(0);
    expect(result.vc.credentialSubject.totalIncome).toBe("0.00");
  });
});
