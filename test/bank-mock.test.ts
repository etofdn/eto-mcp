import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";

import {
  BANK_FIAT_RAMP_TEST_SCHEMA_ID_HEX,
  BankMockIssueError,
  BankMockIssuerDeps,
  BankMockRow,
  BankMockStore,
  InMemoryBankMockStore,
  IssueCredentialClient,
  RevokeCredentialClient,
  SlotClock,
  VcPinner,
  buildBankFiatRampTestVc,
  issueBankFiatRampTest,
  jcsCanonicalize,
  revokeBankFiatRampTest,
} from "../src/issuers/bank-mock.js";

const ACCT = "mock-checking-1234";
const ACCT_2 = "mock-checking-5678";
const CARD_A = "AgentCardAaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const CARD_B = "AgentCardBbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const ISSUER_AUTHORITY = "BankMockIssuerAuthority1111111111111111111";

interface ChainCall {
  subjectAgentCardPubkey: string;
  schemaIdHex: string;
  claimUri: string;
  claimHashHex: string;
  validFromSlot: bigint;
  validUntilSlot: bigint;
}

class StubChain implements IssueCredentialClient {
  public calls: ChainCall[] = [];
  public failNext = false;

  async issueCredential(input: ChainCall) {
    if (this.failNext) {
      this.failNext = false;
      throw new Error("simulated rpc failure");
    }
    this.calls.push(input);
    const idx = this.calls.length;
    return {
      credentialPda: `pda_${idx}_${input.subjectAgentCardPubkey.slice(0, 8)}`,
      txSignature: `sig_issue_${idx}`,
    };
  }
}

class StubRevoker implements RevokeCredentialClient {
  public calls: { credentialPda: string }[] = [];
  public failNext = false;

  async revokeCredential(input: { credentialPda: string }) {
    if (this.failNext) {
      this.failNext = false;
      throw new Error("simulated revoke rpc failure");
    }
    this.calls.push(input);
    return { txSignature: `sig_revoke_${this.calls.length}` };
  }
}

class StubPinner implements VcPinner {
  public pinned: string[] = [];
  async pin(json: string) {
    this.pinned.push(json);
    return { uri: `ipfs://stub/${this.pinned.length}` };
  }
}

class FixedClock implements SlotClock {
  public constructor(private readonly slot: bigint) {}
  async currentSlot() {
    return this.slot;
  }
}

function depsWith(
  overrides: Partial<BankMockIssuerDeps> = {},
): BankMockIssuerDeps {
  return {
    store: overrides.store ?? new InMemoryBankMockStore(),
    chain: overrides.chain ?? new StubChain(),
    revoker: overrides.revoker ?? new StubRevoker(),
    pinner: overrides.pinner ?? new StubPinner(),
    clock: overrides.clock ?? new FixedClock(100n),
    issuerAuthorityPubkey:
      overrides.issuerAuthorityPubkey ?? ISSUER_AUTHORITY,
    ...(overrides.nowUnix ? { nowUnix: overrides.nowUnix } : {}),
  };
}

function sha256Hex(input: string): string {
  return createHash("sha256").update(input, "utf8").digest("hex");
}

