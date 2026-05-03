/**
 * Card auth flow tests — FN-128 / FN-078.
 * Mission: E12: Cards
 *
 * Acceptance criteria: Auth → balance debit on chain.
 *
 * Test coverage (5 cases):
 *   1. Issue card → produces an `account.card` credential bound to holder.
 *   2. Auth with sufficient balance → debits checking account on chain.
 *   3. Auth with insufficient balance → declines, leaves balance unchanged.
 *   4. Multiple sequential auths debit additively.
 *   5. Replay-protected: same auth_id rejected on second submission.
 *
 * Each test sets up a fresh MockChainState, opens a checking account with a
 * known balance, issues a card credential via `issueCard`, and submits one or
 * more `submitCardAuth` calls (which simulates the on-chain `card_auth`
 * instruction — FN-126 — that will eventually move from this mock into a
 * real keeper handler).
 */

import { describe, expect, test } from "vitest";

import {
  issueCard,
  IssueCardRejected,
} from "../../keeper/bpps/bank/handlers/issue-card.js";
import {
  openChecking,
  REQUIRED_SCHEMAS,
} from "../../keeper/bpps/bank/handlers/open-checking.js";

import {
  BANK_ISSUER_PUBKEY,
  CardAuthError,
  HOLDER_PUBKEY,
  ONE_EUSD,
  makeInitialState,
  makeIssueCardDeps,
  makeOpenCheckingDeps,
  submitCardAuth,
  type MockChainState,
} from "./fixtures.js";

/* -------------------------------------------------------------------------- */
/* Helpers                                                                    */
/* -------------------------------------------------------------------------- */

const HOLDER_CRED_SCHEMAS = new Set<string>(REQUIRED_SCHEMAS);

/**
 * Set up a checking account with `openingBalance` (atomic eUSD) and issue a
 * card credential bound to the holder. Returns the populated state and the
 * `issueCard` result.
 */
async function setupIssuedCard(openingBalance: bigint): Promise<{
  state: MockChainState;
  cardPda: string;
  credentialPda: string;
}> {
  const state = makeInitialState();

  await openChecking(
    {
      subject: HOLDER_PUBKEY,
      bank_issuer: BANK_ISSUER_PUBKEY,
      opened_slot: 1000,
      opening_deposit_atomic: Number(openingBalance),
    },
    makeOpenCheckingDeps(state, HOLDER_CRED_SCHEMAS),
  );

  const result = await issueCard(
    {
      subject: HOLDER_PUBKEY,
      bank_issuer: BANK_ISSUER_PUBKEY,
      linked_account_pda: state.checkingPda!,
      issued_slot: 1100,
    },
    makeIssueCardDeps(state),
  );

  return {
    state,
    cardPda: result.card_pda,
    credentialPda: state.cardCredentialPda!,
  };
}

/* -------------------------------------------------------------------------- */
/* Tests                                                                      */
/* -------------------------------------------------------------------------- */

