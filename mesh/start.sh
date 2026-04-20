#!/bin/bash
# ETO Mesh — One command to rule them all
# Starts: ETO testnet (3 nodes) + Sepolia connection + Mesh validator + MCP server
set -euo pipefail

ETO_BIN="${ETO_BIN:-/home/naman/eto/src/runtime/target/release/svm-vm}"
GENESIS="${ETO_GENESIS:-/home/naman/eto/genesis.json}"
CONFIG_DIR="${ETO_CONFIG:-/home/naman/eto/testnet-local}"
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

# Clean data
rm -rf "$DATA_DIR" "$MESH_DIR"
mkdir -p "$DATA_DIR"/{seq,val1,val2} "$MESH_DIR"

# ─── ETO Testnet (3 nodes) ───
echo -e "${GREEN}[1/4] Starting ETO testnet (1 sequencer + 2 validators)${NC}"

TURBO_BASE_PORT=18000 ETO_METRICS_PORT=9091 ETO_RPC_PORT=8897 SVM_PRELOAD_COUNT=0 \
  "$ETO_BIN" --config "$CONFIG_DIR/val1.toml" --genesis "$GENESIS" --data-dir "$DATA_DIR/val1" \
  > "$DATA_DIR/val1.log" 2>&1 &

TURBO_BASE_PORT=18100 ETO_METRICS_PORT=9092 ETO_RPC_PORT=8898 SVM_PRELOAD_COUNT=0 \
  "$ETO_BIN" --config "$CONFIG_DIR/val2.toml" --genesis "$GENESIS" --data-dir "$DATA_DIR/val2" \
  > "$DATA_DIR/val2.log" 2>&1 &

sleep 3

SVM_PRELOAD_COUNT=0 ETO_METRICS_PORT=9090 ETO_RPC_PORT=8899 \
  "$ETO_BIN" --config "$CONFIG_DIR/seq.toml" --genesis "$GENESIS" --data-dir "$DATA_DIR/seq" \
  > "$DATA_DIR/seq.log" 2>&1 &

# Wait for ETO RPC
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
