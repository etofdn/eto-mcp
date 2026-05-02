#!/usr/bin/env bash
# =============================================================================
# probe-faucet.sh — Probe the ETO devnet faucet JSON-RPC endpoint for
#                   rate-limiting, error masking, and connection behaviour.
#
# Task: FN-097
# GitHub Issue: https://github.com/etofdn/eto-mcp/issues/13
#
# USAGE
#   bash probe-faucet.sh [ADDRESS]
#
#   ADDRESS  Optional SVM address to receive funds (default: generates one from
#            /dev/urandom bytes encoded to approximate base58; a valid-looking
#            but random 32-byte public key)
#
# WHAT THIS SCRIPT DOES
#   Phase 1 — Burst: sends 20 faucet calls in tight succession, capturing
#             full HTTP response (status line, headers, body) for each.
#   Phase 2 — Spaced: sends 5 faucet calls with 30 s gaps between each.
#   Phase 3 — getTransaction: for each unique signature obtained in Phase 1,
#             polls getTransaction at 1 s, 5 s, and 30 s after the faucet call.
#
# ARTIFACTS (written to ARTIFACT_DIR, defaults to .fusion/tasks/FN-097/artifacts)
#   burst-NN.txt          Full curl -i response for each burst call
#   spaced-NN.txt         Full curl -i response for each spaced call
#   gettx-SIG-Xs.txt      getTransaction response at 1/5/30 s for each signature
#   burst-summary.tsv     Summary table: call# | HTTP status | result type | sig-prefix
#   spaced-summary.tsv    Summary table for spaced calls
#   gettx-summary.tsv     getTransaction poll results
#
# ENV VARS
#   ETO_RPC_URL       JSON-RPC endpoint (default: http://127.0.0.1:8899)
#   AMOUNT_LAMPORTS   Amount to airdrop  (default: 10000000000 = 10 ETO)
#   ARTIFACT_DIR      Output directory   (default: .fusion/tasks/FN-097/artifacts)
#   BURST_COUNT       Number of burst calls (default: 20)
#   SPACED_COUNT      Number of spaced calls (default: 5)
#   SPACED_GAP_S      Gap in seconds between spaced calls (default: 30)
# =============================================================================
set -euo pipefail

# ── CONFIGURATION ─────────────────────────────────────────────────────────────
ETO_RPC_URL="${ETO_RPC_URL:-http://127.0.0.1:8899}"
AMOUNT_LAMPORTS="${AMOUNT_LAMPORTS:-10000000000}"  # 10 ETO in lamports
BURST_COUNT="${BURST_COUNT:-20}"
SPACED_COUNT="${SPACED_COUNT:-5}"
SPACED_GAP_S="${SPACED_GAP_S:-30}"

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
ARTIFACT_DIR="${ARTIFACT_DIR:-$(cd -- "$SCRIPT_DIR/.." && pwd)/artifacts}"
mkdir -p "$ARTIFACT_DIR"

# ── COLOURS ───────────────────────────────────────────────────────────────────
if [[ -t 1 ]]; then
  RED=$'\033[31m'; GREEN=$'\033[32m'; YELLOW=$'\033[33m'
  CYAN=$'\033[36m'; BOLD=$'\033[1m'; RESET=$'\033[0m'
else
  RED=""; GREEN=""; YELLOW=""; CYAN=""; BOLD=""; RESET=""
fi

echo "${BOLD}FN-097 Faucet Probe — ${ETO_RPC_URL}${RESET}"
echo "Artifacts → ${ARTIFACT_DIR}"

