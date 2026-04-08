#!/usr/bin/env bun
/**
 * ETO Agent Keeper — Autonomous AI agents on-chain
 *
 * Each agent is a Claude Agent SDK loop that:
 * 1. Reads chain state via ETO MCP
 * 2. Reasons about strategy via Claude
 * 3. Executes transactions when conditions are met
 * 4. Logs everything for audit
 *
 * Usage:
 *   bun run keeper/start.ts --config keeper/agents.json
 *   bun run keeper/start.ts --agent arb-bot --strategy "Arb ETO when price deviates >3%"
 */

import Anthropic from "@anthropic-ai/sdk";
import { readFileSync, appendFileSync, mkdirSync } from "fs";

// ─── Config ───
const RPC_URL = process.env.ETO_RPC_URL || "http://localhost:8899";
const MODEL = process.env.KEEPER_MODEL || "claude-sonnet-4-6";
const POLL_INTERVAL = parseInt(process.env.KEEPER_POLL_MS || "5000");
const LOG_DIR = "/tmp/eto-keeper-logs";
mkdirSync(LOG_DIR, { recursive: true });

// ─── Types ───
interface AgentConfig {
  id: string;
  name: string;
  strategy: string;
  walletAddress: string;
  walletPrivateKey?: string;
  triggers: TriggerConfig[];
  maxSpendPerAction: string;
  enabled: boolean;
}

interface TriggerConfig {
  type: "poll_balance" | "poll_block" | "poll_price" | "interval";
  params: Record<string, any>;
}

interface ChainState {
  blockHeight: number;
  balance: number;
  recentTxs: any[];
  timestamp: number;
}

