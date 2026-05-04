// FN-014 owns deep coverage at test/bank.test.ts; this file pins boundary parity with the rest of tests/issuers/.
//
// FN-018 — bank issuer (production) thin boundary-parity suite.
//
// `bank.ts` is a no-signature issuer. Tampered-signature is N/A;
// tampered-envelope is the substituted invariant. `validUntilSlot`
// is hard-coded to 0n for all three families (checking/savings/card)
// — `expiresSlot` on the card-debit input flows ONLY into the VC
// body as `credentialSubject.expires_slot`, never into the on-chain
// `validUntilSlot`. We lock both halves of that contract.

import { describe, expect, it } from "vitest";

import {
  BANK_ISSUER_SCHEMA_IDS_HEX,
  BankIssuerError,
  InMemoryBankIssuerStore,
  issueCardCredential,
  issueCheckingCredential,
  jcsCanonicalize,
  sha256Hex,
} from "../../src/issuers/bank.js";
import type {
  BankIssuerDeps,
  IssueCredentialClient,
  RevokeCredentialClient,
  SlotClock,
  VcPinner,
} from "../../src/issuers/bank.types.js";

/* -------------------------------------------------------------------------- */
/* Fakes                                                                       */
/* -------------------------------------------------------------------------- */

const ISSUER = "BankIssuerAuthority1111111111111111111111111";
const CARD_A = "AgentCardA1111111111111111111111111111111111";
const CARD_B = "AgentCardB2222222222222222222222222222222222";
const CARD_UNRELATED = "AgentCardZ9999999999999999999999999999999999";

interface ChainCall {
  subjectAgentCardPubkey: string;
  schemaIdHex: string;
  claimUri: string;
  claimHashHex: string;
  validFromSlot: bigint;
  validUntilSlot: bigint;
}

class StubChain implements IssueCredentialClient {
  public readonly calls: ChainCall[] = [];
  public failNext = false;

  async issueCredential(input: ChainCall) {
    if (this.failNext) {
      this.failNext = false;
      throw new Error("simulated rpc failure");
    }
    this.calls.push(input);
    const idx = this.calls.length;
    return {
      credentialPda: `pda_${idx}_${input.subjectAgentCardPubkey.slice(0, 6)}`,
      txSignature: `sig_${idx.toString().padStart(4, "0")}`,
    };
  }
}

class StubRevoker implements RevokeCredentialClient {
  async revokeCredential() {
    return { txSignature: "revtx_unused" };
  }
}

class StubPinner implements VcPinner {
  public readonly pinned: string[] = [];
  async pin(json: string) {
    this.pinned.push(json);
    return { uri: `ipfs://stub/${this.pinned.length}` };
  }
  fetch(uri: string): Record<string, unknown> {
    const idx = Number(uri.replace("ipfs://stub/", ""));
    const json = this.pinned[idx - 1];
    if (json === undefined) throw new Error(`unknown uri: ${uri}`);
    return JSON.parse(json) as Record<string, unknown>;
  }
}

class FixedClock implements SlotClock {
  public constructor(private readonly slot: bigint) {}
  async currentSlot(): Promise<bigint> {
    return this.slot;
  }
}

interface BuiltStack {
  readonly deps: BankIssuerDeps;
  readonly chain: StubChain;
  readonly pinner: StubPinner;
  readonly store: InMemoryBankIssuerStore;
  readonly nowRef: { value: number };
}

function bankDeps(opts?: { initialNow?: number }): BuiltStack {
  const chain = new StubChain();
  const pinner = new StubPinner();
  const store = new InMemoryBankIssuerStore();
  const nowRef = { value: opts?.initialNow ?? 1_700_000_000 };
  const deps: BankIssuerDeps = {
    store,
    chain,
    revoker: new StubRevoker(),
    pinner,
    clock: new FixedClock(123_456n),
    issuerAuthorityPubkey: ISSUER,
    nowUnix: () => nowRef.value,
  };
  return { deps, chain, pinner, store, nowRef };
}

function checkingInput(overrides?: {
  readonly subjectAgentCardPubkey?: string;
  readonly checkingAccountPda?: string;
}) {
  return {
    subjectAgentCardPubkey: overrides?.subjectAgentCardPubkey ?? CARD_A,
    checkingAccountPda:
      overrides?.checkingAccountPda ?? "checkingAcctPda01".padEnd(64, "0"),
    holder: CARD_A,
    openedSlot: 1234,
    currency: "eUSD" as const,
    openingBalance: 0,
  };
}

/* -------------------------------------------------------------------------- */
/* Tests                                                                       */
/* -------------------------------------------------------------------------- */

