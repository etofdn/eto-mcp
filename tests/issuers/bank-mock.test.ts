/**
 * FN-018 — bank-mock issuer boundary suite.
 *
 * No-signature issuer: tampered-signature is N/A. We substitute the
 * tampered-envelope invariant per the PROMPT — mutate the pinned VC,
 * recompute `sha256(jcs(...))`, and assert the mutated hash diverges
 * from the on-chain `claim_hash`. Expiry is N/A — `validUntilSlot = 0`
 * is hard-coded; a `revokeBankFiatRampTest` round-trip is the runtime
 * substitute.
 */

import { describe, expect, it } from "vitest";

import {
  BANK_FIAT_RAMP_TEST_SCHEMA_ID_HEX,
  BankMockIssueError,
  InMemoryBankMockStore,
  buildBankFiatRampTestVc,
  issueBankFiatRampTest,
  jcsCanonicalize,
  revokeBankFiatRampTest,
  sha256Hex,
} from "../../src/issuers/bank-mock.js";
import type {
  BankMockIssuerDeps,
  IssueCredentialClient,
  RevokeCredentialClient,
  SlotClock,
  VcPinner,
} from "../../src/issuers/bank-mock.types.js";

/* -------------------------------------------------------------------------- */
/* Fakes                                                                       */
/* -------------------------------------------------------------------------- */

const ISSUER = "BankMockIssuerAuthority1111111111111111111";
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

  async issueCredential(input: ChainCall) {
    this.calls.push(input);
    const idx = this.calls.length;
    return {
      credentialPda: `pda_${idx}_${input.subjectAgentCardPubkey.slice(0, 6)}`,
      txSignature: `sig_${idx.toString().padStart(4, "0")}`,
    };
  }
}

