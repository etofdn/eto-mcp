# Database Migrations

Apply migrations in order using psql:

```sh
psql "$AUDIT_DB_URL" -f scripts/migrations/001_kyt_events.sql
psql "$AUDIT_DB_URL" -f scripts/migrations/002_memo_events.sql
psql "$AUDIT_DB_URL" -f scripts/migrations/003_memo_ingester_checkpoint.sql
```

## Tables

| Table | Task | Description |
|-------|------|-------------|
| kyt_events | FN-083 | KYT audit trail events. |
| memo_entries | FN-093 | SPL Memo Program v2 indexed entries. |
| memo_ingester_checkpoint | FN-105 | Ingester resume marker (one row per logical ingester id). |