# ── ADDRESS GENERATION ────────────────────────────────────────────────────────
# Generate a valid base58-encoded SVM address (32 random bytes, base58-encoded).
# A valid Solana/SVM public key is exactly 44 base58 characters.
generate_address() {
  if command -v python3 &>/dev/null; then
    python3 -c "
import os
chars = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz'
# Proper base58 encoding of 32 random bytes
b = os.urandom(32)
num = int.from_bytes(b, 'big')
result = ''
while num > 0:
    num, r = divmod(num, 58)
    result = chars[r] + result
# Count leading zero bytes and prepend '1' for each
leading = len(b) - len(b.lstrip(b'\\x00'))
result = chars[0] * leading + result
# Pad to 44 if shorter (rare), or take first 44 if longer
while len(result) < 44:
    result = chars[0] + result
print(result[:44])
"
  else
    # Fallback: known valid devnet SVM address (from FN-095 run artifacts)
    echo "94bSVuA4Xu6gxciDmz3td87nDuiFknVFzGQJhXgWtzeq"
  fi
}

ADDRESS="${1:-$(generate_address)}"
echo "Address: ${CYAN}${ADDRESS}${RESET}"
echo ""

# ── HELPER: single faucet call ─────────────────────────────────────────────────
# Usage: do_faucet_call OUTFILE [extra_curl_args...]
# Writes full HTTP response (headers + body) to OUTFILE.
# Returns the HTTP status code.
do_faucet_call() {
  local outfile="$1"
  shift
  local payload
  payload=$(printf '{"jsonrpc":"2.0","id":1,"method":"faucet","params":["%s",%s]}' \
    "$ADDRESS" "$AMOUNT_LAMPORTS")
  
  local http_code
  http_code=$(curl -s -i \
    --max-time 15 \
    -X POST \
    -H "Content-Type: application/json" \
    -H "Accept: application/json" \
    -H "Connection: keep-alive" \
    --write-out "\n\n--- HTTP_CODE: %{http_code} ---\n--- TIME_TOTAL: %{time_total}s ---\n--- TIME_CONNECT: %{time_connect}s ---\n--- NUM_CONNECTS: %{num_connects} ---\n" \
    -d "$payload" \
    "$@" \
    "$ETO_RPC_URL" \
    2>&1 | tee "$outfile" | grep "^--- HTTP_CODE:" | grep -o '[0-9][0-9][0-9]' || echo "000")
  echo "${http_code:-000}"
}

# ── HELPER: extract sig from response body ────────────────────────────────────
extract_sig() {
  local file="$1"
  # Try .result.signature first, then .result (if string), then .result.txhash
  grep -o '"signature":"[^"]*"' "$file" | head -1 | grep -o '"[^"]*"$' | tr -d '"' || \
  grep -o '"result":"[^"]*"' "$file" | head -1 | grep -o '"[^"]*"$' | tr -d '"' || \
  echo ""
}

# ── HELPER: getTransaction probe ─────────────────────────────────────────────
probe_gettx() {
  local sig="$1"
  local delay="$2"
  local outfile="${ARTIFACT_DIR}/gettx-${sig:0:16}-${delay}s.txt"
  local payload
  payload=$(printf '{"jsonrpc":"2.0","id":1,"method":"getTransaction","params":["%s"]}' "$sig")
  
  sleep "$delay" 2>/dev/null || true
  
  curl -s -i \
    --max-time 10 \
    -X POST \
    -H "Content-Type: application/json" \
    -d "$payload" \
    --write-out "\n\n--- HTTP_CODE: %{http_code} ---\n--- TIME_TOTAL: %{time_total}s ---\n" \
    "$ETO_RPC_URL" \
    > "$outfile" 2>&1 || true
  
  local result
  result=$(grep -o '"result":[^,}]*' "$outfile" | head -1 || echo '"result":null')
  echo "$sig	${delay}s	${result}" >> "${ARTIFACT_DIR}/gettx-summary.tsv"
}

# ── PHASE 1: BURST CALLS ──────────────────────────────────────────────────────
echo "${BOLD}Phase 1: Burst (${BURST_COUNT} calls, no delay)${RESET}"
echo "call	http_code	result_type	sig_prefix	duration" > "${ARTIFACT_DIR}/burst-summary.tsv"

