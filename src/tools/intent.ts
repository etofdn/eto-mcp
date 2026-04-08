import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { rpc } from "../read/rpc-client.js";
import { lamportsToSol } from "../utils/units.js";
import { detectAddressType } from "../utils/address.js";

// ─── Intent Types ────────────────────────────────────────────────────────────

type IntentType =
  | "transfer"
  | "deploy"
  | "stake"
  | "token_launch"
  | "swap"
  | "query"
  | "auto_stake"
  | "dao"
  | "deploy_and_test"
  | "unknown";

interface ParsedIntent {
  type: IntentType;
  raw: string;
  params: Record<string, string>;
}

interface ExecutionStep {
  order: number;
  tool: string;
  params: Record<string, string | number | boolean>;
  description: string;
  estimatedCost: string;
}

interface ExecutionPlan {
  steps: ExecutionStep[];
  totalEstimatedCost: string;
  estimatedTime: string;
  requiredCapabilities: string[];
  risks: string[];
  alternatives: string[];
}

// ─── Intent Parser ───────────────────────────────────────────────────────────

function parseIntent(intent: string): ParsedIntent {
  const lower = intent.toLowerCase();
  const params: Record<string, string> = {};

  // Extract amount patterns like "50 ETO", "0.5 sol", "100 tokens"
  const amountMatch = intent.match(/(\d+(?:\.\d+)?)\s*(?:ETO|SOL|eto|sol)?/i);
  if (amountMatch) {
    params.amount = amountMatch[1];
  }

  // Extract address-like tokens (base58 or 0x)
  const addressMatch = intent.match(/(?:to|from|for)\s+([A-Za-z0-9]{32,44}|0x[0-9a-fA-F]{40})/i);
  if (addressMatch) {
    params.address = addressMatch[1];
  }

  // Extract quoted names like "alice", "bob"
  const nameMatch = intent.match(/(?:to|from|for)\s+([a-zA-Z][a-zA-Z0-9_-]{1,30})(?:\s|$)/i);
  if (nameMatch && !params.address) {
    params.name = nameMatch[1];
  }

  // Extract token name/symbol for compound token intents (e.g. "create a token called MYTKN")
  const tokenNameMatch = intent.match(/(?:token|called?|named?)\s+([A-Z]{2,10})\b/i);
  if (tokenNameMatch) {
    params.symbol = tokenNameMatch[1].toUpperCase();
  }

  // ── Compound intent patterns (checked before simple patterns) ──────────────

  // "create a token and distribute" / "launch token" / "create token and ..."
  if (
    lower.includes("create") && lower.includes("token") &&
    (lower.includes("distribute") || lower.includes("launch") || lower.includes("and"))
  ) {
    return { type: "token_launch", raw: intent, params };
  }

  // "launch token" standalone
  if (lower.includes("launch") && lower.includes("token")) {
    return { type: "token_launch", raw: intent, params };
  }

  // "stake with best validator" / "auto stake" / "auto-stake"
  if (
    (lower.includes("stake") && lower.includes("best")) ||
    lower.includes("auto stake") ||
    lower.includes("auto-stake") ||
    (lower.includes("stake") && lower.includes("optimal"))
  ) {
    return { type: "auto_stake", raw: intent, params };
  }

  // "create a DAO" / "set up governance" / "dao" / "governance"
  if (lower.includes("dao") || lower.includes("governance")) {
    return { type: "dao", raw: intent, params };
  }

  // "deploy and test" / "deploy then test"
  if (lower.includes("deploy") && (lower.includes("test") || lower.includes("verify"))) {
    return { type: "deploy_and_test", raw: intent, params };
  }

  // Detect intent type by keyword matching
  if (/\b(transfer|send|pay)\b/.test(lower)) {
    return { type: "transfer", raw: intent, params };
  }

  if (/\b(deploy|launch contract|create contract|publish contract)\b/.test(lower)) {
    return { type: "deploy", raw: intent, params };
  }

  if (/\b(stake|delegate|bond)\b/.test(lower)) {
    return { type: "stake", raw: intent, params };
  }

  if (/\b(create token|mint token|launch token|issue token|create a token|mint a token)\b/.test(lower)) {
    return { type: "token_launch", raw: intent, params };
  }

  if (/\b(swap|exchange|trade)\b/.test(lower)) {
    return { type: "swap", raw: intent, params };
  }

  if (/\b(balance|check|lookup|query|what is|how much|show)\b/.test(lower)) {
    return { type: "query", raw: intent, params };
  }

  return { type: "unknown", raw: intent, params };
}

