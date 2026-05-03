# Audit-Trail Migrations

## Applying migrations

Run the following command against your target database to create the KYT audit-trail tables:

```sh
psql "$AUDIT_DB_URL" -f scripts/migrations/001_kyt_events.sql
```

The migration is idempotent (`CREATE TABLE IF NOT EXISTS` / `CREATE INDEX IF NOT EXISTS`), so it is safe to re-run.

## Tables

| Table | Purpose |
|---|---|
| `kyt_events` | One row per on-chain `KytTrace` event (BAP/BPP authority pair, stage, cred pointers, slot). |
| `revocation_events` | One row per `RevocationRootUpdated` event (oracle, root, leaves, slot). |

## FATF R.11 retention

FATF Recommendation 11 requires virtual-asset service providers to retain records of all VA transfers for **at least five years**. These tables fulfil that requirement by providing durable, append-only storage for every `init`, `confirm`, and `rate` KYT trace as well as all credential-revocation root updates observed on-chain. Do **not** DELETE or TRUNCATE these tables in production; implement row-level archival (e.g. moving to cold storage) only if storage costs require it, and only after verifying compliance with applicable jurisdiction-specific retention obligations.