describe("card auth flow (FN-128)", () => {
  test("issue card → produces account.card credential bound to holder", async () => {
    const state = makeInitialState();

    await openChecking(
      {
        subject: HOLDER_PUBKEY,
        bank_issuer: BANK_ISSUER_PUBKEY,
        opened_slot: 1000,
        opening_deposit_atomic: 0,
      },
      makeOpenCheckingDeps(state, HOLDER_CRED_SCHEMAS),
    );

    const result = await issueCard(
      {
        subject: HOLDER_PUBKEY,
        bank_issuer: BANK_ISSUER_PUBKEY,
        linked_account_pda: state.checkingPda!,
        issued_slot: 1100,
      },
      makeIssueCardDeps(state),
    );

    // (a) returned card_pda is a non-null hex64 string and recorded on chain.
    expect(result.card_pda).toMatch(/^[0-9a-f]{64}$/);
    expect(state.cardPda).toBe(result.card_pda);

    // (b) credential PDA is non-null (recorded by the on-chain stub).
    expect(state.cardCredentialPda).not.toBeNull();
    expect(state.cardCredentialPda).toMatch(/^[0-9a-f]{64}$/);

    // (c) credential is bound to the holder via subject + body.holder, and
    // linked to the holder's checking account PDA.
    expect(result.credential.schema).toBe("card.debit.us.v1");
    expect(result.credential.subject).toBe(HOLDER_PUBKEY);
    expect(result.credential.body.holder).toBe(HOLDER_PUBKEY);
    expect(result.credential.body.linked_account_pda).toBe(state.checkingPda);

    // (d) credential issuer is the bank.
    expect(result.credential.issuer).toBe(BANK_ISSUER_PUBKEY);

    // (e) issuing without a checking account → account_not_found.
    const stateNoAccount = makeInitialState();
    await expect(
      issueCard(
        {
          subject: HOLDER_PUBKEY,
          bank_issuer: BANK_ISSUER_PUBKEY,
          linked_account_pda: "f".repeat(64),
          issued_slot: 1100,
        },
        makeIssueCardDeps(stateNoAccount),
      ),
    ).rejects.toBeInstanceOf(IssueCardRejected);
  });

  test("auth $X with sufficient balance → debits checking account on chain", async () => {
    const initialBalance = 100n * ONE_EUSD;
    const authAmount = 25n * ONE_EUSD;

    const { state } = await setupIssuedCard(initialBalance);
    expect(state.checkingBalance).toBe(initialBalance);

    const result = submitCardAuth(state, {
      auth_id: "auth-001",
      amount: authAmount,
      holder: HOLDER_PUBKEY,
    });

    // On-chain checking_account.balance is debited.
    expect(state.checkingBalance).toBe(initialBalance - authAmount);
    expect(result.new_balance).toBe(initialBalance - authAmount);

    // card_auth_event emitted with (auth_id, amount, holder).
    expect(state.cardAuthEvents).toEqual([
      { auth_id: "auth-001", amount: authAmount, holder: HOLDER_PUBKEY },
    ]);
    expect(state.usedCardAuthIds.has("auth-001")).toBe(true);
  });

  test("auth $X with insufficient balance → declines, leaves balance unchanged", async () => {
    const initialBalance = 10n * ONE_EUSD;
    const authAmount = 50n * ONE_EUSD; // > balance

    const { state } = await setupIssuedCard(initialBalance);

    expect(() =>
      submitCardAuth(state, {
        auth_id: "auth-bad",
        amount: authAmount,
        holder: HOLDER_PUBKEY,
      }),
    ).toThrow(CardAuthError);

    // Balance unchanged on-chain.
    expect(state.checkingBalance).toBe(initialBalance);
    // No event emitted.
    expect(state.cardAuthEvents).toEqual([]);
    // auth_id was NOT consumed (so it can be retried after a deposit).
    expect(state.usedCardAuthIds.has("auth-bad")).toBe(false);
  });

  test("multiple sequential auths debit additively", async () => {
    const initialBalance = 100n * ONE_EUSD;
    const amounts = [10n * ONE_EUSD, 25n * ONE_EUSD, 7n * ONE_EUSD];
    const total = amounts.reduce((a, b) => a + b, 0n);
    expect(total).toBeLessThan(initialBalance); // sanity

    const { state } = await setupIssuedCard(initialBalance);

    amounts.forEach((amount, i) => {
      submitCardAuth(state, {
        auth_id: `auth-seq-${i}`,
        amount,
        holder: HOLDER_PUBKEY,
      });
    });

    // Final on-chain balance = initial - sum.
    expect(state.checkingBalance).toBe(initialBalance - total);

    // 3 events, in order, with matching amounts.
    expect(state.cardAuthEvents).toHaveLength(3);
    expect(state.cardAuthEvents.map((e) => e.amount)).toEqual(amounts);
    expect(state.usedCardAuthIds.size).toBe(3);
  });

  test("replay-protected: same auth_id rejected on second submission", async () => {
    const initialBalance = 100n * ONE_EUSD;
    const authAmount = 5n * ONE_EUSD;

    const { state } = await setupIssuedCard(initialBalance);

    // First submission succeeds.
    submitCardAuth(state, {
      auth_id: "auth-replay",
      amount: authAmount,
      holder: HOLDER_PUBKEY,
    });
    expect(state.checkingBalance).toBe(initialBalance - authAmount);
    expect(state.cardAuthEvents).toHaveLength(1);

    // Second submission with the same auth_id is rejected.
    let err: unknown;
    try {
      submitCardAuth(state, {
        auth_id: "auth-replay",
        amount: authAmount,
        holder: HOLDER_PUBKEY,
      });
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(CardAuthError);
    expect((err as CardAuthError).reason).toBe("replay");

    // Balance was NOT debited a second time.
    expect(state.checkingBalance).toBe(initialBalance - authAmount);
    // Only the original event remains.
    expect(state.cardAuthEvents).toHaveLength(1);
  });
});