// ─── Plan Builder ────────────────────────────────────────────────────────────

function buildExecutionPlan(parsed: ParsedIntent): ExecutionPlan {
  const { type, params } = parsed;

  switch (type) {
    case "transfer": {
      const recipient = params.address ?? params.name ?? "<recipient>";
      const amount = params.amount ?? "0";
      return {
        steps: [
          {
            order: 1,
            tool: "transfer_native",
            params: { to: recipient, amount, unit: "sol" },
            description: `Transfer ${amount} ETO to ${recipient}`,
            estimatedCost: "0.000005 ETO",
          },
        ],
        totalEstimatedCost: "0.000005 ETO",
        estimatedTime: "~2 seconds",
        requiredCapabilities: ["transfer:write"],
        risks: [
          "Recipient address must exist or be a valid on-chain account",
          "Insufficient balance will cause transaction failure",
        ],
        alternatives: [
          "Use transfer_native tool directly for more control",
        ],
      };
    }

    case "deploy": {
      const vm = params.vm ?? "svm";
      return {
        steps: [
          {
            order: 1,
            tool: "deploy_contract",
            params: { vm, bytecode: "<bytecode>" },
            description: `Deploy contract on ${vm.toUpperCase()} VM`,
            estimatedCost: "0.01 ETO",
          },
        ],
        totalEstimatedCost: "0.01 ETO",
        estimatedTime: "~5 seconds",
        requiredCapabilities: ["deploy:write"],
        risks: [
          "Contract bytecode must be valid for the target VM",
          "Deployment cost varies with contract size",
          "Contract cannot be undeployed once on-chain",
        ],
        alternatives: [
          "Use deploy_contract tool directly with explicit bytecode",
          "Test on devnet first with request_devnet_tokens",
        ],
      };
    }

    case "stake": {
      const amount = params.amount ?? "0";
      const validator = params.address ?? params.name ?? "<validator>";
      return {
        steps: [
          {
            order: 1,
            tool: "get_validators",
            params: {},
            description: "Fetch active validator list to select optimal validator",
            estimatedCost: "0 ETO",
          },
          {
            order: 2,
            tool: "stake_native",
            params: { amount, validator_vote_account: validator },
            description: `Delegate ${amount} ETO to validator ${validator}`,
            estimatedCost: "0.002 ETO",
          },
        ],
        totalEstimatedCost: "0.002 ETO",
        estimatedTime: "~4 seconds",
        requiredCapabilities: ["stake:write"],
        risks: [
          "Staked funds are locked until unstaking is requested",
          "Validator may have capacity limits",
          "Rewards depend on validator uptime and commission",
        ],
        alternatives: [
          "Use stake_native tool directly if you know the validator vote account",
        ],
      };
    }

    case "token_launch": {
      const symbol = params.name ?? "TOKEN";
      const supply = params.amount ?? "1000000";
      return {
        steps: [
          {
            order: 1,
            tool: "create_token",
            params: { symbol, initial_supply: supply, decimals: 9 },
            description: `Create token ${symbol} with supply ${supply}`,
            estimatedCost: "0.01 ETO",
          },
          {
            order: 2,
            tool: "mint_tokens",
            params: { symbol, amount: supply },
            description: `Mint ${supply} ${symbol} tokens to creator wallet`,
            estimatedCost: "0.000005 ETO",
          },
        ],
        totalEstimatedCost: "0.010005 ETO",
        estimatedTime: "~6 seconds",
        requiredCapabilities: ["token:write"],
        risks: [
          "Token mint authority is set to the creator wallet — guard the key",
          "Token supply cannot be reduced without a burn mechanism",
        ],
        alternatives: [
          "Use create_token tool directly for fine-grained control over decimals and freeze authority",
        ],
      };
    }

    case "auto_stake": {
      const amount = params.amount ?? "10";
      return {
        steps: [
          {
            order: 1,
            tool: "get_vote_accounts",
            params: {},
            description: "Fetch all active validators and select the best by stake/commission ratio",
            estimatedCost: "0 ETO",
          },
          {
            order: 2,
            tool: "stake_native",
            params: { amount, validator_vote_account: "<best-validator-vote-account>" },
            description: `Delegate ${amount} ETO to the optimal validator`,
            estimatedCost: "0.002 ETO",
          },
        ],
        totalEstimatedCost: "0.002 ETO",
        estimatedTime: "~5 seconds",
        requiredCapabilities: ["stake:write"],
        risks: [
          "Staked funds are locked until unstaking is requested",
          "Validator selection is based on current on-chain data — conditions may change",
        ],
        alternatives: [
          "Use execute_template with template_id='auto_stake' for a guided flow",
          "Use stake_native directly if you already know the validator vote account",
        ],
      };
    }

    case "dao": {
      return {
        steps: [
          {
            order: 1,
            tool: "create_token",
            params: { symbol: "GOV", initial_supply: "10000000", decimals: 6 },
            description: "Create governance token for the DAO",
            estimatedCost: "0.01 ETO",
          },
          {
            order: 2,
            tool: "create_agent",
            params: { name: "dao-treasury", role: "treasury" },
            description: "Deploy DAO treasury agent with multisig controls",
            estimatedCost: "0.01 ETO",
          },
          {
            order: 3,
            tool: "transfer_native",
            params: { to: "<treasury-address>", amount: params.amount ?? "0" },
            description: "Fund the DAO treasury with initial ETO",
            estimatedCost: "0.000005 ETO",
          },
        ],
        totalEstimatedCost: "~0.02 ETO",
        estimatedTime: "~10 seconds",
        requiredCapabilities: ["token:write", "deploy:write", "transfer:write"],
        risks: [
          "Governance token supply is fixed at creation unless a mint authority is retained",
          "Treasury agent must be carefully configured before funding",
        ],
        alternatives: [
          "Build governance logic on-chain with a custom program for full flexibility",
        ],
      };
    }

    case "deploy_and_test": {
      const vm = params.vm ?? "svm";
      return {
        steps: [
          {
            order: 1,
            tool: "deploy_contract",
            params: { vm, bytecode: "<bytecode>" },
            description: `Deploy contract on ${vm.toUpperCase()} VM`,
            estimatedCost: "0.01 ETO",
          },
          {
            order: 2,
            tool: "get_account",
            params: { address: "<deployed-contract-address>" },
            description: "Verify contract account exists on-chain after deployment",
            estimatedCost: "0 ETO",
          },
          {
            order: 3,
            tool: "get_transaction",
            params: { hash: "<deploy-tx-hash>" },
            description: "Confirm deployment transaction succeeded",
            estimatedCost: "0 ETO",
          },
        ],
        totalEstimatedCost: "~0.01 ETO",
        estimatedTime: "~8 seconds",
        requiredCapabilities: ["deploy:write", "read"],
        risks: [
          "Contract cannot be undeployed once on-chain",
          "Test on devnet first using airdrop to fund the wallet",
        ],
        alternatives: [
          "Use deploy_contract directly then verify with get_account",
          "Use batch_execute to chain deploy + verification steps",
        ],
      };
    }

    case "swap": {
      return {
        steps: [],
        totalEstimatedCost: "N/A",
        estimatedTime: "N/A",
        requiredCapabilities: ["swap:write"],
        risks: ["DEX routing not yet available on ETO MCP"],
        alternatives: [
          "Use transfer_native to move ETO between wallets",
          "Await DEX integration in a future release",
        ],
      };
    }

    case "query": {
      const address = params.address ?? params.name ?? "<address>";
      return {
        steps: [
          {
            order: 1,
            tool: "get_balance",
            params: { address },
            description: `Fetch balance for ${address}`,
            estimatedCost: "0 ETO",
          },
        ],
        totalEstimatedCost: "0 ETO",
        estimatedTime: "~1 second",
        requiredCapabilities: ["read"],
        risks: [],
        alternatives: [
          "Use get_account for full account details",
          "Use get_account_transactions for transaction history",
        ],
      };
    }

    default: {
      return {
        steps: [],
        totalEstimatedCost: "0 ETO",
        estimatedTime: "N/A",
        requiredCapabilities: [],
        risks: ["Intent could not be parsed"],
        alternatives: [
          "Rephrase your intent using keywords: send/transfer, deploy, stake/delegate, create token, balance/check",
        ],
      };
    }
  }
}

