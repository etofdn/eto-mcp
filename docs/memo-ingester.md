# Memo Block Ingester (FN-105)

Live `logsSubscribe` → `getTransaction` → `MemoIndex.ingestBatch` pipeline for
SPL Memo Program v2 instructions.

## Overview

`MemoBlockIngester` subscribes to the ETO node's WebSocket `logsSubscribe` filtered
to mentions of `MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr` (Memo Program v2).
For each confirmed notification it calls `getTransaction` to hydrate the full tx,
parses every memo instruction into a `MemoEntry`, and batches them into
`MemoIndex.ingestBatch()`. Slot-based checkpointing ensures a crashed/restarted
instance resumes without gaps (note: notifications received during an outage are
lost — see Reconnect section).

This is the producer side of the FN-061 indexer-backed `query_memos` story.

## Migration Order

Apply migrations in this order before running the ingester:

```sh
psql "$AUDIT_DB_URL" -f scripts/migrations/001_kyt_events.sql
psql "$AUDIT_DB_URL" -f scripts/migrations/002_memo_events.sql
psql "$AUDIT_DB_URL" -f scripts/migrations/003_memo_ingester_checkpoint.sql
```

## How to Run

```sh
# With tsx (development)
ETO_MEMO_INGESTER_ENABLED=true tsx src/services/indexer/memo-ingester-main.ts

# With compiled output
ETO_MEMO_INGESTER_ENABLED=true node dist/services/indexer/memo-ingester-main.js
```

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `ETO_MEMO_INGESTER_ENABLED` | `false` | Must be `"true"` to start the ingester |
| `ETO_MEMO_INGESTER_ID` | `"default"` | Logical ingester name (checkpoint key) |
| `ETO_MEMO_INGESTER_BATCH_SIZE` | `25` | Flush when pending batch reaches this size |
| `ETO_MEMO_INGESTER_FLUSH_MS` | `1000` | Periodic flush interval (ms) |
| `ETO_MEMO_INGESTER_RECONNECT_MS` | `1000` | Initial reconnect backoff (ms) |
| `ETO_MEMO_INGESTER_RECONNECT_MAX_MS` | `30000` | Max reconnect backoff (ms) |
| `ETO_MEMO_INGESTER_RPC_CONCURRENCY` | `4` | Worker pool size for getTransaction |
| `ETO_WS_URL` / `SOLANA_WS_URL` | derived from RPC | WebSocket URL for logsSubscribe |
| `ETO_RPC_URL` / `SOLANA_RPC_URL` | `http://127.0.0.1:8899` | JSON-RPC URL for getTransaction |
| `MEMO_INGESTER_DB_URL` | falls back to `AUDIT_DB_URL` | Postgres URL for checkpoint store |
| `AUDIT_DB_URL` | — | Shared Postgres cluster (used if MEMO_INGESTER_DB_URL unset) |

## Reconnect / Backoff

On WebSocket close or error the ingester sleeps `min(initialMs × 2^attempt, maxMs)`
before reconnecting and re-issuing the same `logsSubscribe`. Any signatures observed
during the outage are **not automatically backfilled** — operators should run a manual
replay using `getSignaturesForAddress` (tracked as a follow-up task).

Log a `warn` line including the outage duration to enable operator alerting.

## Idempotency

`memo_entries.signature` has a `UNIQUE` constraint. `ingestBatch` uses
`ON CONFLICT DO NOTHING`, making re-ingest of the same signature a safe no-op.
The checkpoint is persisted **after** a successful `ingestBatch` call, never before,
so a crash mid-flush will re-process the same slot range on restart.

## Observability

Call `ingester.stats()` to read live counters:

```ts
{
  connected: boolean;       // WebSocket open
  pendingBatch: number;     // entries buffered but not yet flushed
  lastFlushedSlot: number | null; // highest checkpoint slot
  reconnects: number;       // total reconnect cycles
  rpcErrors: number;        // getTransaction failures (all retries exhausted)
  parseErrors: number;      // memo records that failed extractMemoEntries
  flushed: number;          // total MemoEntry records ingested
}
```

Example operator alert: `rpcErrors > 0 || parseErrors > 0` after a flush cycle
warrants investigation.

## FN-061 Hand-off

The ingester is the **producer**. FN-061 (`query_memos` MCP tool) is the **reader**
and queries `memo_entries` via `PostgresMemoIndex.query()`.
