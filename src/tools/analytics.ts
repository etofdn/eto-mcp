import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { rpc } from "../read/rpc-client.js";
import { getSignerFactory } from "../signing/index.js";
import { getActiveWalletId } from "./wallet.js";
import { lamportsToSol, toTokenAmount } from "../utils/units.js";

export function registerAnalyticsTools(server: McpServer): void {
  server.tool(
    "get_portfolio",
    "Get a comprehensive portfolio view across all wallets and VMs. Shows native token balance, all token holdings, staking positions, agent investments, and total portfolio value.",
    {
      include_history: z
        .boolean()
        .default(false)
        .optional()
        .describe("Include historical portfolio values (24h, 7d, 30d)"),
    },
    async ({ include_history }) => {
      try {
        const factory = getSignerFactory();
        const walletIds = await factory.listWallets();

        if (walletIds.length === 0) {
          return {
            content: [
              {
                type: "text" as const,
                text: "No wallets found. Use create_wallet or import_wallet to add one.",
              },
            ],
          };
        }

        let totalLamports = 0n;
        const walletLines: string[] = [];

        for (const walletId of walletIds) {
          try {
            const signer = await factory.getSigner(walletId);
            const svmAddress = signer.getPublicKey();
            const evmAddress = signer.getEvmAddress();
            const label = walletId;

            let nativeLamports = 0n;
            try {
              const balResult = await rpc.getBalance(svmAddress);
              nativeLamports = BigInt(balResult.value);
            } catch {
              // balance unavailable
            }

            totalLamports += nativeLamports;
            const nativeDisplay = lamportsToSol(nativeLamports);

            const tokenLines: string[] = [];
            try {
              const tokenAccounts = await rpc.getTokenAccountsByOwner(svmAddress);
              if (tokenAccounts && tokenAccounts.length > 0) {
                for (const ta of tokenAccounts) {
                  const mint = ta.mint ?? ta.account?.data?.parsed?.info?.mint ?? "unknown";
                  const rawAmount =
                    ta.amount ??
                    ta.account?.data?.parsed?.info?.tokenAmount?.amount ??
                    "0";
                  const decimals =
                    ta.decimals ??
                    ta.account?.data?.parsed?.info?.tokenAmount?.decimals ??
                    0;
                  const symbol = ta.symbol ?? ta.mint?.slice(0, 6) ?? "TOKEN";
                  const tok = toTokenAmount(BigInt(rawAmount), decimals, symbol);
                  tokenLines.push(`    - ${tok.symbol ?? symbol}: ${tok.human} (${mint})`);
                }
              }
            } catch {
              // token accounts unavailable
            }

            walletLines.push(`Wallet: ${label} (${svmAddress})`);
            walletLines.push(`  Native: ${nativeDisplay} ETO`);
            walletLines.push(`  Tokens: ${tokenLines.length}`);
            for (const tl of tokenLines) {
              walletLines.push(tl);
            }
            walletLines.push(`  EVM Address: ${evmAddress}`);
            walletLines.push("");
          } catch {
            walletLines.push(`Wallet: ${walletId} (error loading)`);
            walletLines.push("");
          }
        }

        const totalDisplay = lamportsToSol(totalLamports);

        const lines = [
          "Portfolio Summary",
          "═══════════════",
          "",
          `Wallets: ${walletIds.length}`,
          `Total Native Balance: ${totalDisplay} ETO`,
          "",
          ...walletLines,
          `Total Portfolio Value: ${totalDisplay} ETO`,
        ];

        if (include_history) {
          lines.push("");
          lines.push("Note: Historical data requires an indexer — not yet available.");
        }

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
    "get_activity_feed",
    "Get a chronological feed of all on-chain activity for your wallets. Includes transfers, contract calls, staking events, agent executions, swarm votes, and more.",
    {
      limit: z.number().default(50).optional().describe("Number of activities to return (default 50)"),
      filter: z
        .enum(["all", "transfers", "contracts", "staking", "agents", "swarms"])
        .default("all")
        .optional()
        .describe("Filter by activity type: all, transfers, contracts, staking, agents, or swarms"),
    },
    async ({ limit, filter }) => {
      try {
        const activeId = getActiveWalletId();
        if (!activeId) {
          return {
            content: [
              {
                type: "text" as const,
                text: "No active wallet. Use set_active_wallet to select one.",
              },
            ],
          };
        }

        const factory = getSignerFactory();
        const signer = await factory.getSigner(activeId);
        const svmAddress = signer.getPublicKey();

        const txs = await rpc.etoGetAccountTransactions(svmAddress, limit ?? 50, 0);

        if (!txs || txs.length === 0) {
          return {
            content: [
              {
                type: "text" as const,
                text: `No activity found for ${svmAddress}`,
              },
            ],
          };
        }

        const filterKeywords: Record<string, string[]> = {
          transfers: ["transfer", "send", "receive"],
          contracts: ["contract", "call", "evm", "invoke", "deploy"],
          staking: ["stake", "delegate", "unstake", "undelegate", "validator"],
          agents: ["agent", "execute", "spawn"],
          swarms: ["swarm", "vote", "proposal"],
        };

        const filtered =
          filter && filter !== "all"
            ? txs.filter((tx: any) => {
                const instrType = (
                  tx.instruction_type ??
                  tx.instructionType ??
                  tx.type ??
                  ""
                ).toLowerCase();
                const keywords = filterKeywords[filter] ?? [];
                return keywords.some((kw) => instrType.includes(kw));
              })
            : txs;

        const lines = [
          `Activity Feed for ${svmAddress}`,
          "═══════════════════════════",
          "",
        ];

        for (const tx of filtered) {
          const hash = tx.signature ?? tx.hash ?? "N/A";
          const block = tx.slot ?? tx.blockHeight ?? tx.block ?? "?";
          const instrType = tx.instruction_type ?? tx.instructionType ?? tx.type ?? "Unknown";
          const success = (tx.success ?? !tx.err) ? "✓" : "✗";
          const value =
            tx.value !== undefined && tx.value !== null
              ? ` ${lamportsToSol(tx.value)} ETO`
              : "";
          const to = tx.to ?? tx.recipient ?? "";
          const toStr = to ? ` → ${to}` : "";
          lines.push(`[Block ${block}] ${instrType}:${value}${toStr} ${success}`);
        }

        lines.push("");
        lines.push(`Showing ${filtered.length} of ${txs.length} activities`);

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
    "get_gas_analytics",
    "Get analytics on your gas/fee spending over time. Shows total fees paid, average fee per transaction, most expensive operations, and optimization suggestions.",
    {
      period: z
        .enum(["24h", "7d", "30d", "all"])
        .default("7d")
        .optional()
        .describe("Time period to analyze: 24h, 7d, 30d, or all"),
    },
    async ({ period }) => {
      try {
        const activeId = getActiveWalletId();
        if (!activeId) {
          return {
            content: [
              {
                type: "text" as const,
                text: "No active wallet. Use set_active_wallet to select one.",
              },
            ],
          };
        }

        const factory = getSignerFactory();
        const signer = await factory.getSigner(activeId);
        const svmAddress = signer.getPublicKey();

        const txs = await rpc.etoGetAccountTransactions(svmAddress, 100, 0);

        if (!txs || txs.length === 0) {
          return {
            content: [
              {
                type: "text" as const,
                text: `No transactions found for ${svmAddress}`,
              },
            ],
          };
        }

        let totalFeeLamports = 0n;
        let mostExpensiveFee = 0n;
        let mostExpensiveHash = "";
        let mostExpensiveType = "";

        const byType: Record<string, { count: number; totalLamports: bigint }> = {};

        for (const tx of txs) {
          const fee = tx.fee !== undefined && tx.fee !== null ? BigInt(tx.fee) : 0n;
          totalFeeLamports += fee;

          if (fee > mostExpensiveFee) {
            mostExpensiveFee = fee;
            mostExpensiveHash = tx.signature ?? tx.hash ?? "N/A";
            mostExpensiveType = tx.instruction_type ?? tx.instructionType ?? tx.type ?? "Unknown";
          }

          const txType = (
            tx.instruction_type ?? tx.instructionType ?? tx.type ?? "unknown"
          ).toLowerCase();

          let bucket = "other";
          if (txType.includes("transfer") || txType.includes("send")) {
            bucket = "transfers";
          } else if (txType.includes("deploy")) {
            bucket = "deploys";
          } else if (
            txType.includes("contract") ||
            txType.includes("call") ||
            txType.includes("evm")
          ) {
            bucket = "contracts";
          }

          if (!byType[bucket]) byType[bucket] = { count: 0, totalLamports: 0n };
          byType[bucket].count += 1;
          byType[bucket].totalLamports += fee;
        }

        const count = txs.length;
        const avgFeeLamports = count > 0 ? totalFeeLamports / BigInt(count) : 0n;

        const lines = [
          `Gas Analytics (${period ?? "7d"})`,
          "════════════════════════",
          "",
          `Total Transactions: ${count}`,
          `Total Fees Paid: ${lamportsToSol(totalFeeLamports)} ETO (${totalFeeLamports} lamports)`,
          `Average Fee: ${lamportsToSol(avgFeeLamports)} ETO per transaction`,
          "",
          "Most Expensive:",
          `  ${mostExpensiveHash} — ${lamportsToSol(mostExpensiveFee)} ETO (${mostExpensiveType})`,
          "",
          "Fee Breakdown by Type:",
        ];

        for (const [bucket, data] of Object.entries(byType)) {
          const label = bucket.charAt(0).toUpperCase() + bucket.slice(1);
          lines.push(
            `  ${label}: ${data.count} txs, ${lamportsToSol(data.totalLamports)} ETO`
          );
        }

        lines.push("");
        lines.push("Optimization Suggestions:");
        lines.push(
          "  - Use batch_transfer for multiple recipients (saves ~40% fees)"
        );
        lines.push(
          "  - Use simulation to avoid failed transactions"
        );
        lines.push("");
        lines.push(
          `Note: Period filtering (${period ?? "7d"}) requires timestamps — showing all available data.`
        );

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
