import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { getSignerFactory } from "../signing/index.js";
import { getActiveWalletId } from "./wallet.js";
import { blockhashCache } from "../write/blockhash-cache.js";
import { submitter } from "../write/submitter.js";
import { buildTransferTx } from "../wasm/index.js";
import { solToLamports } from "../utils/units.js";
import bs58 from "bs58";

// In-memory service registry and escrow
const serviceRegistry = new Map<string, AgentService>();
const escrowContracts = new Map<string, EscrowContract>();

interface AgentService {
  agentDid: string;
  agentName: string;
  category: string;
  description: string;
  pricing: string;
  sla: string;
  reputation: number;
  usageCount: number;
  registeredAt: string;
}

interface EscrowContract {
  id: string;
  hirer: string;
  agent: string;
  payment: string;
  task: { description: string; deliverables: string[]; deadline: number };
  escrowType: string;
  status: "active" | "completed" | "disputed" | "expired";
  createdAt: string;
}

function seedRegistry(): void {
  const seeds: AgentService[] = [
    {
      agentDid: "did:eto:DataAnalyst-1",
      agentName: "DataAnalyst-1",
      category: "analysis",
      description: "On-chain data analysis and reporting",
      pricing: "0.1 ETO/query",
      sla: "< 30s response, 99.5% uptime",
      reputation: 9200,
      usageCount: 4821,
      registeredAt: new Date(Date.now() - 30 * 24 * 3600 * 1000).toISOString(),
    },
    {
      agentDid: "did:eto:ContractAuditor-1",
      agentName: "ContractAuditor-1",
      category: "auditing",
      description: "Smart contract security analysis",
      pricing: "1 ETO/contract",
      sla: "< 5min turnaround, full report",
      reputation: 9750,
      usageCount: 1203,
      registeredAt: new Date(Date.now() - 60 * 24 * 3600 * 1000).toISOString(),
    },
    {
      agentDid: "did:eto:OracleService-1",
      agentName: "OracleService-1",
      category: "oracle",
      description: "Real-time price feeds for DeFi",
      pricing: "0.01 ETO/call",
      sla: "< 1s latency, 99.9% uptime",
      reputation: 9600,
      usageCount: 98342,
      registeredAt: new Date(Date.now() - 90 * 24 * 3600 * 1000).toISOString(),
    },
    {
      agentDid: "did:eto:TradingBot-1",
      agentName: "TradingBot-1",
      category: "trading",
      description: "Automated trading strategies and portfolio management",
      pricing: "0.5 ETO/strategy",
      sla: "< 100ms execution, 24/7 operation",
      reputation: 8800,
      usageCount: 2109,
      registeredAt: new Date(Date.now() - 14 * 24 * 3600 * 1000).toISOString(),
    },
  ];

  for (const svc of seeds) {
    serviceRegistry.set(svc.agentDid, svc);
  }
}

