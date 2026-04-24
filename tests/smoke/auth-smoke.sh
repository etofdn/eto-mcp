#!/usr/bin/env bash
# auth-smoke.sh — SSE auth smoke test for eto-mcp
#
# NOTE: Does NOT test signed /auth/verify success path (that needs a wallet
# + EIP-4361 signing) — see tests/soak/ for the full signed path.
#
# How to run:
#   Tab 1 (server): from /home/naman/eto/eto-mcp run
#     AUTH_DEV_BYPASS=false \
#     THIRDWEB_CLIENT_ID=... \
#     THIRDWEB_SECRET_KEY=... \
#     bun run start:sse
#   Tab 2 (test):   bash tests/smoke/auth-smoke.sh
#
# Requires: curl, jq.
#
set -euo pipefail

BASE="http://localhost:${PORT:-8080}"

# Colors (disable when not a TTY).
if [[ -t 1 ]]; then
  RED=$'\033[31m'; GREEN=$'\033[32m'; YELLOW=$'\033[33m'; BOLD=$'\033[1m'; RESET=$'\033[0m'
else
  RED=""; GREEN=""; YELLOW=""; BOLD=""; RESET=""
fi

FAILS=0
PASSES=0

pass() { printf "%s[PASS]%s %s\n" "$GREEN" "$RESET" "$1"; PASSES=$((PASSES+1)); }
fail() { printf "%s[FAIL]%s %s\n" "$RED"   "$RESET" "$1"; FAILS=$((FAILS+1)); }
info() { printf "%s[....]%s %s\n" "$YELLOW" "$RESET" "$1"; }

for bin in curl jq; do
  command -v "$bin" >/dev/null || { echo "missing dependency: $bin"; exit 2; }
done

echo "${BOLD}eto-mcp auth smoke → ${BASE}${RESET}"
echo

# --- Assertion 1: /health returns 200 ---------------------------------------
info "A1: GET /health → 200"
if curl -sfI "${BASE}/health" >/dev/null; then
  pass "A1 /health returned 200"
else
  fail "A1 /health did not return 200 (is the server up at ${BASE}?)"
fi

# --- Assertion 2: unauth GET /sse → 401 + WWW-Authenticate ------------------
info "A2: GET /sse without bearer → 401 + WWW-Authenticate"
sse_resp=$(curl -s -i -m 5 "${BASE}/sse" -H "Accept: text/event-stream" || true)
sse_code=$(printf '%s' "$sse_resp" | awk 'NR==1{print $2}')
if [[ "$sse_code" == "401" ]] && \
   printf '%s' "$sse_resp" | grep -qi "www-authenticate: Bearer" && \
   printf '%s' "$sse_resp" | grep -qi "resource_metadata="; then
  pass "A2 /sse returned OAuth challenge"
else
  fail "A2 /sse did not return OAuth challenge — status=${sse_code:-none} body=${sse_resp:0:200}"
fi

# --- Assertion 3: unauth POST /message → 401 --------------------------------
info "A3: POST /message?sessionId=x without bearer → 401"
code=$(curl -s -o /dev/null -w "%{http_code}" \
  -X POST "${BASE}/message?sessionId=x" \
  -H "Content-Type: application/json" \
  -d '{}')
if [[ "$code" == "401" ]]; then
  pass "A3 /message returned 401 (dev-bypass is off)"
else
  fail "A3 /message returned $code, expected 401 (is AUTH_DEV_BYPASS=false?)"
fi

# --- Assertion 4: /auth/login returns payload ------------------------------
info "A4: POST /auth/login → JSON with payload field"
login_body=$(curl -s -X POST "${BASE}/auth/login" \
  -H "Content-Type: application/json" \
  -d '{"address":"0x0000000000000000000000000000000000000001","chainId":1}' || true)
if printf '%s' "$login_body" | jq -e '.payload' >/dev/null 2>&1; then
  pass "A4 /auth/login returned payload"
else
  fail "A4 /auth/login did not return a payload field — body: ${login_body:0:200}"
fi

# --- Assertion 5: /auth/verify with garbage sig → 401 + code/AUTH_001 -------
info "A5: POST /auth/verify with garbage signature → 401 + code"
verify_resp=$(curl -s -w "\n__HTTP__%{http_code}" -X POST "${BASE}/auth/verify" \
  -H "Content-Type: application/json" \
  -d '{"payload":{"domain":"localhost","address":"0x0000000000000000000000000000000000000001","statement":"","uri":"http://localhost","version":"1","chain_id":1,"nonce":"deadbeef","issued_at":"2026-01-01T00:00:00Z"},"signature":"0xdeadbeef","strategy":"siwe"}' || true)
v_code=$(printf '%s' "$verify_resp" | awk -F'__HTTP__' 'NF>1{print $2}')
v_body=$(printf '%s' "$verify_resp" | sed 's/__HTTP__[0-9]*$//')
if [[ "$v_code" == "401" ]] && \
   ( printf '%s' "$v_body" | grep -q "AUTH_001" || printf '%s' "$v_body" | jq -e '.code' >/dev/null 2>&1 ); then
  pass "A5 /auth/verify rejected garbage signature (401 + code)"
else
  fail "A5 /auth/verify status=$v_code body=${v_body:0:200}"
fi

# --- Assertion 6: /auth/me without bearer → 401 -----------------------------
info "A6: GET /auth/me without Authorization → 401"
me_code=$(curl -s -o /dev/null -w "%{http_code}" "${BASE}/auth/me")
if [[ "$me_code" == "401" ]]; then
  pass "A6 /auth/me returned 401 when unauthenticated"
else
  fail "A6 /auth/me returned $me_code, expected 401"
fi

echo
echo "${BOLD}Results:${RESET} ${GREEN}${PASSES} passed${RESET}, ${RED}${FAILS} failed${RESET}"
if [[ $FAILS -gt 0 ]]; then exit 1; fi
exit 0
