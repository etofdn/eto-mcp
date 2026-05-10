#!/bin/bash
# ETO Mesh — One command to rule them all
# Starts: ETO testnet (3 nodes) + Sepolia connection + Mesh validator + MCP server
set -euo pipefail

ETO_BIN="${ETO_BIN:-/home/naman/eto/src/runtime/target/release/svm-vm}"
GENESIS="${ETO_GENESIS:-/home/naman/eto/genesis.json}"
# CONFIG_DIR points to the in-tree local configs; override via ETO_CONFIG env var.
# eto-testnet.sh auto-discovers the local/ subdirectory when ETO_CONFIG is set.
CONFIG_DIR="${ETO_CONFIG:-$(cd "$(dirname "$0")/../.." && pwd)/src/testnet/local}"
DATA_DIR="/tmp/eto-testnet"
MESH_DIR="/tmp/eto-mesh-logs"
SEPOLIA_RPC="${SEPOLIA_RPC:-https://ethereum-sepolia-rpc.publicnode.com}"
MCP_DIR="$(cd "$(dirname "$0")/.." && pwd)"

RED='\033[0;31m'
GREEN='\033[0;32m'
CYAN='\033[0;36m'
YELLOW='\033[1;33m'
NC='\033[0m'

cleanup() {
    echo ""
    echo -e "${YELLOW}Shutting down mesh...${NC}"
    # shellcheck disable=SC2046  # jobs -p produces a whitespace-delimited PID list; word-splitting is intentional
    kill $(jobs -p) 2>/dev/null
    sleep 1
    killall -9 svm-vm 2>/dev/null
    echo -e "${GREEN}Mesh stopped${NC}"
}
trap cleanup EXIT

echo -e "${CYAN}"
echo "═══════════════════════════════════════════════════════════"
echo "  ETO MESH — Cross-Chain State Consensus Layer"
echo "═══════════════════════════════════════════════════════════"
echo -e "${NC}"

# Kill existing
killall -9 svm-vm 2>/dev/null || true
sleep 1

# Clean data (launcher will recreate per-node subdirs; create parent and logs dir now)
rm -rf "$DATA_DIR" "$MESH_DIR"
mkdir -p "$DATA_DIR" "$MESH_DIR"

# ─── ETO Testnet (3 nodes) ───
# Delegated to the canonical launcher (src/scripts/eto-testnet.sh local start).
# Signal propagation: the launcher runs inside a subshell backgrounded here;
# the cleanup trap's `kill $(jobs -p)` sends SIGTERM to the launcher process,
# which has its own EXIT trap that forwards the signal to the three svm-vm
# children and waits for them.  The `killall -9 svm-vm` fallback below covers
# any processes that survive the graceful shutdown.
echo -e "${GREEN}[1/4] Starting ETO testnet (1 sequencer + 2 validators)${NC}"
ETO_BIN="$ETO_BIN" ETO_GENESIS="$GENESIS" ETO_CONFIG="$CONFIG_DIR" ETO_DATA_DIR="$DATA_DIR" \
  bash "$(dirname "$0")/../../src/scripts/eto-testnet.sh" local start &

# Wait for ETO RPC
# shellcheck disable=SC2034  # loop counter used only for iteration count
for i in $(seq 1 15); do
  if curl -s -X POST http://localhost:8899 -H "Content-Type: application/json" \
    -d '{"jsonrpc":"2.0","id":1,"method":"getHealth"}' 2>/dev/null | grep -q "ok"; then
    echo -e "  ETO RPC:      ${GREEN}http://localhost:8899${NC}"
    break
  fi
  sleep 1
done

# ─── Verify Sepolia ───
echo -e "${GREEN}[2/4] Connecting to Sepolia${NC}"
SEPOLIA_BLOCK=$(curl -s -X POST "$SEPOLIA_RPC" -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":1,"method":"eth_blockNumber","params":[]}' 2>/dev/null \
  | python3 -c "import sys,json; print(int(json.load(sys.stdin)['result'],16))" 2>/dev/null || echo "0")

if [ "$SEPOLIA_BLOCK" = "0" ]; then
  echo -e "  Sepolia:      ${RED}UNREACHABLE${NC}"
  echo "  Trying fallback RPCs..."
  for rpc in "https://sepolia.drpc.org" "https://1rpc.io/sepolia"; do
    SEPOLIA_BLOCK=$(curl -s --max-time 5 -X POST "$rpc" -H "Content-Type: application/json" \
      -d '{"jsonrpc":"2.0","id":1,"method":"eth_blockNumber","params":[]}' 2>/dev/null \
      | python3 -c "import sys,json; print(int(json.load(sys.stdin)['result'],16))" 2>/dev/null || echo "0")
    if [ "$SEPOLIA_BLOCK" != "0" ]; then
      SEPOLIA_RPC="$rpc"
      break
    fi
  done
fi
echo -e "  Sepolia RPC:  ${GREEN}${SEPOLIA_RPC}${NC}"
echo -e "  Sepolia Block: ${CYAN}${SEPOLIA_BLOCK}${NC}"

# ─── Mesh Validator ───
echo -e "${GREEN}[3/4] Starting mesh validator${NC}"
cd "$MCP_DIR"
ETH_RPC_URL="$SEPOLIA_RPC" bun run mesh/validator.ts > "$MESH_DIR/validator.out" 2>&1 &

sleep 4
if curl -s http://localhost:9200/health 2>/dev/null | grep -q "ok"; then
  VALIDATOR=$(curl -s http://localhost:9200/health | python3 -c "import sys,json; print(json.load(sys.stdin)['validator'])" 2>/dev/null)
  echo -e "  Mesh API:     ${GREEN}http://localhost:9200${NC}"
  echo -e "  Validator:    ${CYAN}${VALIDATOR}${NC}"
else
  echo -e "  Mesh API:     ${RED}FAILED${NC}"
fi

# ─── MCP Server ───
echo -e "${GREEN}[4/4] Starting MCP server (112 tools)${NC}"
ETO_RPC_URL=http://localhost:8899 NETWORK=testnet AUTH_DEV_BYPASS=true \
  bun run src/index.ts > "$MESH_DIR/mcp.out" 2>&1 &

sleep 2
echo -e "  MCP:          ${GREEN}stdio (112 tools)${NC}"

# ─── Summary ───
echo ""
echo -e "${CYAN}═══════════════════════════════════════════════════════════${NC}"
echo -e "  ${GREEN}ETO Mesh is live!${NC}"
echo ""
echo "  ETO Testnet:   http://localhost:8899 (3-node, 1-hop finality)"
echo "  Sepolia:       $SEPOLIA_RPC (block $SEPOLIA_BLOCK)"
echo "  Mesh Validator: http://localhost:9200 (cross-chain attestations)"
echo "  MCP Server:    112 tools (stdio)"
echo ""
echo "  Logs:"
echo "    ETO:    $DATA_DIR/seq.log"
echo "    Mesh:   $MESH_DIR/validator.out"
echo "    Attest: $MESH_DIR/attestations.jsonl"
echo ""
echo -e "  ${YELLOW}Press Ctrl+C to stop${NC}"
echo -e "${CYAN}═══════════════════════════════════════════════════════════${NC}"
echo ""

# Keep alive — tail mesh validator output
tail -f "$MESH_DIR/validator.out" 2>/dev/null || wait
