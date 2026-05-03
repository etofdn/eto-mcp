---
"@eto/mcp": patch
---

`batch_execute` now supports `transfer_native` operations alongside `airdrop` and read tools, allowing mixed batches that include native SOL transfers. The dispatch entry mirrors the standalone `transfer_native` pipeline (resolve sender wallet → sign → submit) and propagates `memo` (FN-064 / FN-065) plus `idempotency_key` through to the submitter using the same idempotency key shape as the standalone tool, so distinct memos never coalesce when transfers are issued via a batch.
