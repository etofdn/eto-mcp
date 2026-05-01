/**
 * Card auth flow test stubs — FN-128 (T-3.12.1.5)
 * Mission: E12: Cards
 *
 * Acceptance criteria: Auth → balance debit on chain.
 *
 * Dependencies that must land before these stubs can be filled in:
 *   - T-3.12.1.3 (card issue flow, FN-003): produces an `account.card`
 *     credential bound to the holder's checking account. Until that
 *     work lands, there is no card-issue handler to call and no
 *     credential schema to reference here.
 *   - keeper/bpps/bank/catalog.json must gain a `card-auth` service
 *     entry (and the corresponding BPP handler) so a card-auth tx can
 *     be submitted and the resulting on-chain checking_account.balance
 *     can be read back.
 *
 * Once T-3.12.1.3 is merged, replace each `test.todo` with a real test
 * following this pattern:
 *   1. Set up: open checking account with initial balance, issue card
 *      credential via the card-issue BPP handler.
 *   2. Submit a card-auth tx via the bank BPP (amount, auth_id, holder).
 *   3. Read the on-chain checking_account.balance.
 *   4. Assert: balance === initial - amount.
 *   5. Assert: a card_auth_event was emitted with (auth_id, amount, holder).
 */

import { describe, test } from "vitest";

describe("card auth flow (FN-128)", () => {
  test.todo("issue card → produces account.card credential bound to holder");

  test.todo(
    "auth $X with sufficient balance → debits checking account on chain",
  );

  test.todo(
    "auth $X with insufficient balance → declines, leaves balance unchanged",
  );

  test.todo("multiple sequential auths debit additively");

  test.todo("replay-protected: same auth_id rejected on second submission");
});
