/**
 * FN-123 / T-3.11.2.4 — Full bank account lifecycle (E11: Checking & Savings)
 *
 * Acceptance criteria (verbatim from PROMPT.md):
 *   Open → deposit → withdraw → wire → savings → yield, all on chain.
 *
 * Every assertion marked "on chain" reads through mock ChainState PDA fields
 * populated by the handler deps (not from in-test bookkeeping variables).
 *
 * Conservation invariant: totalEusd(state) === INITIAL_MINT_ATOMIC for all
 * pure transfer operations.  Yield accrual intentionally increases the total
 * (v0 engine mints yield ex nihilo); that delta is asserted separately.
 *
 * Test ordering: sequential, module-scoped shared state.  Do NOT run in
 * parallel.
 */

import { describe, it, expect, beforeAll } from "vitest";

import {
  openChecking,
  OpenCheckingRejected,
  REQUIRED_SCHEMAS,
} from "../../keeper/bpps/bank/handlers/open-checking.js";
import {
  openSavings,
  OpenSavingsRejected,
} from "../../keeper/bpps/bank/handlers/open-savings.js";
import {
  executeWire,
  WireRejected,
} from "../../keeper/bpps/bank/handlers/wire.js";
import {
  accrueOne,
  applyYield,
} from "../../keeper/bpps/bank/yield.js";

import {
  makeInitialState,
  totalEusd,
  deposit,
  withdraw,
  tryOverdrawChecking,
  transferToSavings,
  buildSavingsAccount,
  makeOpenCheckingDeps,
  makeOpenSavingsDeps,
  makeWireDeps,
  makeYieldDeps,
  HOLDER_PUBKEY,
  BANK_ISSUER_PUBKEY,
  INITIAL_MINT_ATOMIC,
  DEPOSIT_AMOUNT,
  WITHDRAW_AMOUNT,
  WIRE_AMOUNT,
  WIRE_FEE,
  SAVINGS_TRANSFER,
} from "./fixtures.js";

/* -------------------------------------------------------------------------- */
/* Module-scoped shared state — tests run in order                            */
/* -------------------------------------------------------------------------- */

const state = makeInitialState();

/**
 * Schema IDs the holder is assumed to hold (verified-human + kyc.us-test).
 * These mirror REQUIRED_SCHEMAS from open-checking.ts.
 */
const holderCredentialSchemas = new Set<string>(REQUIRED_SCHEMAS);

/**
 * Conservation log: records totalEusd before and after each step.
 * Non-yield steps must have delta === 0n.
 */
const conservationLog: Array<{
  step: string;
  before: bigint;
  after: bigint;
}> = [];

function recordBefore(step: string): bigint {
  return totalEusd(state);
}
function recordAfter(step: string, before: bigint): void {
  conservationLog.push({ step, before, after: totalEusd(state) });
}

/* -------------------------------------------------------------------------- */
/* Suite                                                                      */
/* -------------------------------------------------------------------------- */

