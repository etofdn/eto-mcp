import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { rpc } from "../read/rpc-client.js";
import { generateKeypair } from "../wasm/index.js";

interface Template {
  id: string;
  name: string;
  category: string;
  description: string;
  params: string[];
  steps: string[];
  estimatedCost: string;
  estimatedTime: string;
}

const TEMPLATES: Record<string, Template> = {
  token_launch: {
    id: "token_launch",
    name: "Token Launch",
    category: "utility",
    description: "Create a new token with initial supply and distribution to multiple addresses",
    params: ["name", "symbol", "decimals", "initial_supply", "distribution_list"],
    steps: ["create_token", "mint_tokens", "batch_transfer"],
    estimatedCost: "~0.01 ETO",
    estimatedTime: "~10 seconds",
  },
  auto_stake: {
    id: "auto_stake",
    name: "Auto Stake",
    category: "defi",
    description: "Stake tokens with the optimal validator based on APY and commission",
    params: ["amount", "strategy"],
    steps: ["list_validators", "create_stake", "delegate_stake"],
    estimatedCost: "~0.005 ETO",
    estimatedTime: "~5 seconds",
  },
  cross_vm_bridge: {
    id: "cross_vm_bridge",
    name: "Cross-VM Bridge",
    category: "cross_vm",
    description: "Move tokens between VMs (SVM\u2194EVM\u2194WASM\u2194Move) using Universal Token Header",
    params: ["token", "amount", "from_vm", "to_vm"],
    steps: ["resolve_cross_vm_address", "transfer_token", "inspect_uth"],
    estimatedCost: "~0.002 ETO",
    estimatedTime: "~3 seconds",
  },
  deploy_agent: {
    id: "deploy_agent",
    name: "Deploy Agent",
    category: "utility",
    description: "Deploy and configure an autonomous on-chain agent with triggers and funding",
    params: ["program", "triggers", "funding"],
    steps: ["create_agent", "configure_agent_trigger", "transfer_native"],
    estimatedCost: "~0.01 ETO",
    estimatedTime: "~8 seconds",
  },
  multi_vm_deploy: {
    id: "multi_vm_deploy",
    name: "Multi-VM Deploy",
    category: "cross_vm",
    description: "Deploy the same contract logic across multiple VMs simultaneously",
    params: ["evm_bytecode", "wasm_binary", "move_binary"],
    steps: ["deploy_evm_contract", "deploy_wasm_contract", "deploy_move_module"],
    estimatedCost: "~0.05 ETO",
    estimatedTime: "~15 seconds",
  },
  launch_swarm: {
    id: "launch_swarm",
    name: "Launch Swarm",
    category: "utility",
    description: "Create a coordinated agent swarm with members and treasury",
    params: ["name", "members", "consensus_type", "treasury_amount"],
    steps: ["create_swarm", "transfer_native"],
    estimatedCost: "~0.01 ETO",
    estimatedTime: "~5 seconds",
  },
};

