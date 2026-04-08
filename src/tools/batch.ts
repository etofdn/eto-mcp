import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { rpc } from "../read/rpc-client.js";
import { lamportsToSol, solToLamports } from "../utils/units.js";

// Dispatcher map for tools executable directly via RPC in batch context
const toolDispatch: Record<string, (params: any) => Promise<string>> = {
  get_balance: async (p) => {
    const result = await rpc.getBalance(p.address);
    const amount = lamportsToSol(BigInt(result.value));
    return `Balance: ${amount} ETO (${result.value} lamports)`;
  },
  get_block_height: async () => {
    const h = await rpc.getBlockHeight();
    return `Block height: ${h}`;
  },
  get_health: async () => {
    const h = await rpc.getHealth();
    return `Health: ${h}`;
  },
  airdrop: async (p) => {
    const lamports = Number(solToLamports(String(p.amount ?? "1")));
    const sig = await rpc.faucet(p.address, lamports);
    return `Airdropped ${p.amount ?? "1"} ETO to ${p.address}. Signature: ${sig}`;
  },
  get_account: async (p) => {
    const account = await rpc.etoGetAccount(p.address);
    return account ? JSON.stringify(account, null, 2) : `Account not found: ${p.address}`;
  },
  get_transaction: async (p) => {
    const tx = await rpc.etoGetTransaction(p.hash);
    return tx ? JSON.stringify(tx, null, 2) : `Transaction not found: ${p.hash}`;
  },
  get_block: async (p) => {
    const block = await rpc.etoGetBlock(p.height);
    return block ? JSON.stringify(block, null, 2) : `Block not found at height: ${p.height}`;
  },
  get_chain_stats: async () => {
    const stats = await rpc.etoGetStats();
    return stats ? JSON.stringify(stats, null, 2) : "No stats available";
  },
  get_account_transactions: async (p) => {
    const txs = await rpc.etoGetAccountTransactions(p.address, p.limit ?? 20, p.offset ?? 0);
    return txs ? JSON.stringify(txs, null, 2) : `No transactions found for ${p.address}`;
  },
};