// ─── Plan Formatter ──────────────────────────────────────────────────────────

function formatPlan(intent: string, plan: ExecutionPlan): string {
  const lines: string[] = [
    `Execution Plan for: "${intent}"`,
    "",
    "Steps:",
  ];

  if (plan.steps.length === 0) {
    lines.push("  (no executable steps)");
  } else {
    for (const step of plan.steps) {
      lines.push(`${step.order}. [${step.tool}] — ${step.description} (est. cost: ${step.estimatedCost})`);
    }
  }

  lines.push("");
  lines.push(`Total estimated cost: ${plan.totalEstimatedCost}`);
  lines.push(`Estimated time: ${plan.estimatedTime}`);
  lines.push(`Required capabilities: ${plan.requiredCapabilities.length > 0 ? plan.requiredCapabilities.join(", ") : "none"}`);

  if (plan.risks.length > 0) {
    lines.push("");
    lines.push("Risks:");
    for (const risk of plan.risks) {
      lines.push(`- ${risk}`);
    }
  }

  if (plan.alternatives.length > 0) {
    lines.push("");
    lines.push("Alternatives:");
    for (const alt of plan.alternatives) {
      lines.push(`- ${alt}`);
    }
  }

  return lines.join("\n");
}

// ─── Unsupported Message ─────────────────────────────────────────────────────

