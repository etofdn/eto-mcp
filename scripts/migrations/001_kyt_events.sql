-- Migration 001: KYT audit-trail event tables
-- FATF Recommendation 11 requires five-year retention of all records
-- related to virtual-asset transfers. These tables provide the durable
-- backing store for the ETO audit-trail indexer (FN-130 / FN-083).
--
-- Apply with:
--   psql "$AUDIT_DB_URL" -f scripts/migrations/001_kyt_events.sql

-- ---------------------------------------------------------------------
-- kyt_events: one row per on-chain KytTrace event
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS kyt_events (
    id               BIGSERIAL PRIMARY KEY,
    tx_signature     TEXT       NOT NULL UNIQUE,
    slot             BIGINT     NOT NULL,
    stage            TEXT       NOT NULL CHECK (stage IN ('init', 'confirm', 'rate')),
    chain_timestamp  BIGINT     NOT NULL,   -- unix seconds from KytTraceEvent.timestamp
    bap_authority    TEXT       NOT NULL,
    bpp_authority    TEXT       NOT NULL,
    bap_cred_pointers TEXT[]    NOT NULL DEFAULT '{}',
    bpp_cred_pointers TEXT[]    NOT NULL DEFAULT '{}',
    ingested_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS kyt_events_slot_idx
    ON kyt_events (slot);

CREATE INDEX IF NOT EXISTS kyt_events_bap_authority_slot_idx
    ON kyt_events (bap_authority, slot);

CREATE INDEX IF NOT EXISTS kyt_events_bpp_authority_slot_idx
    ON kyt_events (bpp_authority, slot);

-- ---------------------------------------------------------------------
-- revocation_events: one row per RevocationRootUpdated event
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS revocation_events (
    id           BIGSERIAL PRIMARY KEY,
    oracle       TEXT       NOT NULL,
    network      TEXT       NOT NULL,
    root         TEXT       NOT NULL,
    leaves       BIGINT     NOT NULL,
    slot         BIGINT     NOT NULL,
    ingested_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (oracle, root, slot)   -- idempotency key
);

CREATE INDEX IF NOT EXISTS revocation_events_slot_idx
    ON revocation_events (slot);

CREATE INDEX IF NOT EXISTS revocation_events_oracle_slot_idx
    ON revocation_events (oracle, slot);
