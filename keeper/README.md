# ETO Agent Keeper — Agentic Finance Runtime

AI agents that autonomously trade, stake, and manage treasuries on ETO.

## Architecture

```
┌──────────────────────────────────────────────┐
│           KEEPER RUNTIME (Node/Bun)          │
│                                              │
│  ┌────────┐  ┌────────┐  ┌────────┐         │
│  │Agent 1 │  │Agent 2 │  │Agent N │         │
│  │Arb Bot │  │Staker  │  │Treasury│         │
│  └───┬────┘  └───┬────┘  └───┬────┘         │
│      │           │           │               │
│      └───────────┴───────────┘               │
│                  │                           │
│         Claude Agent SDK                     │
│         (reasoning engine)                   │
│                  │                           │
│         ETO MCP Client                       │
│         (chain interaction)                  │
└──────────┬───────────────────────────────────┘
           │
    ┌──────▼──────┐
    │  ETO Chain  │
    │  (testnet)  │
    └─────────────┘
```

## How It Works

1. Each agent has a **strategy prompt** (natural language)
2. The keeper polls the chain every N seconds via MCP
3. Claude evaluates the chain state against the strategy
4. If action needed → Claude calls MCP tools to execute
5. Results logged on-chain + locally

## Usage

```bash
# Start the keeper with a config
bun run keeper/start.ts --config keeper/agents.json

# Or run a single agent
bun run keeper/start.ts --agent "arb-bot" --strategy "Arbitrage ETO/EUSD when price deviates >3%"
```