// ─── RPC Client (lightweight, no MCP dependency) ───
async function rpc(method: string, params: any[] = []): Promise<any> {
  const res = await fetch(RPC_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  const json = await res.json() as any;
  if (json.error) throw new Error(`RPC ${method}: ${json.error.message}`);
  return json.result;
}

// ─── Chain State Reader ───
async function getChainState(walletAddress: string): Promise<ChainState> {
  const [height, balance] = await Promise.all([
    rpc("getBlockHeight"),
    rpc("getBalance", [walletAddress]).then((r: any) => r?.value ?? r ?? 0),
  ]);
  return {
    blockHeight: height,
    balance: typeof balance === "object" ? balance.value || 0 : balance,
    recentTxs: [],
    timestamp: Date.now(),
  };
}

// ─── Transaction Executor ───
async function executeAction(action: string, params: any): Promise<string> {
  // Map high-level actions to RPC calls
  switch (action) {
    case "transfer": {
      // Build and submit a transfer (simplified — uses faucet for demo)
      const result = await rpc("faucet", [params.to, params.amount]);
      return `Transfer: ${JSON.stringify(result)}`;
    }
    case "log": {
      return `Log: ${params.message}`;
    }
    default:
      return `Unknown action: ${action}`;
  }
}

// ─── Logger ───
function logAgent(agentId: string, level: string, msg: string, data?: any) {
  const line = `${new Date().toISOString()} [${level}] [${agentId}] ${msg}${data ? " " + JSON.stringify(data) : ""}\n`;
  appendFileSync(`${LOG_DIR}/${agentId}.log`, line);
  if (level !== "debug") process.stderr.write(line);
}

// ─── Agent Loop (Claude Agent SDK pattern) ───
async function runAgentLoop(agent: AgentConfig, client: Anthropic) {
  logAgent(agent.id, "info", `Starting agent: ${agent.name}`);
  logAgent(agent.id, "info", `Strategy: ${agent.strategy}`);
  logAgent(agent.id, "info", `Wallet: ${agent.walletAddress}`);

  let iteration = 0;
  const systemPrompt = `You are an autonomous on-chain agent named "${agent.name}" running on the ETO blockchain.

Your strategy: ${agent.strategy}

You have access to the current chain state and can decide what actions to take.
Your wallet address is ${agent.walletAddress} with a max spend of ${agent.maxSpendPerAction} ETO per action.

On each tick, you receive the current chain state. Respond with a JSON object:
{
  "reasoning": "brief explanation of your analysis",
  "action": "none" | "transfer" | "log" | "alert",
  "params": { ... action-specific params ... },
  "next_check_in": "normal" | "soon" | "urgent"
}

Rules:
- Be conservative. Only act when your strategy conditions are clearly met.
- Always explain your reasoning.
- "none" means no action needed this tick.
- "alert" logs a warning for human review.
- Never spend more than ${agent.maxSpendPerAction} ETO in a single action.`;

  while (agent.enabled) {
    iteration++;
    try {
      // 1. Read chain state
      const state = await getChainState(agent.walletAddress);
      logAgent(agent.id, "debug", `Tick ${iteration}`, { height: state.blockHeight, balance: state.balance });

      // 2. Ask Claude what to do
      const response = await client.messages.create({
        model: MODEL,
        max_tokens: 500,
        system: systemPrompt,
        messages: [{
          role: "user",
          content: `Tick #${iteration} — Chain State:
- Block Height: ${state.blockHeight}
- Your Balance: ${state.balance} lamports (${(state.balance / 1e9).toFixed(4)} ETO)
- Timestamp: ${new Date(state.timestamp).toISOString()}

What action do you take?`,
        }],
      });

      // 3. Parse response
      const text = response.content[0].type === "text" ? response.content[0].text : "";
      let decision: any;
      try {
        // Extract JSON from response
        const jsonMatch = text.match(/\{[\s\S]*\}/);
        decision = jsonMatch ? JSON.parse(jsonMatch[0]) : { action: "none", reasoning: text };
      } catch {
        decision = { action: "none", reasoning: text };
      }

      logAgent(agent.id, "info", `Decision: ${decision.action}`, {
        reasoning: decision.reasoning?.slice(0, 100),
        iteration,
      });

      // 4. Execute action
      if (decision.action && decision.action !== "none") {
        const result = await executeAction(decision.action, decision.params || {});
        logAgent(agent.id, "info", `Executed: ${result}`);
      }

      // 5. Adaptive polling
      const delay = decision.next_check_in === "urgent" ? POLL_INTERVAL / 5
        : decision.next_check_in === "soon" ? POLL_INTERVAL / 2
        : POLL_INTERVAL;

      await new Promise(r => setTimeout(r, delay));

    } catch (err: any) {
      logAgent(agent.id, "error", `Error: ${err.message}`);
      await new Promise(r => setTimeout(r, POLL_INTERVAL * 2)); // Back off on error
    }
  }

  logAgent(agent.id, "info", "Agent stopped");
}

// ─── Main ───
async function main() {
  const args = process.argv.slice(2);
  const apiKey = process.env.ANTHROPIC_API_KEY;

  if (!apiKey) {
    console.error("Error: ANTHROPIC_API_KEY required");
    console.error("Usage: ANTHROPIC_API_KEY=sk-... bun run keeper/start.ts --config keeper/agents.json");
    process.exit(1);
  }

  const client = new Anthropic({ apiKey });

  let agents: AgentConfig[] = [];

  // Parse args
  const configIdx = args.indexOf("--config");
  const agentIdx = args.indexOf("--agent");
  const stratIdx = args.indexOf("--strategy");
  const walletIdx = args.indexOf("--wallet");

  if (configIdx >= 0) {
    // Load from config file
    const configFile = args[configIdx + 1];
    agents = JSON.parse(readFileSync(configFile, "utf8"));
  } else if (agentIdx >= 0) {
    // Single agent from CLI args
    agents = [{
      id: args[agentIdx + 1] || "cli-agent",
      name: args[agentIdx + 1] || "CLI Agent",
      strategy: stratIdx >= 0 ? args[stratIdx + 1] : "Monitor the chain and report interesting activity",
      walletAddress: walletIdx >= 0 ? args[walletIdx + 1] : "6ZrQwARijYWKZZAXe88D97mQqSqqiuBd2n59KmQRvik6",
      triggers: [{ type: "interval", params: { ms: POLL_INTERVAL } }],
      maxSpendPerAction: "0.1",
      enabled: true,
    }];
  } else {
    console.error("Usage:");
    console.error("  bun run keeper/start.ts --config keeper/agents.json");
    console.error("  bun run keeper/start.ts --agent arb-bot --strategy 'Arb when price >3%' --wallet <address>");
    process.exit(1);
  }

  console.error(`\n═══════════════════════════════════════`);
  console.error(`  ETO Agent Keeper — ${agents.length} agent(s)`);
  console.error(`  RPC: ${RPC_URL}`);
  console.error(`  Model: ${MODEL}`);
  console.error(`  Poll: ${POLL_INTERVAL}ms`);
  console.error(`  Logs: ${LOG_DIR}/`);
  console.error(`═══════════════════════════════════════\n`);

  // Verify RPC connection
  try {
    const health = await rpc("getHealth");
    console.error(`  Chain: ${health}`);
  } catch (e: any) {
    console.error(`  Chain: UNREACHABLE (${e.message})`);
    process.exit(1);
  }

  // Start all agents in parallel
  const promises = agents.map(agent => runAgentLoop(agent, client));

  // Handle shutdown
  process.on("SIGINT", () => {
    console.error("\nShutting down agents...");
    agents.forEach(a => a.enabled = false);
    setTimeout(() => process.exit(0), 2000);
  });

  await Promise.all(promises);
}

main().catch(err => {
  console.error("Fatal:", err);
  process.exit(1);
});