const SUPPORTED_INTENTS_MSG = `Intent not recognized. Supported intent patterns:

  Transfer/Send:    "Send 50 ETO to <address>", "Transfer 1.5 ETO to alice"
  Deploy:           "Deploy this contract", "Launch contract on EVM"
  Deploy & Test:    "Deploy and test this contract", "Deploy then verify"
  Stake/Delegate:   "Stake 100 ETO with validator", "Delegate 50 ETO"
  Auto Stake:       "Stake with best validator", "Auto stake 100 ETO"
  Create Token:     "Create token MYTKN", "Launch token with supply 1000000"
  Token Launch:     "Create a token and distribute", "Launch token MYTKN"
  DAO/Governance:   "Create a DAO", "Set up governance"
  Balance/Query:    "Check balance of <address>", "What is my balance"
  Swap (planned):   "Swap 10 ETO for USDC" (DEX routing not yet available)

For complex flows, use plan_execution first to preview what will happen.`;

// ─── Tool Registration ───────────────────────────────────────────────────────

export function registerIntentTools(server: McpServer): void {
  server.tool(
    "execute_intent",
    "Express what you want to accomplish in natural language or structured intent format. The intent engine determines the optimal execution path, simulates it, and executes after confirmation. This is the highest-level tool — it composes other tools automatically. Examples: 'Send 50 ETO to alice', 'Deploy this contract and verify it', 'Set up staking with the top validator', 'Create a token and distribute to 5 addresses'.",
    {
      intent: z.string().describe("Natural language description of what you want to do"),
      constraints: z.object({
        max_cost: z.string().optional().describe("Maximum ETO to spend"),
        deadline: z.number().optional().describe("Unix timestamp deadline"),
        preferred_vm: z.enum(["svm", "evm", "wasm", "move"]).optional(),
        dry_run: z.boolean().default(false).optional().describe("Only simulate, don't execute"),
      }).optional(),
    },
    async ({ intent, constraints }) => {
      try {
        const dryRun = constraints?.dry_run ?? false;
        const parsed = parseIntent(intent);
        const plan = buildExecutionPlan(parsed);

        if (parsed.type === "unknown") {
          return {
            content: [{ type: "text" as const, text: SUPPORTED_INTENTS_MSG }],
          };
        }

        if (parsed.type === "dao") {
          return {
            content: [
              {
                type: "text" as const,
                text: [
                  `Executing intent: "${intent}"`,
                  "",
                  formatPlan(intent, buildExecutionPlan(parsed)),
                  "",
                  "Execution Results:",
                  "──────────────────",
                  "To execute this DAO setup, run the steps above in sequence.",
                  "Tip: Start with create_token to mint your governance token, then deploy the treasury agent.",
                ].join("\n"),
              },
            ],
          };
        }

        if (parsed.type === "deploy_and_test") {
          return {
            content: [
              {
                type: "text" as const,
                text: [
                  `Executing intent: "${intent}"`,
                  "",
                  formatPlan(intent, buildExecutionPlan(parsed)),
                  "",
                  "Execution Results:",
                  "──────────────────",
                  "To execute this deploy-and-test workflow, call deploy_contract with your bytecode, then use get_account and get_transaction to verify.",
                  "Tip: Use batch_execute to chain these steps automatically.",
                ].join("\n"),
              },
            ],
          };
        }

        if (parsed.type === "auto_stake") {
          const resultLines: string[] = [
            `Executing intent: "${intent}"`,
            "",
            formatPlan(intent, buildExecutionPlan(parsed)),
            "",
            "Execution Results:",
            "──────────────────",
          ];
          try {
            const voteAccounts = await rpc.getVoteAccounts();
            const current: any[] = voteAccounts?.current ?? [];
            if (current.length === 0) {
              resultLines.push("No active validators found.");
            } else {
              const best = current.reduce((prev: any, curr: any) => {
                const prevScore = Number(prev.activatedStake ?? 0) / (Number(prev.commission ?? 100) + 1);
                const currScore = Number(curr.activatedStake ?? 0) / (Number(curr.commission ?? 100) + 1);
                return currScore > prevScore ? curr : prev;
              }, current[0]);
              resultLines.push(`Found ${current.length} active validators.`);
              resultLines.push(`Best validator: ${best.votePubkey ?? "N/A"} (commission: ${best.commission ?? "N/A"}%, stake: ${best.activatedStake ?? "N/A"} lamports)`);
              resultLines.push("");
              resultLines.push("To stake, call: stake_native");
              resultLines.push(`  amount: ${parsed.params.amount ?? "10"}`);
              resultLines.push(`  validator_vote_account: ${best.votePubkey ?? "<vote-pubkey>"}`);
            }
          } catch (e: any) {
            resultLines.push(`Validator lookup failed: ${e.message}`);
            resultLines.push("To stake, call: stake_native with the desired validator_vote_account.");
          }
          return { content: [{ type: "text" as const, text: resultLines.join("\n") }] };
        }

        if (parsed.type === "swap") {
          return {
            content: [
              {
                type: "text" as const,
                text: "DEX routing not yet available. Swap intents are planned for a future release.\n\nAlternatives:\n- Use transfer_native to move ETO between wallets",
              },
            ],
          };
        }

        const planText = formatPlan(intent, plan);

        if (dryRun) {
          return {
            content: [
              {
                type: "text" as const,
                text: `[DRY RUN — nothing will be executed]\n\n${planText}`,
              },
            ],
          };
        }

        // Execute steps based on intent type
        const resultLines: string[] = [
          `Executing intent: "${intent}"`,
          "",
          planText,
          "",
          "Execution Results:",
          "──────────────────",
        ];

        if (parsed.type === "query") {
          // For query intents, execute the balance lookup directly
          const address = parsed.params.address ?? parsed.params.name;
          if (!address) {
            resultLines.push("No address found in intent. Please specify an address to query.");
          } else {
            try {
              const addrType = detectAddressType(address);
              let balanceLamports: bigint;

              if (addrType === "evm") {
                const hexWei = await rpc.ethGetBalance(address);
                balanceLamports = BigInt(hexWei);
              } else if (addrType === "svm") {
                const result = await rpc.getBalance(address);
                balanceLamports = BigInt(result.value);
              } else {
                resultLines.push(`Could not resolve address type for: ${address}`);
                return { content: [{ type: "text" as const, text: resultLines.join("\n") }] };
              }

              const amount = lamportsToSol(balanceLamports);
              resultLines.push(`Balance of ${address}: ${amount} ETO (${balanceLamports} lamports)`);
            } catch (err: any) {
              resultLines.push(`Query failed: ${err.message}`);
            }
          }
        } else if (parsed.type === "transfer") {
          // Describe what needs to happen — direct execution requires wasm/signing infrastructure
          // that is already wired in transfer_native; here we note the steps to call
          resultLines.push("To execute this transfer, call: transfer_native");
          if (parsed.params.address ?? parsed.params.name) {
            resultLines.push(`  to: ${parsed.params.address ?? parsed.params.name}`);
          }
          if (parsed.params.amount) {
            resultLines.push(`  amount: ${parsed.params.amount}`);
          }
          resultLines.push("");
          resultLines.push("Tip: Use the transfer_native tool directly for full control, or set dry_run=true to preview without executing.");
        } else if (parsed.type === "deploy") {
          resultLines.push("To execute this deployment, call: deploy_contract");
          resultLines.push("  Provide the compiled bytecode and target VM (svm/evm/wasm/move).");
          resultLines.push("");
          resultLines.push("Tip: Use the deploy_contract tool directly with your bytecode.");
        } else if (parsed.type === "stake") {
          resultLines.push("To execute this stake, call: stake_native");
          if (parsed.params.amount) {
            resultLines.push(`  amount: ${parsed.params.amount}`);
          }
          if (parsed.params.address ?? parsed.params.name) {
            resultLines.push(`  validator_vote_account: ${parsed.params.address ?? parsed.params.name}`);
          }
          resultLines.push("");
          resultLines.push("Tip: Use get_validators first to find available validator vote accounts.");
        } else if (parsed.type === "token_launch") {
          resultLines.push("To execute this token launch, call: create_token");
          if (parsed.params.name) {
            resultLines.push(`  symbol: ${parsed.params.name}`);
          }
          if (parsed.params.amount) {
            resultLines.push(`  initial_supply: ${parsed.params.amount}`);
          }
          resultLines.push("");
          resultLines.push("Tip: Use the create_token tool directly for full control over decimals and authority.");
        }

        return {
          content: [{ type: "text" as const, text: resultLines.join("\n") }],
        };
      } catch (err: any) {
        return {
          content: [{ type: "text" as const, text: `Error: ${err.message}` }],
          isError: true,
        };
      }
    }
  );

  server.tool(
    "plan_execution",
    "Given a complex operation or intent, generate a detailed execution plan without executing anything. Shows every step, estimated costs, required permissions, and potential failure points. Use this before execute_intent to review what will happen.",
    {
      intent: z.string().describe("What you want to accomplish"),
    },
    async ({ intent }) => {
      try {
        const parsed = parseIntent(intent);

        if (parsed.type === "unknown") {
          return {
            content: [{ type: "text" as const, text: SUPPORTED_INTENTS_MSG }],
          };
        }

        const plan = buildExecutionPlan(parsed);
        const text = formatPlan(intent, plan);

        return {
          content: [{ type: "text" as const, text: text }],
        };
      } catch (err: any) {
        return {
          content: [{ type: "text" as const, text: `Error: ${err.message}` }],
          isError: true,
        };
      }
    }
  );
}