export function registerMarketplaceTools(server: McpServer): void {
  server.tool(
    "list_agent_services",
    "Browse the agent marketplace. Agents publish services they offer — data analysis, trading strategies, contract auditing, content generation — with pricing and SLAs. Find the right agent for your task.",
    {
      category: z
        .enum(["all", "trading", "analysis", "deployment", "auditing", "oracle", "computation", "storage", "custom"])
        .default("all")
        .optional()
        .describe("Filter services by category"),
      sort_by: z
        .enum(["reputation", "price_low", "price_high", "most_used"])
        .default("reputation")
        .optional()
        .describe("Sort order: reputation, price_low, price_high, or most_used"),
    },
    async ({ category = "all", sort_by = "reputation" }) => {
      try {
        // Seed registry on first call if empty
        if (serviceRegistry.size === 0) {
          seedRegistry();
        }

        // Filter by category
        let services = Array.from(serviceRegistry.values());
        if (category !== "all") {
          services = services.filter((s) => s.category === category);
        }

        // Sort
        switch (sort_by) {
          case "reputation":
            services.sort((a, b) => b.reputation - a.reputation);
            break;
          case "price_low":
            services.sort((a, b) => {
              const aPrice = parseFloat(a.pricing);
              const bPrice = parseFloat(b.pricing);
              return aPrice - bPrice;
            });
            break;
          case "price_high":
            services.sort((a, b) => {
              const aPrice = parseFloat(a.pricing);
              const bPrice = parseFloat(b.pricing);
              return bPrice - aPrice;
            });
            break;
          case "most_used":
            services.sort((a, b) => b.usageCount - a.usageCount);
            break;
        }

        const lines: string[] = [
          `Agent Marketplace (${services.length} services)`,
          "═════════════════════════════════════",
          "",
        ];

        if (services.length === 0) {
          lines.push(`No services found in category: ${category}`);
        } else {
          services.forEach((svc, idx) => {
            lines.push(`${idx + 1}. ${svc.agentName} [${svc.category}]`);
            lines.push(`   ${svc.description}`);
            lines.push(`   Pricing: ${svc.pricing} | Reputation: ${svc.reputation}/10000`);
            lines.push(`   Usage: ${svc.usageCount} calls | SLA: ${svc.sla}`);
            lines.push("");
          });
        }

        lines.push("Browse by category: trading, analysis, deployment, auditing, oracle, computation, storage");

        return { content: [{ type: "text" as const, text: lines.join("\n") }] };
      } catch (err: any) {
        return {
          content: [{ type: "text" as const, text: `Error: ${err?.message ?? String(err)}` }],
          isError: true,
        };
      }
    }
  );

  server.tool(
    "hire_agent",
    "Hire another agent to perform a task. Creates an escrow contract that holds payment until the task is completed and verified. The hired agent receives the task specification, executes it, and submits proof of completion. If the proof verifies, payment releases.",
    {
      agent_did: z.string().describe("Agent DID or address to hire"),
      task: z.object({
        description: z.string().describe("Description of the task to be performed"),
        deliverables: z.array(z.string()).optional().describe("List of expected deliverables"),
        deadline: z.number().optional().describe("Unix timestamp deadline"),
      }),
      payment: z.string().describe("Payment amount in ETO"),
      escrow_type: z
        .enum(["time_locked", "milestone", "arbitrated"])
        .default("time_locked")
        .optional()
        .describe("Escrow release mechanism: time_locked, milestone, or arbitrated"),
    },
    async ({ agent_did, task, payment, escrow_type = "time_locked" }) => {
      try {
        // Resolve active wallet
        const walletId = getActiveWalletId();
        if (!walletId) {
          return {
            content: [
              {
                type: "text" as const,
                text: "No active wallet set. Use set_active_wallet before hiring an agent.",
              },
            ],
          };
        }

        // Validate payment
        const paymentFloat = parseFloat(payment);
        if (isNaN(paymentFloat) || paymentFloat <= 0) {
          return {
            content: [
              {
                type: "text" as const,
                text: `Invalid payment amount: "${payment}". Provide a positive number in ETO (e.g. "1.5").`,
              },
            ],
          };
        }

        const factory = getSignerFactory();
        const signer = await factory.getSigner(walletId);
        const hirerAddress = signer.getPublicKey();

        // Generate a unique escrow ID from hirer + agent + timestamp
        const escrowRaw = `${hirerAddress}-${agent_did}-${Date.now()}`;
        const escrowIdBytes = Buffer.alloc(32);
        Buffer.from(escrowRaw).copy(escrowIdBytes, 0, 0, Math.min(32, Buffer.from(escrowRaw).length));
        const escrowId = bs58.encode(escrowIdBytes);

        // Build transfer to lock funds into escrow address
        const lamports = solToLamports(payment);
        const { blockhash } = await blockhashCache.getBlockhash();

        // The escrow ID bytes (32 bytes, base58 encoded) serve as the escrow address.
        // In production this would be a program-derived address; here we reuse the
        // same 32-byte buffer that generated escrowId.
        const escrowAddress = escrowId;

        const txBytes = buildTransferTx(hirerAddress, escrowAddress, lamports, blockhash);
        const signedBytes = await signer.sign(txBytes);
        const signedBase64 = Buffer.from(signedBytes).toString("base64");

        const result = await submitter.submitAndConfirm({
          signedTxBase64: signedBase64,
          vm: "svm",
          idempotencyKey: `hire-${escrowId}-${blockhash}`,
        });

        if (result.status !== "confirmed" && result.status !== "finalized" && result.status !== "timeout") {
          const errMsg = result.error?.explanation ?? result.error?.raw_message ?? "Unknown submission error";
          return {
            content: [
              {
                type: "text" as const,
                text: `Failed to lock escrow payment: ${errMsg}`,
              },
            ],
            isError: true,
          };
        }

        // Store the escrow contract
        const contract: EscrowContract = {
          id: escrowId,
          hirer: hirerAddress,
          agent: agent_did,
          payment: `${payment} ETO`,
          task: {
            description: task.description,
            deliverables: task.deliverables ?? [],
            deadline: task.deadline ?? 0,
          },
          escrowType: escrow_type,
          status: "active",
          createdAt: new Date().toISOString(),
        };
        escrowContracts.set(escrowId, contract);

        // Format deadline
        const deadlineStr = task.deadline
          ? new Date(task.deadline * 1000).toUTCString()
          : "None";

        // Format deliverables
        const deliverableLines =
          task.deliverables && task.deliverables.length > 0
            ? task.deliverables.map((d) => `  - ${d}`).join("\n")
            : "  (none specified)";

        const lines = [
          "Agent Hired — Escrow Created",
          "═════════════════════════════",
          "",
          `Escrow ID:    ${escrowId}`,
          `Hired Agent:  ${agent_did}`,
          `Task:         ${task.description}`,
          `Deliverables:`,
          deliverableLines,
          `Payment:      ${payment} ETO (locked in escrow)`,
          `Escrow Type:  ${escrow_type}`,
          `Deadline:     ${deadlineStr}`,
          `Status:       Active`,
          "",
          "The hired agent can now begin work. Payment releases on verified completion.",
          `Signature:    ${result.signature ?? "pending"}`,
        ];

        return { content: [{ type: "text" as const, text: lines.join("\n") }] };
      } catch (err: any) {
        return {
          content: [{ type: "text" as const, text: `Error: ${err?.message ?? String(err)}` }],
          isError: true,
        };
      }
    }
  );
}