class StubRevoker implements RevokeCredentialClient {
  public readonly calls: Array<{ credentialPda: string }> = [];
  async revokeCredential(input: { credentialPda: string }) {
    this.calls.push(input);
    const idx = this.calls.length;
    return { txSignature: `revtx_${idx.toString().padStart(4, "0")}` };
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
  readonly deps: BankMockIssuerDeps;
  readonly chain: StubChain;
  readonly revoker: StubRevoker;
  readonly pinner: StubPinner;
  readonly store: InMemoryBankMockStore;
  readonly nowRef: { value: number };
}

function bankMockDeps(opts?: { initialNow?: number }): BuiltStack {
  const chain = new StubChain();
  const revoker = new StubRevoker();
  const pinner = new StubPinner();
  const store = new InMemoryBankMockStore();
  const nowRef = { value: opts?.initialNow ?? 1_700_000_000 };
  const deps: BankMockIssuerDeps = {
    store,
    chain,
    revoker,
    pinner,
    clock: new FixedClock(123_456n),
    issuerAuthorityPubkey: ISSUER,
    nowUnix: () => nowRef.value,
  };
  return { deps, chain, revoker, pinner, store, nowRef };
}

/* -------------------------------------------------------------------------- */
/* Tests                                                                       */
/* -------------------------------------------------------------------------- */

describe("bank-mock issuer — boundary suite (FN-018)", () => {
  it("happy issuance: status=issued, schema = BANK_FIAT_RAMP_TEST_SCHEMA_ID_HEX, subject from caller", async () => {
    const { deps, chain, pinner, store } = bankMockDeps();

    // Pre-seed an unrelated row to defend against subject-derivation
    // regressions: even if the issuer accidentally read the store
    // when populating the VC, an UNRELATED row must not pollute
    // the call we're about to make.
    await store.putIfAbsent({
      checkingAccountId: "unrelated-account-id",
      agentCardPubkey: CARD_UNRELATED,
      credentialPda: "unrelated-pda",
      txSignature: "unrelated-sig",
      claimUri: "ipfs://unrelated",
      issuedAtUnix: 1,
      revoked: false,
    });

    const out = await issueBankFiatRampTest(deps, {
      checkingAccountId: "chk-001",
      agentCardPubkey: CARD_A,
    });
    expect(out.status).toBe("issued");
    if (out.status !== "issued") return;
    expect(chain.calls).toHaveLength(1);
    expect(chain.calls[0]?.schemaIdHex).toBe(
      BANK_FIAT_RAMP_TEST_SCHEMA_ID_HEX,
    );
    expect(chain.calls[0]?.subjectAgentCardPubkey).toBe(CARD_A);
    expect(chain.calls[0]?.validUntilSlot).toBe(0n);

    const vc = pinner.fetch(out.claimUri);
    expect(out.claimHashHex).toBe(sha256Hex(jcsCanonicalize(vc)));
    const subj = vc["credentialSubject"] as Record<string, unknown>;
    expect(subj["checkingAccountId"]).toBe("chk-001");
    expect(subj["id"]).toBe(`did:eto:agentcard:${CARD_A}`);
  });

  it("replay (same id+card): status=idempotent — no second chain tx", async () => {
    const { deps, chain } = bankMockDeps();
    const r1 = await issueBankFiatRampTest(deps, {
      checkingAccountId: "chk-001",
      agentCardPubkey: CARD_A,
    });
    const r2 = await issueBankFiatRampTest(deps, {
      checkingAccountId: "chk-001",
      agentCardPubkey: CARD_A,
    });
    expect(r1.status).toBe("issued");
    expect(r2.status).toBe("idempotent");
    expect(r2.credentialPda).toBe(r1.credentialPda);
    expect(chain.calls).toHaveLength(1);
  });

  it("replay (same id, DIFFERENT card): throws BankMockIssueError(binding_conflict); chain still 1 call", async () => {
    const { deps, chain } = bankMockDeps();
    await issueBankFiatRampTest(deps, {
      checkingAccountId: "chk-001",
      agentCardPubkey: CARD_A,
    });
    let caught: unknown;
    try {
      await issueBankFiatRampTest(deps, {
        checkingAccountId: "chk-001",
        agentCardPubkey: CARD_B,
      });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(BankMockIssueError);
    expect((caught as BankMockIssueError).kind).toBe("binding_conflict");
    expect(chain.calls).toHaveLength(1);
  });

  it("tampered envelope (no-signature issuer): mutated VC hash differs from claim_hash", async () => {
    const { deps, pinner } = bankMockDeps();
    const out = await issueBankFiatRampTest(deps, {
      checkingAccountId: "chk-001",
      agentCardPubkey: CARD_A,
    });
    if (out.status !== "issued") throw new Error("unexpected status");
    const vc = pinner.fetch(out.claimUri);
    expect(out.claimHashHex).toBe(sha256Hex(jcsCanonicalize(vc)));

    const mutated = { ...vc, issuer: "did:eto:other-bank" };
    expect(sha256Hex(jcsCanonicalize(mutated))).not.toBe(out.claimHashHex);
  });

  // NB: bank-mock hard-codes valid_until_slot = 0; expiry is an
  // on-chain concern. Revocation is the runtime substitute — covered below.

  it("revocation round-trip: revoked → already_revoked (idempotent)", async () => {
    const { deps, revoker } = bankMockDeps();
    await issueBankFiatRampTest(deps, {
      checkingAccountId: "chk-001",
      agentCardPubkey: CARD_A,
    });
    const r1 = await revokeBankFiatRampTest(deps, {
      checkingAccountId: "chk-001",
    });
    expect(r1.status).toBe("revoked");
    expect(revoker.calls).toHaveLength(1);

    const r2 = await revokeBankFiatRampTest(deps, {
      checkingAccountId: "chk-001",
    });
    expect(r2.status).toBe("already_revoked");
    // No second on-chain RevokeCredential tx.
    expect(revoker.calls).toHaveLength(1);
  });

  it("VC envelope shape: credentialSubject locks the checking-account binding", () => {
    const vc = buildBankFiatRampTestVc({
      agentCardPubkey: CARD_A,
      issuerAuthorityPubkey: ISSUER,
      checkingAccountId: "chk-shape-001",
      issuanceDate: "2026-04-29T00:00:00.000Z",
    });
    const subj = vc["credentialSubject"] as Record<string, unknown>;
    expect(Object.keys(subj).sort()).toEqual([
      "bankBindingType",
      "checkingAccountId",
      "id",
      "mockIssuer",
    ]);
    expect(subj["mockIssuer"]).toBe(true);
    expect(subj["bankBindingType"]).toBe("checking-account");
  });

  it("emits unique credentials across two independent issuances", async () => {
    const { deps, chain, pinner, nowRef } = bankMockDeps();
    const r1 = await issueBankFiatRampTest(deps, {
      checkingAccountId: "chk-aaa",
      agentCardPubkey: CARD_A,
    });
    nowRef.value += 60;
    const r2 = await issueBankFiatRampTest(deps, {
      checkingAccountId: "chk-bbb",
      agentCardPubkey: CARD_B,
    });
    expect(r1.credentialPda).not.toBe(r2.credentialPda);
    expect(chain.calls).toHaveLength(2);
    const vc1 = pinner.fetch(r1.claimUri);
    const vc2 = pinner.fetch(r2.claimUri);
    expect(vc1["issuanceDate"]).not.toBe(vc2["issuanceDate"]);
    const s1 = vc1["credentialSubject"] as Record<string, unknown>;
    const s2 = vc2["credentialSubject"] as Record<string, unknown>;
    expect(s1["checkingAccountId"]).not.toBe(s2["checkingAccountId"]);
  });
});
