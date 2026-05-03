---
"@eto/mcp": patch
---

`transfer_native` and `batch_transfer` now pass the user-supplied `memo` through to `buildTransferTx`, so the memo is anchored on-chain via the SPL Memo Program v2 and is recoverable from chain history (e.g. via `query_memos` / `get_account_transactions`). Previously the memo was only echoed in the response text and never written into the signed transaction bytes, which meant two transfers that differed only in `memo` produced identical signatures. Depends on FN-064 (which added the optional 5th `memo` parameter to `buildTransferTx`). Regression coverage: `tests/unit/transfer-memo-wiring.test.ts`.
