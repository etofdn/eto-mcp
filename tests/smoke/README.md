# Smoke tests

Quick, dependency-light checks for the eto-mcp server. Run these after any
auth/env change, before soak tests.

1. `bash scripts/check-env.sh` — verify `/home/naman/eto/.env` has
   `THIRDWEB_CLIENT_ID`, `THIRDWEB_SECRET_KEY`, `ETO_WALLET_PASSPHRASE`. Run
   first; everything else fails without these. Override path with
   `ENV_FILE=./.env`.
2. `bash tests/smoke/stdio-smoke.sh` — spawns `bun run start`, sends
   `tools/list` over stdio, asserts `list_wallets` is present. Run after
   any change to stdio bootstrap or the auth dev-bypass default.
3. `bash tests/smoke/auth-smoke.sh` — curl-based SSE auth chain. Start the
   server in another tab with `AUTH_DEV_BYPASS=false` and thirdweb keys
   exported, then run this. Does NOT exercise the signed `/auth/verify`
   success path — see `tests/soak/` for that.
