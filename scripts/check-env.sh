#!/usr/bin/env bash
# check-env.sh — sanity-check that required env keys exist in the env file
# used by eto-mcp. The repo's src/config.ts reads process.env directly (no
# dotenv loader), so whatever shell starts the server must export these vars.
# Bun auto-loads `.env` from the process CWD — NOT from /home/naman/eto/.env —
# so either `cd /home/naman/eto` before `bun run ...`, symlink that file into
# the project root, or `export $(grep -v '^#' /home/naman/eto/.env | xargs)`.
#
# Usage:
#   bash scripts/check-env.sh                   # uses /home/naman/eto/.env
#   ENV_FILE=./.env bash scripts/check-env.sh   # override path
#
set -euo pipefail

ENV_FILE="${ENV_FILE:-/home/naman/eto/.env}"

if [[ -t 1 ]]; then
  RED=$'\033[31m'; GREEN=$'\033[32m'; YELLOW=$'\033[33m'; BOLD=$'\033[1m'; RESET=$'\033[0m'
else
  RED=""; GREEN=""; YELLOW=""; BOLD=""; RESET=""
fi

REQUIRED=(THIRDWEB_CLIENT_ID THIRDWEB_SECRET_KEY ETO_WALLET_PASSPHRASE)
OPTIONAL=(AUTH_DOMAIN AUTH_DEV_BYPASS PORT)

echo "${BOLD}env-file:${RESET} $ENV_FILE"
if [[ ! -f "$ENV_FILE" ]]; then
  printf "%s[FAIL]%s env file not found: %s\n" "$RED" "$RESET" "$ENV_FILE"
  exit 1
fi
echo

# Returns value for KEY from $ENV_FILE, stripping surrounding quotes. Empty
# string if key not present.
get_val() {
  local key="$1"
  local line
  line=$(grep -E "^${key}=" "$ENV_FILE" | tail -n 1 || true)
  [[ -z "$line" ]] && { echo ""; return; }
  local val="${line#*=}"
  val="${val%$'\r'}"
  # strip matching single or double quotes
  if [[ "$val" == \"*\" || "$val" == \'*\' ]]; then
    val="${val:1:${#val}-2}"
  fi
  echo "$val"
}

missing=0
echo "${BOLD}required:${RESET}"
for k in "${REQUIRED[@]}"; do
  v=$(get_val "$k")
  if [[ -n "$v" ]]; then
    printf "  %s[OK]%s       %s\n" "$GREEN" "$RESET" "$k"
  else
    printf "  %s[MISSING]%s  %s\n" "$RED" "$RESET" "$k"
    missing=$((missing+1))
  fi
done

echo
echo "${BOLD}optional:${RESET}"
for k in "${OPTIONAL[@]}"; do
  v=$(get_val "$k")
  if [[ -n "$v" ]]; then
    printf "  %s[OPTIONAL set]%s   %s=%s\n" "$YELLOW" "$RESET" "$k" "$v"
  else
    printf "  %s[OPTIONAL unset]%s %s\n" "$YELLOW" "$RESET" "$k"
  fi
done

echo
echo "${BOLD}src/config.ts env references:${RESET}"
# Note: read-only peek at how env is loaded. No edits.
grep -n -E "config|\.env|process\.env" /home/naman/eto/eto-mcp/src/config.ts || true

echo
echo "${BOLD}src/config.ts (first 30 lines):${RESET}"
head -n 30 /home/naman/eto/eto-mcp/src/config.ts

echo
if (( missing > 0 )); then
  printf "%sresult:%s %d required key(s) missing\n" "$RED" "$RESET" "$missing"
  exit 1
fi
printf "%sresult:%s all required env keys present\n" "$GREEN" "$RESET"
