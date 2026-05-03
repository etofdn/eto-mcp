---
"@eto/mcp": minor
---

Added optional `memo` parameter to `buildTransferTx` (SPL Memo Program v2 instruction prepended). Backward compatible — calls without `memo` (or with an empty-string `memo`) produce byte-identical transactions to the prior 4-argument signature, so existing callers and on-chain signatures are unaffected. With a memo, two transfers that differ only in their memo string produce distinct transaction bytes (and therefore distinct signatures), which the `transfer` tools (single + batch) rely on for idempotency-safe parallel submissions.
