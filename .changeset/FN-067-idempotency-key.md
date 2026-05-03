---
"eto-mcp": minor
---

FN-067: `transfer_native` now accepts an optional `idempotency_key` parameter. The in-flight idempotency key is composed as `transfer-${from}-${to}-${lamports}-${blockhash}${memoSuffix}${userSuffix}`, where `memoSuffix = "-m:${memo}"` when a memo is supplied and `userSuffix = "-i:${idempotency_key}"` when the caller supplies a key. This guarantees that (a) parallel transfers with different memos never coalesce, and (b) callers launching parallel transfers that share from/to/amount/memo can force distinct submissions by passing different `idempotency_key` values. The composition is exposed as `buildTransferIdempotencyKey` for unit testing.

Backward compatibility: callers that omit both `memo` and `idempotency_key` get the unchanged base key (`transfer-${from}-${to}-${lamports}-${blockhash}`), so existing behaviour is preserved.
