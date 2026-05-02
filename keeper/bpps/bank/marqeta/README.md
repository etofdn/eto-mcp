# Marqeta Integration (v0.5 placeholder — FN-127)

> Status: **placeholder**. v0 uses mock card issuance ([`handlers/issue-card.ts`](../handlers/issue-card.ts)) and mock auth ([`runtime/src/programs/eusd/instructions/card_auth.rs`](../../../../../src/runtime/src/programs/eusd/instructions/card_auth.rs)). v0.5 swaps those for real Marqeta API calls.

## Why deferred to v0.5

- Marqeta sandbox onboarding requires a corporate entity + funding agreement. v0 demonstrates the on-chain flow with mocks; v0.5 is when ETO has the legal entity ready to sign a Program Manager Agreement.
- The on-chain side (card credential schema FN-124, card_auth instruction FN-126) is identical between v0 and v0.5. Only the BPP handlers swap (mock → Marqeta SDK).

## v0 → v0.5 swap surface

When v0.5 lands, replace these files:
- `keeper/bpps/bank/handlers/issue-card.ts` → call Marqeta `POST /cards`, return real card token in the credential's `card_id_hash`.
- `keeper/bpps/bank/handlers/card-auth.ts` (if exists) → register Marqeta webhook receiver; on auth event, submit `card_auth` instruction.

## Checklist before v0.5 implementation begins

- [ ] Marqeta sandbox account provisioned
- [ ] PCI scope review for `card_id_hash` salt strategy (currently per-issuer; review whether per-card)
- [ ] Marqeta webhook auth (HMAC) keys provisioned
- [ ] On-chain `card_auth` instruction (FN-126) is live
- [ ] PAN tokenization vault selected (Marqeta-managed vs ETO-managed)

## References

- FN-124 — `card.debit.<jurisdiction>` credential schema
- FN-125 — Issue Card BPP flow (v0 stub)
- FN-126 — Card swipe auth instruction (v0 placeholder)
- FN-128 — Test card auth flow (stubs in `tests/bank/card.test.ts`)
- Marqeta API docs: https://www.marqeta.com/docs/developer-guides