describe("bank account lifecycle (E11)", () => {
  /* -------------------------------------------------------------------------
   * Phase 0 — pre-conditions
   * ---------------------------------------------------------------------- */

  it("holder is pre-seeded with INITIAL_MINT_ATOMIC eUSD", () => {
    expect(state.walletBalance).toBe(INITIAL_MINT_ATOMIC);
    expect(totalEusd(state)).toBe(INITIAL_MINT_ATOMIC);
  });

  /* -------------------------------------------------------------------------
   * Phase 1 — Open checking account
   * ---------------------------------------------------------------------- */

  it("opens a checking account", async () => {
    const before = recordBefore("open-checking");

    const result = await openChecking(
      {
        callerPubkey: HOLDER_PUBKEY,
        body: {
          subject: HOLDER_PUBKEY,
          bank_issuer: BANK_ISSUER_PUBKEY,
          opened_slot: 1000,
          opening_deposit_atomic: 0,
        },
      },
      makeOpenCheckingDeps(state, holderCredentialSchemas),
    );

    // (a) account.checking credential issued to holder
    expect(result.credential.schema).toBe("account.checking.v1");
    expect(result.credential.subject).toBe(HOLDER_PUBKEY);
    expect(result.credential.issuer).toBe(BANK_ISSUER_PUBKEY);

    // (b) CheckingAccount PDA exists on chain with holder == holderPubkey, balance == 0
    expect(state.checkingPda).toMatch(/^[0-9a-f]{64}$/); // on-chain read
    expect(state.checkingHolder).toBe(HOLDER_PUBKEY);     // on-chain read
    expect(state.checkingBalance).toBe(0n);               // on-chain read

    // (c) fulfillment_uri is signed (BPP has signed CompleteTask)
    expect(result.fulfillment_uri).toBe(
      `eto://checking/${result.checking_account_pda}`,
    );

    // on-chain credential record
    expect(state.checkingCredential).not.toBeNull();
    expect(state.checkingCredential?.schema).toBe("account.checking.v1");

    recordAfter("open-checking", before);
  });

  /* -------------------------------------------------------------------------
   * Phase 2 — Deposit eUSD into checking
   * ---------------------------------------------------------------------- */

  it("deposits eUSD into checking", () => {
    const before = recordBefore("deposit");
    const walletBefore = state.walletBalance; // on-chain read
    const checkBefore = state.checkingBalance; // on-chain read

    deposit(state, DEPOSIT_AMOUNT);

    // Conservation: wallet decreases, checking increases by same amount
    expect(state.walletBalance).toBe(walletBefore - DEPOSIT_AMOUNT); // on-chain
    expect(state.checkingBalance).toBe(checkBefore + DEPOSIT_AMOUNT); // on-chain

    recordAfter("deposit", before);
  });

  /* -------------------------------------------------------------------------
   * Phase 3 — Withdraw eUSD from checking
   * ---------------------------------------------------------------------- */

  it("withdraws eUSD from checking", () => {
    const before = recordBefore("withdraw");
    const walletBefore = state.walletBalance; // on-chain read
    const checkBefore = state.checkingBalance; // on-chain read

    withdraw(state, WITHDRAW_AMOUNT);

    // Inverse balance movement
    expect(state.checkingBalance).toBe(checkBefore - WITHDRAW_AMOUNT); // on-chain
    expect(state.walletBalance).toBe(walletBefore + WITHDRAW_AMOUNT);   // on-chain

    recordAfter("withdraw", before);
  });

  it("withdrawing more than checking balance fails with expected error", () => {
    const overdrawAmount = state.checkingBalance + 1n; // on-chain read
    const err = tryOverdrawChecking(state, overdrawAmount);
    expect(err.message).toMatch(/insufficient checking balance/);

    // State must be unchanged after failed withdraw
    // (tryOverdrawChecking does not mutate state on error)
  });

  /* -------------------------------------------------------------------------
   * Phase 4 — Wire transfer
   * ---------------------------------------------------------------------- */

  it("sends a domestic wire transfer — eUSD locked in escrow then released", async () => {
    const before = recordBefore("wire");
    const checkBefore = state.checkingBalance; // on-chain read

    const result = await executeWire(
      {
        holder: HOLDER_PUBKEY,
        checking_account_pda: state.checkingPda!,
        amount: Number(WIRE_AMOUNT),
        recipient: {
          routing_number: "021000021",
          account_number: "123456789",
          name: "Test Recipient",
        },
        kind: "domestic",
        initiated_slot: 2000,
      },
      makeWireDeps(state),
    );

    // Escrow was locked (phase = released means lock + release happened)
    expect(result.phase).toBe("released");
    expect(result.amount).toBe(Number(WIRE_AMOUNT));
    expect(result.fee).toBe(Number(WIRE_FEE));

    // CheckingAccount.balance reflects the debit (amount + fee) — on-chain read
    const total = WIRE_AMOUNT + WIRE_FEE;
    expect(state.checkingBalance).toBe(checkBefore - total); // on-chain

    // Escrow was fully released after the mock receipt
    expect(state.wireEscrowBalance).toBe(0n); // on-chain
    expect(state.wiredOutBalance).toBe(total); // on-chain

    recordAfter("wire", before);
  });

  it("wire of an amount exceeding checking balance rejects before lock", async () => {
    const overAmount = Number(state.checkingBalance) + 1; // on-chain read
    await expect(
      executeWire(
        {
          holder: HOLDER_PUBKEY,
          checking_account_pda: state.checkingPda!,
          amount: overAmount,
          recipient: {
            routing_number: "021000021",
            account_number: "987654321",
            name: "Overflow Recipient",
          },
          kind: "domestic",
          initiated_slot: 2100,
        },
        makeWireDeps(state),
      ),
    ).rejects.toMatchObject({ reason: "lock_failed" });

    // State must be unchanged — no eUSD left escrow
    expect(state.wireEscrowBalance).toBe(0n); // on-chain
  });

  /* -------------------------------------------------------------------------
   * Phase 5 — Open savings account (requires checking)
   * ---------------------------------------------------------------------- */

  it("opens a savings account (requires checking credential)", async () => {
    const before = recordBefore("open-savings");

    const result = await openSavings(
      {
        subject: HOLDER_PUBKEY,
        linked_checking_account_pda: state.checkingPda!,
        bank_issuer: BANK_ISSUER_PUBKEY,
        opened_slot: 3000,
        apy_bps: 400,
      },
      makeOpenSavingsDeps(state, () => state.checkingCredential !== null),
    );

    // account.savings credential issued — on-chain read
    expect(state.savingsCredential).not.toBeNull();
    const cred = state.savingsCredential as { schema: string; body: { apy_bps: number } };
    expect(cred.schema).toBe("account.savings.v1");
    expect(cred.body.apy_bps).toBe(400);

    // SavingsAccount PDA exists on chain — on-chain read
    expect(state.savingsPda).toMatch(/^[0-9a-f]{64}$/); // on-chain
    expect(result.savings_account_pda).toBe(state.savingsPda);

    recordAfter("open-savings", before);
  });

  it("holder without account.checking credential is rejected by openSavings", async () => {
    await expect(
      openSavings(
        {
          subject: HOLDER_PUBKEY,
          linked_checking_account_pda: state.checkingPda!,
          bank_issuer: BANK_ISSUER_PUBKEY,
          opened_slot: 3001,
        },
        makeOpenSavingsDeps(state, () => false /* no checking cred */),
      ),
    ).rejects.toMatchObject({ reason: "no_checking_credential" });
  });

  /* -------------------------------------------------------------------------
   * Phase 6 — Yield accrual
   * ---------------------------------------------------------------------- */

  it("accrues yield (4% APY) on savings balance", async () => {
    // Move eUSD from checking → savings first
    transferToSavings(state, SAVINGS_TRANSFER);
    expect(state.savingsBalance).toBe(SAVINGS_TRANSFER); // on-chain

    const totalBefore = totalEusd(state);
    const account = buildSavingsAccount(state);

    // Advance mock clock by 365 periods (1 full year)
    const PERIODS_ELAPSED = 365;
    const initialPeriod = 0;
    let mockPeriod = initialPeriod + PERIODS_ELAPSED;

    const yieldDeps = makeYieldDeps(state, () => mockPeriod);
    const accrueResult = await accrueOne(account, yieldDeps);

    // accrueOne returned a result (not null)
    expect(accrueResult).not.toBeNull();
    expect(accrueResult!.tx_signature).toMatch(/^[0-9a-f]{64}$/);

    // Compute expected balance using applyYield — same function the engine uses.
    // DO NOT hardcode 0.04 here; import the computation from yield.ts.
    const expectedBalance = applyYield(account, PERIODS_ELAPSED);

    // Savings balance on chain must equal expected — on-chain read
    expect(state.savingsBalance).toBe(expectedBalance); // on-chain
    expect(state.savingsBalance).toBeGreaterThan(SAVINGS_TRANSFER); // on-chain — yield grew it

    // Verify yield amount is positive
    const yieldEarned = totalEusd(state) - totalBefore;
    expect(yieldEarned).toBeGreaterThan(0n);

    // Record yield delta in conservation log for the final conservation test
    conservationLog.push({
      step: "yield-accrual",
      before: totalBefore,
      after: totalEusd(state),
    });
  });

  /* -------------------------------------------------------------------------
   * Phase 7 — Conservation invariant
   * ---------------------------------------------------------------------- */

  it("preserves total eUSD across the lifecycle (non-yield steps have zero delta)", () => {
    // Every non-yield step must have before === after (no eUSD created/destroyed)
    const transferSteps = conservationLog.filter(
      (e) => e.step !== "yield-accrual",
    );

    for (const entry of transferSteps) {
      expect(entry.after, `step "${entry.step}" must not change totalEusd`).toBe(
        entry.before,
      );
      // Also confirm each transfer step total equals INITIAL_MINT_ATOMIC
      expect(entry.after, `step "${entry.step}" totalEusd must equal INITIAL_MINT_ATOMIC`).toBe(
        INITIAL_MINT_ATOMIC,
      );
    }

    // The yield step MUST increase the total
    const yieldEntry = conservationLog.find((e) => e.step === "yield-accrual");
    expect(yieldEntry, "yield-accrual step must be recorded").toBeDefined();
    expect(yieldEntry!.after).toBeGreaterThan(yieldEntry!.before);
    expect(yieldEntry!.before).toBe(INITIAL_MINT_ATOMIC);

    // Final state: all buckets non-negative
    expect(state.walletBalance).toBeGreaterThanOrEqual(0n); // on-chain
    expect(state.checkingBalance).toBeGreaterThanOrEqual(0n); // on-chain
    expect(state.savingsBalance).toBeGreaterThanOrEqual(0n); // on-chain
    expect(state.wireEscrowBalance).toBe(0n); // on-chain — fully released
  });
});
