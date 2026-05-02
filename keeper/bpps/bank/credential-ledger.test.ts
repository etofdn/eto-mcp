/**
 * FN-105 — credential-ledger unit + cross-handler integration tests.
 *
 * Confirms that issue-card and open-checking record into the same store
 * (the requirement from FN-090's follow-up: "the same ledger store used
 * by open-checking").
 */
import { describe, it, expect, beforeEach } from "vitest";
import {
  createInMemoryBankLedger,
  defaultBankLedger,
} from "./credential-ledger.js";
import { stubs as issueCardStubs } from "./handlers/issue-card.js";
import { stubs as openCheckingStubs } from "./handlers/open-checking.js";

const HEX64 = "a".repeat(64);
const HEX64_B = "b".repeat(64);

describe("createInMemoryBankLedger", () => {
  it("records a card and a checking entry under distinct PDAs", async () => {
    const ledger = createInMemoryBankLedger(() => 1_000);
    await ledger.recordCard("card-pda-1", {
      holder: HEX64,
      linked_account_pda: "linked-pda-1",
      jurisdiction: "US-TEST",
      card_id_hash: "h".repeat(64),
      issued_slot: 100,
      expires_slot: 200,
    } as never);
    await ledger.recordCheckingAccount("acct-pda-1", {
      holder: HEX64_B,
      opened_slot: 50,
      opening_balance: 0,
    });
    expect(ledger.size()).toBe(2);
    const card = ledger.lookup("card-pda-1");
    const acct = ledger.lookup("acct-pda-1");
    expect(card?.kind).toBe("card.debit.v1");
    expect(card?.holder).toBe(HEX64);
    expect(card?.recorded_at_ms).toBe(1_000);
    expect(acct?.kind).toBe("account.checking.v1");
    expect(acct?.holder).toBe(HEX64_B);
  });

  it("clear() empties the store", async () => {
    const ledger = createInMemoryBankLedger();
    await ledger.recordCheckingAccount("p", { holder: HEX64, opened_slot: 1, opening_balance: 0 });
    expect(ledger.size()).toBe(1);
    ledger.clear();
    expect(ledger.size()).toBe(0);
    expect(ledger.lookup("p")).toBeUndefined();
  });

  it("re-recording the same PDA overwrites (idempotent at the same key)", async () => {
    const ledger = createInMemoryBankLedger(() => 5);
    await ledger.recordCheckingAccount("p", { holder: HEX64, opened_slot: 1, opening_balance: 100 });
    await ledger.recordCheckingAccount("p", { holder: HEX64, opened_slot: 1, opening_balance: 200 });
    expect(ledger.size()).toBe(1);
    const e = ledger.lookup("p");
    expect(e?.kind === "account.checking.v1" ? e.body.opening_balance : -1).toBe(200);
  });

  it("list() returns all entries", async () => {
    const ledger = createInMemoryBankLedger();
    await ledger.recordCheckingAccount("a", { holder: HEX64, opened_slot: 1, opening_balance: 0 });
    await ledger.recordCheckingAccount("b", { holder: HEX64, opened_slot: 1, opening_balance: 0 });
    expect(ledger.list().map((e) => e.pda).sort()).toEqual(["a", "b"]);
  });
});

describe("FN-105 — issue-card + open-checking share defaultBankLedger", () => {
  beforeEach(() => defaultBankLedger.clear());

  it("issueCard.stubs.recordCard writes to defaultBankLedger", async () => {
    await issueCardStubs.recordCard("card-pda-X", {
      holder: HEX64,
      linked_account_pda: "linked-pda-X",
      jurisdiction: "US-TEST",
      card_id_hash: "h".repeat(64),
      issued_slot: 100,
      expires_slot: 200,
    } as never);
    expect(defaultBankLedger.size()).toBe(1);
    expect(defaultBankLedger.lookup("card-pda-X")?.kind).toBe("card.debit.v1");
  });

  it("openChecking.stubs.recordCheckingAccount writes to defaultBankLedger", async () => {
    await openCheckingStubs.recordCheckingAccount("acct-pda-Y", {
      holder: HEX64,
      opened_slot: 1,
      opening_balance: 1_000,
    });
    expect(defaultBankLedger.size()).toBe(1);
    expect(defaultBankLedger.lookup("acct-pda-Y")?.kind).toBe("account.checking.v1");
  });

  it("both stubs share the same store — entries from both handlers coexist", async () => {
    await openCheckingStubs.recordCheckingAccount("acct-1", {
      holder: HEX64,
      opened_slot: 1,
      opening_balance: 0,
    });
    await issueCardStubs.recordCard("card-1", {
      holder: HEX64,
      linked_account_pda: "acct-1",
      jurisdiction: "US-TEST",
      card_id_hash: "h".repeat(64),
      issued_slot: 100,
      expires_slot: 200,
    } as never);
    expect(defaultBankLedger.size()).toBe(2);
    const kinds = defaultBankLedger.list().map((e) => e.kind).sort();
    expect(kinds).toEqual(["account.checking.v1", "card.debit.v1"]);
  });
});
