#!/usr/bin/env bash
# Idempotent cleaner for the soak-test wallet files.
#
# Usage:
#   tests/soak/clean.sh --force <address>
#
# Removes:
#   ~/.eto/wallets/<address-lowercase>.enc
#   ~/.eto/wallets/<address-lowercase>.active
#   ~/.eto/wallets/<address>.enc
#   ~/.eto/wallets/<address>.active
#
# The address is lowercased because SIWE identities use the lowercased EVM
# address as their thirdweb `sub`. The original-case candidates are also
# tried in case the auth layer keeps mixed case. Safe to run repeatedly.

set -euo pipefail

usage() {
  echo "Usage: $0 --force <address>" >&2
  echo "  Example: $0 --force 0xabc123..." >&2
  exit 2
}

FORCE=0
ADDR=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --force|-f)
      FORCE=1
      shift
      ;;
    -h|--help)
      usage
      ;;
    0x*)
      ADDR="$1"
      shift
      ;;
    *)
      echo "Unknown arg: $1" >&2
      usage
      ;;
  esac
done

if [[ "$FORCE" -ne 1 ]]; then
  echo "Refusing to run without --force." >&2
  usage
fi
if [[ -z "$ADDR" ]]; then
  echo "Missing <address>." >&2
  usage
fi

LOWER="$(echo "$ADDR" | tr '[:upper:]' '[:lower:]')"
DIR="${HOME}/.eto/wallets"

# Idempotent removal: rm -f never errors on missing files.
for name in "${LOWER}.enc" "${LOWER}.active" "${ADDR}.enc" "${ADDR}.active"; do
  path="${DIR}/${name}"
  if [[ -e "$path" ]]; then
    rm -f -- "$path"
    echo "removed ${path}"
  else
    echo "skip   ${path} (not present)"
  fi
done
