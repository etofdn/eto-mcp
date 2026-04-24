#!/usr/bin/env bash
# Remote QA checks for a deployed eto-mcp Fly app.
#
# Usage:
#   BASE_URL=https://eto-mcp-staging.fly.dev bash scripts/qa-remote.sh
#   bash scripts/qa-remote.sh https://eto-mcp.fly.dev
set -euo pipefail

BASE_URL="${1:-${BASE_URL:-}}"
TIMEOUT="${QA_TIMEOUT:-10}"

if [[ -z "$BASE_URL" ]]; then
  echo "usage: BASE_URL=https://... bash scripts/qa-remote.sh" >&2
  exit 2
fi

BASE_URL="${BASE_URL%/}"

if [[ -t 1 ]]; then
  RED=$'\033[31m'; GREEN=$'\033[32m'; YELLOW=$'\033[33m'; BOLD=$'\033[1m'; RESET=$'\033[0m'
else
  RED=""; GREEN=""; YELLOW=""; BOLD=""; RESET=""
fi

PASSES=0
FAILS=0

pass() { printf "%s[PASS]%s %s\n" "$GREEN" "$RESET" "$1"; PASSES=$((PASSES+1)); }
fail() { printf "%s[FAIL]%s %s\n" "$RED" "$RESET" "$1"; FAILS=$((FAILS+1)); }
info() { printf "%s[....]%s %s\n" "$YELLOW" "$RESET" "$1"; }

http_code() {
  curl -sS -o /dev/null -w "%{http_code}" -m "$TIMEOUT" "$@"
}

echo "${BOLD}eto-mcp remote QA -> ${BASE_URL}${RESET}"
echo

info "health endpoint returns 200 and status ok"
health_body="$(curl -fsS -m "$TIMEOUT" "${BASE_URL}/health" || true)"
if [[ "$health_body" == *'"status":"ok"'* || "$health_body" == *'"status": "ok"'* ]]; then
  pass "/health is healthy"
else
  fail "/health did not return status ok; body=${health_body:0:240}"
fi

info "OAuth protected-resource metadata is published"
prm_body="$(curl -fsS -m "$TIMEOUT" "${BASE_URL}/.well-known/oauth-protected-resource" || true)"
if [[ "$prm_body" == *'"authorization_servers"'* && "$prm_body" == *'"resource"'* ]]; then
  pass "protected-resource metadata is present"
else
  fail "protected-resource metadata missing required fields; body=${prm_body:0:240}"
fi

info "OAuth authorization-server metadata is published"
as_body="$(curl -fsS -m "$TIMEOUT" "${BASE_URL}/.well-known/oauth-authorization-server" || true)"
if [[ "$as_body" == *'"authorization_endpoint"'* && "$as_body" == *'"token_endpoint"'* && "$as_body" == *'"registration_endpoint"'* ]]; then
  pass "authorization-server metadata is present"
else
  fail "authorization-server metadata missing required fields; body=${as_body:0:240}"
fi

info "login page is reachable"
login_code="$(http_code "${BASE_URL}/login" || true)"
if [[ "$login_code" == "200" ]]; then
  pass "/login returns 200"
else
  fail "/login returned ${login_code:-none}"
fi

info "unauthenticated SSE connection returns OAuth challenge"
sse_resp="$(curl -sS -i -m "$TIMEOUT" "${BASE_URL}/sse" -H "Accept: text/event-stream" || true)"
sse_code="$(printf '%s' "$sse_resp" | awk 'NR==1{print $2}')"
if [[ "$sse_code" == "401" ]] && \
   printf '%s' "$sse_resp" | grep -qi "www-authenticate: Bearer" && \
   printf '%s' "$sse_resp" | grep -qi "resource_metadata="; then
  pass "/sse returns OAuth challenge"
else
  fail "/sse did not return OAuth challenge; status=${sse_code:-none} body=${sse_resp:0:240}"
fi

info "unauthenticated message post returns OAuth challenge"
msg_resp="$(curl -sS -i -m "$TIMEOUT" -X POST "${BASE_URL}/message?sessionId=qa" -H "Content-Type: application/json" -d '{}' || true)"
msg_code="$(printf '%s' "$msg_resp" | awk 'NR==1{print $2}')"
if [[ "$msg_code" == "401" ]] && \
   printf '%s' "$msg_resp" | grep -qi "www-authenticate: Bearer" && \
   printf '%s' "$msg_resp" | grep -qi "AUTH_001"; then
  pass "/message returns OAuth challenge"
else
  fail "/message did not return OAuth challenge; status=${msg_code:-none} body=${msg_resp:0:240}"
fi

echo
echo "${BOLD}Results:${RESET} ${GREEN}${PASSES} passed${RESET}, ${RED}${FAILS} failed${RESET}"
if [[ "$FAILS" -gt 0 ]]; then
  exit 1
fi