declare -a BURST_SIGS=()
for i in $(seq 1 "$BURST_COUNT"); do
  IDX=$(printf '%02d' "$i")
  OUTFILE="${ARTIFACT_DIR}/burst-${IDX}.txt"
  
  START_MS=$(date +%s%N 2>/dev/null || date +%s)
  HTTP_CODE=$(do_faucet_call "$OUTFILE")
  END_MS=$(date +%s%N 2>/dev/null || date +%s)
  
  SIG=$(extract_sig "$OUTFILE")
  BURST_SIGS+=("$SIG")
  
  # Determine result type
  if grep -q '"error"' "$OUTFILE" 2>/dev/null; then
    RESULT_TYPE="error"
  elif [[ -n "$SIG" ]]; then
    RESULT_TYPE="signature"
  else
    RESULT_TYPE="unknown"
  fi
  
  # Extract timing from curl output
  DURATION=$(grep "TIME_TOTAL" "$OUTFILE" 2>/dev/null | grep -o '[0-9.]*s' | head -1 || echo "?")
  
  echo "${i}	${HTTP_CODE}	${RESULT_TYPE}	${SIG:0:20}	${DURATION}" >> "${ARTIFACT_DIR}/burst-summary.tsv"
  
  # Print progress
  if [[ "${RESULT_TYPE}" == "error" ]]; then
    echo "  [${IDX}] ${RED}${HTTP_CODE} ERROR${RESET} — $(grep -o '"message":"[^"]*"' "$OUTFILE" | head -1 || echo 'no message') ${DURATION}"
  else
    echo "  [${IDX}] ${GREEN}${HTTP_CODE} OK${RESET} — sig: ${SIG:0:20}... ${DURATION}"
  fi
done

echo ""
echo "Burst summary written to ${ARTIFACT_DIR}/burst-summary.tsv"

# ── PHASE 2: SPACED CALLS ─────────────────────────────────────────────────────
echo ""
echo "${BOLD}Phase 2: Spaced (${SPACED_COUNT} calls, ${SPACED_GAP_S}s gap)${RESET}"
echo "call	http_code	result_type	sig_prefix	duration" > "${ARTIFACT_DIR}/spaced-summary.tsv"

for i in $(seq 1 "$SPACED_COUNT"); do
  IDX=$(printf '%02d' "$i")
  OUTFILE="${ARTIFACT_DIR}/spaced-${IDX}.txt"
  
  HTTP_CODE=$(do_faucet_call "$OUTFILE")
  SIG=$(extract_sig "$OUTFILE")
  
  if grep -q '"error"' "$OUTFILE" 2>/dev/null; then
    RESULT_TYPE="error"
  elif [[ -n "$SIG" ]]; then
    RESULT_TYPE="signature"
  else
    RESULT_TYPE="unknown"
  fi
  
  DURATION=$(grep "TIME_TOTAL" "$OUTFILE" 2>/dev/null | grep -o '[0-9.]*s' | head -1 || echo "?")
  
  echo "${i}	${HTTP_CODE}	${RESULT_TYPE}	${SIG:0:20}	${DURATION}" >> "${ARTIFACT_DIR}/spaced-summary.tsv"
  
  if [[ "${RESULT_TYPE}" == "error" ]]; then
    echo "  [${IDX}] ${RED}${HTTP_CODE} ERROR${RESET} — $(grep -o '"message":"[^"]*"' "$OUTFILE" | head -1 || echo 'no message') ${DURATION}"
  else
    echo "  [${IDX}] ${GREEN}${HTTP_CODE} OK${RESET} — sig: ${SIG:0:20}... ${DURATION}"
  fi
  
  if [[ "$i" -lt "$SPACED_COUNT" ]]; then
    echo "  ... waiting ${SPACED_GAP_S}s ..."
    sleep "$SPACED_GAP_S"
  fi
done

echo ""
echo "Spaced summary written to ${ARTIFACT_DIR}/spaced-summary.tsv"

# ── PHASE 3: getTransaction POLLS ────────────────────────────────────────────
echo ""
echo "${BOLD}Phase 3: getTransaction polls for burst signatures${RESET}"
echo "sig_prefix	delay	result" > "${ARTIFACT_DIR}/gettx-summary.tsv"

# Deduplicate signatures and take up to 5 unique ones
declare -A SEEN_SIGS
PROBE_SIGS=()
for sig in "${BURST_SIGS[@]}"; do
  if [[ -n "$sig" && -z "${SEEN_SIGS[$sig]+x}" ]]; then
    SEEN_SIGS[$sig]=1
    PROBE_SIGS+=("$sig")
    if [[ ${#PROBE_SIGS[@]} -ge 5 ]]; then
      break
    fi
  fi
done

for sig in "${PROBE_SIGS[@]}"; do
  echo "  Probing getTransaction for sig: ${sig:0:20}..."
  
  echo "  [1s delay] polling..."
  probe_gettx "$sig" 1
  echo "  [4s more delay] polling..."
  probe_gettx "$sig" 4   # runs 5s after faucet (4s gap from 1s probe)
  echo "  [25s more delay] polling..."
  probe_gettx "$sig" 25  # runs ~30s after faucet (cumulative ~30s)
done

echo ""
echo "getTransaction summary written to ${ARTIFACT_DIR}/gettx-summary.tsv"

# ── RATE-LIMIT HEADER SCAN ────────────────────────────────────────────────────
echo ""
echo "${BOLD}Rate-limit header scan across all burst responses:${RESET}"
echo "Checking for: X-RateLimit-*, Retry-After, 429, 503, 5xx..."

RATE_HEADERS_FOUND=0
for f in "${ARTIFACT_DIR}"/burst-*.txt; do
  if grep -qi "x-ratelimit\|retry-after\|429\|503\|too many\|rate limit" "$f" 2>/dev/null; then
    echo "  ${YELLOW}FOUND rate-limit signal in: $(basename "$f")${RESET}"
    grep -i "x-ratelimit\|retry-after\|429\|503\|too many\|rate limit" "$f" || true
    RATE_HEADERS_FOUND=$((RATE_HEADERS_FOUND + 1))
  fi
done

if [[ $RATE_HEADERS_FOUND -eq 0 ]]; then
  echo "  ${GREEN}No rate-limit headers found in any burst response${RESET}"
fi

# ── SUMMARY ───────────────────────────────────────────────────────────────────
echo ""
echo "${BOLD}=== Summary ===${RESET}"
echo "Burst calls:  ${BURST_COUNT}"
echo "Spaced calls: ${SPACED_COUNT} (${SPACED_GAP_S}s gap)"
echo "Artifacts:    ${ARTIFACT_DIR}/"
echo ""

BURST_OK=$(grep -c "	signature	" "${ARTIFACT_DIR}/burst-summary.tsv" 2>/dev/null || echo 0)
BURST_ERR=$(grep -c "	error	" "${ARTIFACT_DIR}/burst-summary.tsv" 2>/dev/null || echo 0)
GETTX_NULL=$(grep -c '"result":null' "${ARTIFACT_DIR}/gettx-summary.tsv" 2>/dev/null || echo 0)
if [[ -f "${ARTIFACT_DIR}/gettx-summary.tsv" ]]; then
  GETTX_FOUND=$(grep -cv '"result":null\|sig_prefix' "${ARTIFACT_DIR}/gettx-summary.tsv" 2>/dev/null || true)
  GETTX_FOUND=${GETTX_FOUND:-0}
else
  GETTX_FOUND=0
fi

echo "Burst results:   ${GREEN}${BURST_OK} OK${RESET} / ${RED}${BURST_ERR} error${RESET}"
echo "getTransaction:  ${GETTX_FOUND} found / ${GETTX_NULL} null (not landed)"
