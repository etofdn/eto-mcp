#!/usr/bin/env bash
# stdio-smoke.sh — verifies stdio transport still lists tools under dev-bypass.
#
# Spawns `bun run start` in a subshell, pipes a JSON-RPC tools/list request
# to stdin, reads until we see a JSON-RPC reply naming `list_wallets`, then
# kills the subshell. Exits 0 on success.
#
# Requires: bun, jq.
#
set -euo pipefail

cd "$(dirname "$0")/../.."   # repo root: /home/naman/eto/eto-mcp

if [[ -t 1 ]]; then
  RED=$'\033[31m'; GREEN=$'\033[32m'; YELLOW=$'\033[33m'; RESET=$'\033[0m'
else
  RED=""; GREEN=""; YELLOW=""; RESET=""
fi
pass() { printf "%s[PASS]%s %s\n" "$GREEN" "$RESET" "$1"; }
fail() { printf "%s[FAIL]%s %s\n" "$RED"   "$RESET" "$1"; exit 1; }
info() { printf "%s[....]%s %s\n" "$YELLOW" "$RESET" "$1"; }

for bin in bun jq; do
  command -v "$bin" >/dev/null || fail "missing dependency: $bin"
done

OUT="$(mktemp)"
trap 'rm -f "$OUT"' EXIT

INIT='{"jsonrpc":"2.0","id":0,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"stdio-smoke","version":"0.0.1"}}}'
INITED='{"jsonrpc":"2.0","method":"notifications/initialized"}'
LIST='{"jsonrpc":"2.0","id":1,"method":"tools/list"}'

info "spawning: bun run start (3s window)"

# Write 3 JSON-RPC frames (each newline-delimited), run the server with a 3s
# timeout, and capture stdout. `timeout` returns 124 on SIGTERM — that is
# expected here, so we ignore non-zero via `|| true`.
{
  printf '%s\n%s\n%s\n' "$INIT" "$INITED" "$LIST"
  sleep 3
} | timeout --preserve-status --signal=TERM 3s bun run start >"$OUT" 2>/dev/null || true

# Search for a JSON-RPC response whose tools array contains list_wallets.
if grep -E '"jsonrpc":"2\.0"' "$OUT" \
  | jq -e 'select(.id==1) | .result.tools[]? | select(.name=="list_wallets")' >/dev/null 2>&1; then
  pass "stdio tools/list returned list_wallets"
  exit 0
fi

echo "--- captured stdout (last 40 lines) ---"
tail -n 40 "$OUT" || true
echo "---------------------------------------"
fail "stdio tools/list did not include list_wallets"
