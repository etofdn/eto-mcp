# FN-024 — Audit `create_wallet` tool description for Ed25519-truncation references

**Parent issue:** https://github.com/etofdn/eto-mcp/issues/15

## Method

Read the live `create_wallet` registration at `src/tools/wallet.ts:61`. Extracted every sentence that touches EVM derivation. Compared against the spec text in #15 ("Ed25519-truncation must not be used; HKDF-SHA256 → secp256k1 is the canonical path").

## Source under audit

`src/tools/wallet.ts:62` — current description (verbatim):

> Creates a new wallet keypair on the ETO network. Generates a fresh Ed25519 keypair for SVM signing and derives an HKDF-SHA256 secp256k1 sub-key for EVM signing. Returns the SVM address (base58 Ed25519 public key) and the EVM address (0x-prefixed, keccak256 of the secp256k1 public key — the address ecrecover will resolve signed EVM txs to). The wallet is stored in memory for this session and can be used immediately for signing transactions. Optionally accepts a network parameter to tag the wallet with the intended network context.

## Findings

| Sentence (subject) | Mentions Ed25519 truncation? | Notes |
| --- | --- | --- |
| "Generates a fresh Ed25519 keypair for SVM signing" | No | Correct — Ed25519 is the SVM signer, not the EVM derivation source. |
| "and derives an HKDF-SHA256 secp256k1 sub-key for EVM signing" | No | Correct — HKDF-SHA256 → secp256k1 path, matches the spec. |
| "Returns the SVM address (base58 Ed25519 public key)" | No | Public-key encoding only, no derivation claim. |
| "EVM address (0x-prefixed, keccak256 of the secp256k1 public key — the address ecrecover will resolve signed EVM txs to)" | No | Correct EVM address derivation. |
| Remaining sentences | No | Operational copy (storage, network tag); no derivation claims. |

## Conclusion

**Zero stale Ed25519-truncation references.** The description was already migrated to the HKDF-SHA256 → secp256k1 wording. No code changes needed for FN-024.

Sibling audits in #15 (#15-2 through #15-10) should still be performed to confirm the rest of the wallet/signer surface hasn't drifted, but `create_wallet` itself is clean.

## Acceptance criteria

- [x] All sentences identified and noted (table above).
- [x] No code changes — audit only.