describe("BANK_FIAT_RAMP_TEST_SCHEMA_ID_HEX", () => {
  it("matches sha256('eto.beckn.schema.bank.fiat-ramp-test.v1')", () => {
    expect(BANK_FIAT_RAMP_TEST_SCHEMA_ID_HEX).toBe(
      sha256Hex("eto.beckn.schema.bank.fiat-ramp-test.v1"),
    );
    expect(BANK_FIAT_RAMP_TEST_SCHEMA_ID_HEX).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("issueBankFiatRampTest — happy path", () => {
  it("mints a credential bound to the checking-account-id", async () => {
    const chain = new StubChain();
    const pinner = new StubPinner();
    const store = new InMemoryBankMockStore();
    const deps = depsWith({
      chain,
      pinner,
      store,
      clock: new FixedClock(42n),
      nowUnix: () => 1_700_000_000,
    });

    const res = await issueBankFiatRampTest(deps, {
      checkingAccountId: ACCT,
      agentCardPubkey: CARD_A,
    });

    expect(res.status).toBe("issued");
    if (res.status !== "issued") throw new Error("unreachable");

    expect(chain.calls).toHaveLength(1);
    const call = chain.calls[0]!;
    expect(call.subjectAgentCardPubkey).toBe(CARD_A);
    expect(call.schemaIdHex).toBe(BANK_FIAT_RAMP_TEST_SCHEMA_ID_HEX);
    expect(call.validFromSlot).toBe(42n);
    expect(call.validUntilSlot).toBe(0n);
    expect(call.claimUri).toBe(res.claimUri);
    expect(call.claimHashHex).toBe(res.claimHashHex);

    // Pinned VC contains the checking-account-id and is the
    // pre-image of claimHashHex.
    expect(pinner.pinned).toHaveLength(1);
    const jcs = pinner.pinned[0]!;
    expect(jcs).toContain(ACCT);
    expect(sha256Hex(jcs)).toBe(res.claimHashHex);

    // Store row reflects the binding.
    const row = await store.get(ACCT);
    expect(row).toBeDefined();
    expect(row!.agentCardPubkey).toBe(CARD_A);
    expect(row!.credentialPda).toBe(call.subjectAgentCardPubkey
      ? `pda_1_${CARD_A.slice(0, 8)}`
      : "");
    expect(row!.revoked).toBe(false);
  });
});

describe("issueBankFiatRampTest — idempotency", () => {
  it("re-issuing for the same (id, card) does not call the chain again", async () => {
    const chain = new StubChain();
    const store = new InMemoryBankMockStore();
    const deps = depsWith({ chain, store });

    const first = await issueBankFiatRampTest(deps, {
      checkingAccountId: ACCT,
      agentCardPubkey: CARD_A,
    });
    expect(first.status).toBe("issued");

    const second = await issueBankFiatRampTest(deps, {
      checkingAccountId: ACCT,
      agentCardPubkey: CARD_A,
    });
    expect(second.status).toBe("idempotent");
    if (second.status !== "idempotent") throw new Error("unreachable");
    if (first.status !== "issued") throw new Error("unreachable");
    expect(second.credentialPda).toBe(first.credentialPda);
    expect(second.txSignature).toBe(first.txSignature);
    expect(second.claimUri).toBe(first.claimUri);
    expect(chain.calls).toHaveLength(1);
  });
});

describe("issueBankFiatRampTest — binding conflict", () => {
  it("rejects a second card binding to the same checking-account-id", async () => {
    const chain = new StubChain();
    const store = new InMemoryBankMockStore();
    const deps = depsWith({ chain, store });

    await issueBankFiatRampTest(deps, {
      checkingAccountId: ACCT,
      agentCardPubkey: CARD_A,
    });

    await expect(
      issueBankFiatRampTest(deps, {
        checkingAccountId: ACCT,
        agentCardPubkey: CARD_B,
      }),
    ).rejects.toMatchObject({
      name: "BankMockIssueError",
      kind: "binding_conflict",
    });

    // Chain not called a second time — the conflict is caught by the
    // store lookup before we attempt a second issuance.
    expect(chain.calls).toHaveLength(1);
  });

  it("surfaces the conflict for a race-on-putIfAbsent", async () => {
    // Pre-seed the store as if a concurrent CARD_B request landed
    // *between* our get() and our chain tx. Use a custom store that
    // returns the seeded row from putIfAbsent.
    const seeded: BankMockRow = {
      checkingAccountId: ACCT,
      agentCardPubkey: CARD_B,
      credentialPda: "pda_existing",
      txSignature: "sig_existing",
      claimUri: "ipfs://existing",
      issuedAtUnix: 1,
      revoked: false,
    };
    const store: BankMockStore = {
      async get() {
        return undefined;
      },
      async putIfAbsent() {
        return seeded;
      },
      async markRevoked() {
        throw new Error("not used");
      },
    };

    const deps = depsWith({ store });
    await expect(
      issueBankFiatRampTest(deps, {
        checkingAccountId: ACCT,
        agentCardPubkey: CARD_A,
      }),
    ).rejects.toMatchObject({
      name: "BankMockIssueError",
      kind: "binding_conflict",
    });
  });
});

describe("issueBankFiatRampTest — invalid input", () => {
  it("rejects empty checkingAccountId", async () => {
    await expect(
      issueBankFiatRampTest(depsWith(), {
        checkingAccountId: "",
        agentCardPubkey: CARD_A,
      }),
    ).rejects.toMatchObject({
      name: "BankMockIssueError",
      kind: "invalid_request",
    });
  });

  it("rejects empty agentCardPubkey", async () => {
    await expect(
      issueBankFiatRampTest(depsWith(), {
        checkingAccountId: ACCT,
        agentCardPubkey: "",
      }),
    ).rejects.toMatchObject({
      name: "BankMockIssueError",
      kind: "invalid_request",
    });
  });
});

describe("issueBankFiatRampTest — chain failure", () => {
  it("does not poison the store when the IssueCredential tx fails", async () => {
    const chain = new StubChain();
    chain.failNext = true;
    const store = new InMemoryBankMockStore();
    const deps = depsWith({ chain, store });

    await expect(
      issueBankFiatRampTest(deps, {
        checkingAccountId: ACCT,
        agentCardPubkey: CARD_A,
      }),
    ).rejects.toMatchObject({
      name: "BankMockIssueError",
      kind: "chain_failed",
    });

    // No row written → a retry can succeed cleanly.
    expect(await store.get(ACCT)).toBeUndefined();

    const retry = await issueBankFiatRampTest(deps, {
      checkingAccountId: ACCT,
      agentCardPubkey: CARD_A,
    });
    expect(retry.status).toBe("issued");
  });
});

describe("revokeBankFiatRampTest", () => {
  it("flips the on-chain credential and persists the revoked flag", async () => {
    const chain = new StubChain();
    const revoker = new StubRevoker();
    const store = new InMemoryBankMockStore();
    const deps = depsWith({
      chain,
      revoker,
      store,
      nowUnix: () => 1_700_000_500,
    });

    const issued = await issueBankFiatRampTest(deps, {
      checkingAccountId: ACCT,
      agentCardPubkey: CARD_A,
    });
    if (issued.status !== "issued") throw new Error("unreachable");

    const res = await revokeBankFiatRampTest(deps, {
      checkingAccountId: ACCT,
    });
    expect(res.status).toBe("revoked");
    expect(res.credentialPda).toBe(issued.credentialPda);
    expect(revoker.calls).toEqual([{ credentialPda: issued.credentialPda }]);

    const row = await store.get(ACCT);
    expect(row?.revoked).toBe(true);
    expect(row?.revokedAtUnix).toBe(1_700_000_500);
    expect(row?.revokeTxSignature).toBe(res.revokeTxSignature);
  });

  it("is idempotent on a second call", async () => {
    const revoker = new StubRevoker();
    const deps = depsWith({ revoker });

    await issueBankFiatRampTest(deps, {
      checkingAccountId: ACCT,
      agentCardPubkey: CARD_A,
    });
    const first = await revokeBankFiatRampTest(deps, {
      checkingAccountId: ACCT,
    });
    const second = await revokeBankFiatRampTest(deps, {
      checkingAccountId: ACCT,
    });

    expect(first.status).toBe("revoked");
    expect(second.status).toBe("already_revoked");
    expect(second.revokeTxSignature).toBe(first.revokeTxSignature);
    // Chain revoke called exactly once across the two calls.
    expect(revoker.calls).toHaveLength(1);
  });

  it("throws not_found for an unknown checking-account-id", async () => {
    const deps = depsWith();
    await expect(
      revokeBankFiatRampTest(deps, { checkingAccountId: ACCT_2 }),
    ).rejects.toMatchObject({
      name: "BankMockIssueError",
      kind: "not_found",
    });
  });

  it("rejects empty checkingAccountId", async () => {
    await expect(
      revokeBankFiatRampTest(depsWith(), { checkingAccountId: "" }),
    ).rejects.toMatchObject({
      name: "BankMockIssueError",
      kind: "invalid_request",
    });
  });

  it("does not flip the store flag when the revoke tx fails", async () => {
    const revoker = new StubRevoker();
    const store = new InMemoryBankMockStore();
    const deps = depsWith({ revoker, store });

    await issueBankFiatRampTest(deps, {
      checkingAccountId: ACCT,
      agentCardPubkey: CARD_A,
    });

    revoker.failNext = true;
    await expect(
      revokeBankFiatRampTest(deps, { checkingAccountId: ACCT }),
    ).rejects.toMatchObject({
      name: "BankMockIssueError",
      kind: "chain_failed",
    });

    const row = await store.get(ACCT);
    expect(row?.revoked).toBe(false);

    // Retrying the revoke should succeed cleanly.
    const retry = await revokeBankFiatRampTest(deps, {
      checkingAccountId: ACCT,
    });
    expect(retry.status).toBe("revoked");
  });
});

describe("buildBankFiatRampTestVc / jcsCanonicalize", () => {
  it("ties the VC to the checking-account-id", () => {
    const vc = buildBankFiatRampTestVc({
      agentCardPubkey: CARD_A,
      issuerAuthorityPubkey: ISSUER_AUTHORITY,
      checkingAccountId: ACCT,
      issuanceDate: "2026-04-29T00:00:00.000Z",
    });
    const subject = (vc as { credentialSubject: Record<string, unknown> })
      .credentialSubject;
    expect(subject.checkingAccountId).toBe(ACCT);
    expect(subject.id).toBe(`did:eto:agentcard:${CARD_A}`);
    expect(subject.mockIssuer).toBe(true);
  });

  it("emits keys in lexicographic UTF-16 order", () => {
    const out = jcsCanonicalize({ b: 1, a: 2, c: { z: 1, a: 2 } });
    expect(out).toBe('{"a":2,"b":1,"c":{"a":2,"z":1}}');
  });
});

describe("InMemoryBankMockStore", () => {
  it("putIfAbsent returns the seeded row on collision", async () => {
    const store = new InMemoryBankMockStore();
    const row: BankMockRow = {
      checkingAccountId: ACCT,
      agentCardPubkey: CARD_A,
      credentialPda: "pda1",
      txSignature: "sig1",
      claimUri: "ipfs://1",
      issuedAtUnix: 1,
      revoked: false,
    };
    expect(await store.putIfAbsent(row)).toEqual(row);

    const collide: BankMockRow = { ...row, agentCardPubkey: CARD_B };
    const winner = await store.putIfAbsent(collide);
    expect(winner.agentCardPubkey).toBe(CARD_A);
  });

  it("markRevoked is idempotent and throws for unknown ids", async () => {
    const store = new InMemoryBankMockStore();
    await store.putIfAbsent({
      checkingAccountId: ACCT,
      agentCardPubkey: CARD_A,
      credentialPda: "pda1",
      txSignature: "sig1",
      claimUri: "ipfs://1",
      issuedAtUnix: 1,
      revoked: false,
    });

    const first = await store.markRevoked({
      checkingAccountId: ACCT,
      revokedAtUnix: 10,
      revokeTxSignature: "sig_revoke",
    });
    expect(first.revoked).toBe(true);

    const second = await store.markRevoked({
      checkingAccountId: ACCT,
      revokedAtUnix: 20,
      revokeTxSignature: "sig_revoke_2",
    });
    // Idempotent: keeps the original revocation timestamp/signature.
    expect(second.revokedAtUnix).toBe(10);
    expect(second.revokeTxSignature).toBe("sig_revoke");

    await expect(
      store.markRevoked({
        checkingAccountId: "unknown",
        revokedAtUnix: 30,
        revokeTxSignature: "sig",
      }),
    ).rejects.toThrow(/unknown/);
  });
});
