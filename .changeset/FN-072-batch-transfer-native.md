---
"@eto/mcp": patch
---

`batch_execute` now supports `transfer_native` operations alongside `airdrop` and read tools, allowing mixed batches that include native SOL transfers. The new dispatcher entry mirrors the standalone `transfer_native` pipeline (`buildTransferTx` → sign → `submitter.submitAndConfirm`) including the `memo` 5th-positional argument and the `-m:<memo>` / `-i:<idempotency_key>` idempotency-key suffixes, so behaviour is identical to the standalone tool. Depends on FN-064 (memo arg on `buildTransferTx`) and FN-065 (memo wired through `transfer_native`).
