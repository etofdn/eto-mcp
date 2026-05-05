-- Migration 003: memo block ingester checkpoint (FN-105). Follows 002_memo_events.sql.
-- Apply via: psql "$AUDIT_DB_URL" -f scripts/migrations/003_memo_ingester_checkpoint.sql
CREATE TABLE IF NOT EXISTS memo_ingester_checkpoint (
    id          TEXT PRIMARY KEY,                       -- logical ingester name; default 'default'
    last_slot   BIGINT NOT NULL,                        -- highest fully-flushed slot
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
