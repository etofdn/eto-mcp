# Soak harness — MCP-P0-01

Exercises the acceptance criterion:

> 100 restarts of the SSE server, same thirdweb address re-auths every time,
> wallets survive every restart, active wallet survives every restart,
> zero "Wallet not found" errors.

## What it does

1. Spawns `bun run src/sse-server.ts` on `PORT=8081` with `AUTH_DEV_BYPASS=false` and
   your real thirdweb credentials.
2. Polls `/health` until 200 (max 15s per boot).
3. Authenticates via `POST /auth/login` → `signLoginPayload` (thirdweb SIWE) → `POST /auth/verify`
   using a deterministic private key in `SOAK_PRIVKEY`. Gets a bearer `token`.
4. Opens `GET /sse` with the token, holds it open, parses the `event: endpoint` frame
   to pull out the MCP `sessionId`.
5. Drives JSON-RPC on `POST /message?sessionId=...`:
   - iter 0: `initialize`, `tools/list`, `create_wallet {label: "soak"}`,
     `set_active_wallet {wallet_id}`.
   - iters 1..99: `session_info` and asserts that the iteration-0 wallet is still
     present and is still the active wallet. Falls back to `list_wallets` if
     `session_info` is unavailable.
6. Closes the SSE stream, `SIGTERM`s the child (then `SIGKILL` after 3s if it
   hangs), waits for exit.
7. Writes `tests/soak/soak-report.json` and `tests/soak/soak-report.md`.

Exit code is `0` only if `wallet_losses === 0 && active_losses === 0 && errors_total === 0`.

## Run

```bash
export THIRDWEB_CLIENT_ID=...
export THIRDWEB_SECRET_KEY=...
export ETO_WALLET_PASSPHRASE=...
export SOAK_PRIVKEY=0x<64-hex>    # deterministic EVM private key for the soak identity

bun run tests/soak/soak-p0-01.ts --yes
```

The harness **wipes** `~/.eto/wallets/<address>.enc` and `<address>.active` for the
soak address before iteration 0 so `create_wallet` starts from a clean slate.
The `--yes` flag (or `-y`) skips the interactive confirmation prompt.

## Notes / TODOs

- The harness expects the concurrent auth PR to land `POST /auth/login` and
  `POST /auth/verify` endpoints on the SSE server. Until then it will fail at
  step 3 with a non-200 from `/auth/login`.
- Wallet-file lookup assumes `session.sub === lowercased EVM address` for SIWE
  identities (this is the thirdweb convention). If the auth implementation
  picks a different `sub` (e.g. a hash), update the `wipeSoakWalletFiles`
  candidates in `soak-p0-01.ts` and the `clean.sh` script accordingly.
- SIWE signing is handled by `signLoginPayload` from `thirdweb/auth` to avoid
  re-implementing the canonical EIP-4361 message format. No shortcut was taken;
  no dev-bypass fallback.

## `clean.sh`

Deletes `~/.eto/wallets/<address>.enc` and `.active` for a given address.
Guarded behind `--force` so it can't run by accident:

```bash
tests/soak/clean.sh --force 0xYourSoakAddress
```