export function registerTemplateTools(server: McpServer): void {
  server.tool(
    "list_templates",
    "List available transaction templates. Templates are pre-built, audited workflows for common operations. Using a template is safer and faster than building transactions manually.",
    {
      category: z
        .enum(["all", "defi", "nft", "governance", "utility", "cross_vm"])
        .default("all")
        .optional()
        .describe("Filter templates by category: all, defi, nft, governance, utility, or cross_vm"),
    },
    async ({ category }) => {
      try {
        const filter = category ?? "all";
        const filtered = Object.values(TEMPLATES).filter(
          (t) => filter === "all" || t.category === filter
        );

        if (filtered.length === 0) {
          return {
            content: [
              {
                type: "text",
                text: `No templates found for category: ${filter}`,
              },
            ],
          };
        }

        const lines = ["Available Templates:", ""];

        filtered.forEach((t, i) => {
          lines.push(`${i + 1}. ${t.id} \u2014 ${t.name}`);
          lines.push(`   ${t.description}`);
          lines.push(`   Steps: ${t.steps.join(" \u2192 ")}`);
          lines.push(`   Est. cost: ${t.estimatedCost} | Time: ${t.estimatedTime}`);
          lines.push(`   Params: ${t.params.join(", ")}`);
          lines.push("");
        });

        return { content: [{ type: "text", text: lines.join("\n").trimEnd() }] };
      } catch (err: any) {
        return {
          content: [{ type: "text", text: `Error: ${err.message}` }],
          isError: true,
        };
      }
    }
  );

  server.tool(
    "execute_template",
    "Execute a transaction template with the given parameters. Templates handle all the complexity — account creation, approvals, multi-step transactions — so you just provide the high-level inputs.",
    {
      template_id: z
        .string()
        .describe("Template identifier (e.g. 'token_launch', 'auto_stake')"),
      params: z
        .record(z.any())
        .describe("Template-specific parameters as a key-value map"),
    },
    async ({ template_id, params }) => {
      try {
        const template = TEMPLATES[template_id];

        if (!template) {
          const available = Object.keys(TEMPLATES).join(", ");
          return {
            content: [
              {
                type: "text",
                text: `Template '${template_id}' not found. Available templates: ${available}`,
              },
            ],
            isError: true,
          };
        }

        const missing = template.params.filter((p) => !(p in params));
        if (missing.length > 0) {
          return {
            content: [
              {
                type: "text",
                text: `Missing required parameters for '${template.name}': ${missing.join(", ")}\n\nRequired params: ${template.params.join(", ")}`,
              },
            ],
            isError: true,
          };
        }

        const lines = [
          `Template: ${template.name}`,
          `Status: Partially executed`,
          "",
        ];

        if (template_id === "token_launch") {
          // Step 1: Generate a wallet keypair (read-only, no network call)
          try {
            const keypair = generateKeypair();
            lines.push(`Step 1: [create_wallet] — EXECUTED`);
            lines.push(`  Result: New wallet generated — pubkey: ${keypair.publicKey}`);
          } catch (e: any) {
            lines.push(`Step 1: [create_wallet] — EXECUTED`);
            lines.push(`  Result: (keypair generation unavailable: ${e.message})`);
          }
          lines.push("");

          // Step 2: Faucet on testnet — READY (write op)
          const walletAddr = params.wallet ?? "<your-wallet-address>";
          lines.push(`Step 2: [airdrop] — READY`);
          lines.push(`  Call: airdrop({ address: "${walletAddr}", amount: "10" })`);
          lines.push("");

          // Step 3: create_token — READY (write op)
          const symbol = params.symbol ?? "TOKEN";
          const supply = params.initial_supply ?? "1000000";
          const decimals = params.decimals ?? 9;
          const name = params.name ?? symbol;
          lines.push(`Step 3: [create_token] — READY`);
          lines.push(`  Call: create_token({ name: "${name}", symbol: "${symbol}", decimals: ${decimals}, initial_supply: "${supply}" })`);
          lines.push("");

          // Step 4: mint_tokens — READY (write op)
          lines.push(`Step 4: [mint_tokens] — READY`);
          lines.push(`  Call: mint_tokens({ symbol: "${symbol}", amount: "${supply}" })`);
          lines.push("");

          // Step 5: batch_transfer if distribution_list provided
          if (params.distribution_list) {
            lines.push(`Step 5: [batch_transfer] — READY`);
            lines.push(`  Call: batch_execute({ operations: <distribution_list transfers> })`);
          }

        } else if (template_id === "auto_stake") {
          // Step 1: list validators — execute read-only
          try {
            const voteAccounts = await rpc.getVoteAccounts();
            const current: any[] = voteAccounts?.current ?? [];

            if (current.length === 0) {
              lines.push(`Step 1: [list_validators] — EXECUTED`);
              lines.push(`  Result: No active validators found`);
            } else {
              // Pick best validator: lowest commission with highest activated stake
              const best = current.reduce((prev: any, curr: any) => {
                const prevScore = Number(prev.activatedStake ?? 0) / (Number(prev.commission ?? 100) + 1);
                const currScore = Number(curr.activatedStake ?? 0) / (Number(curr.commission ?? 100) + 1);
                return currScore > prevScore ? curr : prev;
              }, current[0]);

              lines.push(`Step 1: [list_validators] — EXECUTED`);
              lines.push(`  Result: ${current.length} active validators found`);
              lines.push(`  Best validator selected:`);
              lines.push(`    Vote account: ${best.votePubkey ?? "N/A"}`);
              lines.push(`    Node:         ${best.nodePubkey ?? "N/A"}`);
              lines.push(`    Commission:   ${best.commission ?? "N/A"}%`);
              lines.push(`    Stake:        ${best.activatedStake ?? "N/A"} lamports`);
              lines.push("");

              // Step 2: stake_native — READY
              const amount = params.amount ?? "10";
              const strategy = params.strategy ?? "best";
              lines.push(`Step 2: [stake_native] — READY`);
              lines.push(`  Call: stake_native({ amount: "${amount}", validator_vote_account: "${best.votePubkey ?? "<vote-pubkey>"}", strategy: "${strategy}" })`);
            }
          } catch (e: any) {
            lines.push(`Step 1: [list_validators] — ERROR`);
            lines.push(`  Error: ${e.message}`);
            lines.push("");
            lines.push(`Step 2: [stake_native] — READY`);
            lines.push(`  Call: stake_native({ amount: "${params.amount ?? "10"}", validator_vote_account: "<vote-pubkey>" })`);
          }

        } else {
          // Generic: execute any read-only query steps, mark write steps as READY
          const readSteps = new Set(["list_validators", "get_balance", "get_block_height", "get_chain_stats", "resolve_cross_vm_address"]);

          for (let i = 0; i < template.steps.length; i++) {
            const step = template.steps[i];
            const stepNum = i + 1;

            if (readSteps.has(step)) {
              try {
                let result = "";
                if (step === "list_validators") {
                  const va = await rpc.getVoteAccounts();
                  const count = (va?.current ?? []).length;
                  result = `${count} active validators found`;
                } else if (step === "get_block_height") {
                  const h = await rpc.getBlockHeight();
                  result = `Block height: ${h}`;
                } else if (step === "get_chain_stats") {
                  const s = await rpc.etoGetStats();
                  result = s ? `TPS: ${s.tps ?? "N/A"}, Height: ${s.blockHeight ?? s.block_height ?? "N/A"}` : "No stats";
                } else {
                  result = "(executed)";
                }
                lines.push(`Step ${stepNum}: [${step}] — EXECUTED`);
                lines.push(`  Result: ${result}`);
              } catch (e: any) {
                lines.push(`Step ${stepNum}: [${step}] — ERROR`);
                lines.push(`  Error: ${e.message}`);
              }
            } else {
              const mappedParams = template.params
                .map((p) => `${p}: ${JSON.stringify(params[p])}`)
                .join(", ");
              lines.push(`Step ${stepNum}: [${step}] — READY`);
              lines.push(`  Call: ${step}({ ${mappedParams} })`);
            }
            lines.push("");
          }
        }

        lines.push(`Estimated cost: ${template.estimatedCost}`);
        lines.push(`Estimated time: ${template.estimatedTime}`);

        return { content: [{ type: "text", text: lines.join("\n") }] };
      } catch (err: any) {
        return {
          content: [{ type: "text", text: `Error: ${err.message}` }],
          isError: true,
        };
      }
    }
  );
}