describe("bank issuer — boundary parity (FN-018)", () => {
  it("happy issuance: status=issued, schema = account.checking, validUntilSlot=0n, subject from caller", async () => {
    const { deps, chain, store } = bankDeps();

    // Pre-seed an unrelated row under a different kind so a
    // store-derivation regression would surface as a failed
    // subject-provenance assertion below.
    await store.putIfAbsent({
      kind: "account.savings",
      bindingKey: "unrelated-savings-pda",
      agentCardPubkey: CARD_UNRELATED,
      credentialPda: "unrelated-pda",
      txSignature: "unrelated-sig",
      claimUri: "ipfs://unrelated",
      issuedAtUnix: 1,
      revoked: false,
    });

    const out = await issueCheckingCredential(deps, checkingInput());
    expect(out.status).toBe("issued");
    if (out.status !== "issued") return;
    expect(chain.calls).toHaveLength(1);
    expect(chain.calls[0]?.schemaIdHex).toBe(
      BANK_ISSUER_SCHEMA_IDS_HEX["account.checking"],
    );
    expect(chain.calls[0]?.subjectAgentCardPubkey).toBe(CARD_A);
    expect(chain.calls[0]?.validUntilSlot).toBe(0n);
  });

  it("replay (same PDA + same card): status=idempotent — no second chain tx", async () => {
    const { deps, chain } = bankDeps();
    const r1 = await issueCheckingCredential(deps, checkingInput());
    const r2 = await issueCheckingCredential(deps, checkingInput());
    expect(r1.status).toBe("issued");
    expect(r2.status).toBe("idempotent");
    expect(r2.credentialPda).toBe(r1.credentialPda);
    expect(chain.calls).toHaveLength(1);
  });

  it("replay (same PDA, DIFFERENT card): throws BankIssuerError(binding_conflict, 409-equivalent)", async () => {
    const { deps, chain } = bankDeps();
    await issueCheckingCredential(deps, checkingInput());
    let caught: unknown;
    try {
      await issueCheckingCredential(
        deps,
        checkingInput({ subjectAgentCardPubkey: CARD_B }),
      );
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(BankIssuerError);
    expect((caught as BankIssuerError).kind).toBe("binding_conflict");
    expect(chain.calls).toHaveLength(1);
  });

  it("tampered envelope (no-signature issuer): mutated VC hash differs from claim_hash", async () => {
    const { deps, pinner, chain } = bankDeps();
    const out = await issueCheckingCredential(deps, checkingInput());
    if (out.status !== "issued") throw new Error("unexpected status");
    const vc = pinner.fetch(out.claimUri);
    expect(out.claimHashHex).toBe(sha256Hex(jcsCanonicalize(vc)));
    expect(chain.calls[0]?.claimHashHex).toBe(out.claimHashHex);
    const mutated = { ...vc, issuer: "did:eto:other-bank" };
    expect(sha256Hex(jcsCanonicalize(mutated))).not.toBe(out.claimHashHex);
  });

  it("card-debit with expiresSlot: VC body carries expires_slot; chain validUntilSlot stays 0n", async () => {
    // The only expiry-bearing input on the production bank issuer.
    // Per `src/issuers/bank.ts`, `expiresSlot` flows into the VC body
    // as `credentialSubject.expires_slot`; it is NOT propagated to
    // the on-chain `validUntilSlot`, which is hard-coded to 0n.
    const { deps, chain, pinner } = bankDeps();
    const out = await issueCardCredential(deps, {
      subjectAgentCardPubkey: CARD_A,
      cardIdHash: "ab".repeat(32),
      holder: CARD_A,
      linkedAccountPda: "lnk".padEnd(64, "0"),
      jurisdiction: "us",
      issuedSlot: 1234,
      spendingLimitPerDay: 1_000_000,
      expiresSlot: 9_999_999,
    });
    if (out.status !== "issued") throw new Error("unexpected status");
    expect(chain.calls).toHaveLength(1);
    // No on-chain expiry — bank.ts always passes validUntilSlot = 0n.
    expect(chain.calls[0]?.validUntilSlot).toBe(0n);
    const vc = pinner.fetch(out.claimUri);
    const subj = vc["credentialSubject"] as Record<string, unknown>;
    expect(subj["expires_slot"]).toBe(9_999_999);
  });

  it("chain-failure isolation: BankIssuerError(chain_failed); store NOT mutated", async () => {
    const { deps, chain, store } = bankDeps();
    chain.failNext = true;
    let caught: unknown;
    try {
      await issueCheckingCredential(deps, checkingInput());
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(BankIssuerError);
    expect((caught as BankIssuerError).kind).toBe("chain_failed");
    // No row written for the failed input.
    const row = await store.get(
      "account.checking",
      "checkingAcctPda01".padEnd(64, "0"),
    );
    expect(row).toBeUndefined();
  });

  it("emits unique credentials across two independent issuances", async () => {
    const { deps, chain, pinner, nowRef } = bankDeps();
    const r1 = await issueCheckingCredential(
      deps,
      checkingInput({
        checkingAccountPda: "aaa".padEnd(64, "0"),
        subjectAgentCardPubkey: CARD_A,
      }),
    );
    nowRef.value += 60;
    const r2 = await issueCheckingCredential(
      deps,
      checkingInput({
        checkingAccountPda: "bbb".padEnd(64, "0"),
        subjectAgentCardPubkey: CARD_B,
      }),
    );
    expect(r1.credentialPda).not.toBe(r2.credentialPda);
    expect(chain.calls).toHaveLength(2);
    const vc1 = pinner.fetch(r1.claimUri);
    const vc2 = pinner.fetch(r2.claimUri);
    expect(vc1["issuanceDate"]).not.toBe(vc2["issuanceDate"]);
  });
});