export function registerBatchTools(server: McpServer): void {
  server.tool(
    "batch_execute",
    "Executes a sequence of up to 10 write operations in order, returning results for each. Operations are run sequentially one at a time. When atomic is true (the default), execution stops on the first failure and remaining operations are skipped — note that true atomicity with rollback is not possible at the MCP tool layer, so any already-confirmed on-chain transactions cannot be reversed. Each operation specifies a tool name and its parameters; results include success/failure status and output for every step.",
    {
      operations: z.array(
        z.object({
          tool: z.string().describe("Tool name to execute (e.g. 'transfer_native', 'create_agent')"),
          params: z.any().describe("Parameters to pass to the tool"),
        })
      ).max(10).describe("List of operations to execute sequentially (max 10)"),
      atomic: z.boolean().default(true).optional()
        .describe("Stop on first failure when true (default: true). Cannot roll back already-confirmed on-chain transactions."),
    },
    async ({ operations, atomic }) => {
      try {
        const results: string[] = [
          `Batch execute: ${operations.length} operations (atomic=${atomic ?? true})`,
          "",
        ];

        let successCount = 0;
        let failCount = 0;
        let stopped = false;

        for (let i = 0; i < operations.length; i++) {
          const { tool, params } = operations[i];

          if (stopped) {
            results.push(`[${i + 1}] SKIPPED  tool=${tool} (stopped due to previous failure)`);
            continue;
          }

          try {
            // Dispatch to handler map (covers both read and supported write tools)
            let output: string;

            const handler = toolDispatch[tool];
            if (handler) {
              output = await handler(params);
            } else {
              output = `Tool '${tool}' is not directly supported in batch_execute. Supported tools: ${Object.keys(toolDispatch).join(", ")}.`;
            }

            successCount++;
            results.push(`[${i + 1}] OK    tool=${tool}`);
            results.push(`        output=${output.split("\n")[0]}${output.includes("\n") ? " ..." : ""}`);
          } catch (opErr: any) {
            failCount++;
            const errMsg = opErr?.message ?? String(opErr);
            results.push(`[${i + 1}] ERROR  tool=${tool}  error=${errMsg}`);
            if (atomic !== false) {
              stopped = true;
            }
          }
        }

        results.push("");
        results.push(`Summary: ${successCount} succeeded, ${failCount} failed, ${operations.length - successCount - failCount} skipped.`);
        if (atomic !== false && failCount > 0) {
          results.push("Note: Execution halted on first failure (atomic=true). Already-confirmed transactions cannot be rolled back.");
        }

        return { content: [{ type: "text" as const, text: results.join("\n") }] };
      } catch (err: any) {
        return {
          content: [{ type: "text" as const, text: `Error: ${err?.message ?? String(err)}` }],
          isError: true,
        };
      }
    }
  );

  server.tool(
    "batch_query",
    "Executes up to 20 read-only queries in parallel using Promise.all, returning all results simultaneously. This is significantly faster than running queries sequentially when multiple independent lookups are needed. Supported query tools include get_balance, get_account, get_transaction, get_block, get_block_height, get_chain_stats, and get_account_transactions. Each result includes the tool name, success status, and output.",
    {
      queries: z.array(
        z.object({
          tool: z.string().describe("Read-only tool name to query"),
          params: z.any().describe("Parameters for the query"),
        })
      ).max(20).describe("List of read queries to execute in parallel (max 20)"),
    },
    async ({ queries }) => {
      try {
        const executeQuery = async (tool: string, params: any): Promise<string> => {
          switch (tool) {
            case "get_balance": {
              const result = await rpc.getBalance(params.address);
              const amount = lamportsToSol(BigInt(result.value));
              return `Balance of ${params.address}: ${amount} ETO (${result.value} lamports)`;
            }
            case "get_account": {
              const account = await rpc.etoGetAccount(params.address);
              if (!account) return `Account not found: ${params.address}`;
              return [
                `Address: ${params.address}`,
                `Balance: ${account.lamports !== undefined ? lamportsToSol(account.lamports) + " ETO" : "N/A"}`,
                `Owner:   ${account.owner ?? "N/A"}`,
                `VM:      ${account.vmType ?? account.vm_type ?? "svm"}`,
              ].join("\n");
            }
            case "get_transaction": {
              const tx = await rpc.etoGetTransaction(params.hash);
              if (!tx) return `Transaction not found: ${params.hash}`;
              return [
                `Hash:   ${params.hash}`,
                `VM:     ${tx.vm ?? tx.vmType ?? "N/A"}`,
                `Status: ${tx.success !== undefined ? (tx.success ? "success" : "failed") : "N/A"}`,
              ].join("\n");
            }
            case "get_block": {
              const block = await rpc.etoGetBlock(params.height);
              if (!block) return `Block not found: ${params.height}`;
              return [
                `Height: ${params.height}`,
                `Hash:   ${block.hash ?? block.blockhash ?? "N/A"}`,
                `TXs:    ${block.txCount ?? block.transactions?.length ?? 0}`,
              ].join("\n");
            }
            case "get_block_height": {
              const height = await rpc.getBlockHeight();
              return `Current block height: ${height}`;
            }
            case "get_chain_stats": {
              const stats = await rpc.etoGetStats();
              if (!stats) return "No stats available";
              return [
                `Block Height: ${stats.blockHeight ?? stats.block_height ?? "N/A"}`,
                `TPS:          ${stats.tps ?? "N/A"}`,
                `Total TXs:    ${stats.totalTxs ?? stats.total_txs ?? "N/A"}`,
              ].join("\n");
            }
            case "get_account_transactions": {
              const txs = await rpc.etoGetAccountTransactions(
                params.address,
                params.limit ?? 20,
                params.offset ?? 0
              );
              if (!txs || txs.length === 0) return `No transactions for ${params.address}`;
              return `Found ${txs.length} transactions for ${params.address}`;
            }
            default:
              return `Query tool '${tool}' not supported in batch_query. Supported: get_balance, get_account, get_transaction, get_block, get_block_height, get_chain_stats, get_account_transactions.`;
          }
        };

        // Execute all queries in parallel
        const settled = await Promise.allSettled(
          queries.map(({ tool, params }) => executeQuery(tool, params))
        );

        const lines = [`Batch query: ${queries.length} queries executed in parallel`, ""];
        let successCount = 0;
        let failCount = 0;

        for (let i = 0; i < queries.length; i++) {
          const { tool } = queries[i];
          const outcome = settled[i];
          if (outcome.status === "fulfilled") {
            successCount++;
            const firstLine = outcome.value.split("\n")[0];
            const hasMore = outcome.value.includes("\n");
            lines.push(`[${i + 1}] OK    tool=${tool}`);
            lines.push(`        ${firstLine}${hasMore ? " ..." : ""}`);
          } else {
            failCount++;
            lines.push(`[${i + 1}] ERROR  tool=${tool}  error=${outcome.reason?.message ?? String(outcome.reason)}`);
          }
        }

        lines.push("");
        lines.push(`Summary: ${successCount} succeeded, ${failCount} failed out of ${queries.length} total.`);

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
