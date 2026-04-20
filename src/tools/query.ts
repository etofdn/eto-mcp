import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { rpc } from "../read/rpc-client.js";
import { lamportsToSol } from "../utils/units.js";
import { detectAddressType } from "../utils/address.js";

export function registerQueryTools(server: McpServer): void {
  server.tool(
    "get_balance",
    "Get the ETO balance of an address. Accepts both SVM (base58) and EVM (0x-prefixed) addresses. Returns the balance in ETO and raw lamports.",
    { address: z.string().describe("Address (base58 or 0x)") },
    async ({ address }) => {
      try {
        const addrType = detectAddressType(address);

        // The chain commits txs before applying state writes, so a getBalance
        // immediately after airdrop/transfer can read 0 even though the tx was
        // confirmed. Briefly retry-on-zero so well-funded accounts don't show
        // up empty in QA / first-touch reads.
        const fetchOnce = async (): Promise<bigint> => {
          if (addrType === "evm") {
            return BigInt(await rpc.ethGetBalance(address));
          }
          const result = await rpc.getBalance(address);
          return BigInt(result.value);
        };

        let balanceLamports = await fetchOnce();
        for (let i = 0; balanceLamports === 0n && i < 3; i++) {
          await new Promise((r) => setTimeout(r, 200));
          balanceLamports = await fetchOnce();
        }

        const amount = lamportsToSol(balanceLamports);
        return {
          content: [
            {
              type: "text",
              text: `Balance of ${address}: ${amount} ETO (${balanceLamports} lamports)`,
            },
          ],
        };
      } catch (err: any) {
        return {
          content: [{ type: "text", text: `Error: ${err.message}` }],
          isError: true,
        };
      }
    }
  );

  server.tool(
    "get_account",
    "Get detailed account information for an ETO address. Returns balance, owner program, executable flag, data size, and VM type. Accepts both SVM (base58) and EVM (0x) addresses.",
    {
      address: z.string().describe("Account address (base58 SVM or 0x EVM)"),
      encoding: z
        .enum(["json", "base64", "hex"])
        .default("json")
        .optional()
        .describe("Data encoding format for account data"),
    },
    async ({ address }) => {
      try {
        const account = await rpc.etoGetAccount(address);

        if (!account) {
          return {
            content: [{ type: "text", text: `Account not found: ${address}` }],
          };
        }

        // etoGetAccount may not include lamports; fall back to getBalance for SVM addresses
        // and ethGetBalance for EVM addresses so we never report N/A for a funded account.
        let lamports: bigint | number | undefined =
          account.lamports ?? account.balance ?? account.value?.lamports;
        if (lamports === undefined || lamports === null) {
          try {
            const addrType = detectAddressType(address);
            if (addrType === "evm") {
              const hexWei = await rpc.ethGetBalance(address);
              lamports = BigInt(hexWei);
            } else {
              const result = await rpc.getBalance(address);
              lamports = BigInt(result.value);
            }
          } catch {
            // leave undefined → "N/A"
          }
        }

        const balance =
          lamports !== undefined && lamports !== null
            ? `${lamportsToSol(lamports as any)} ETO (${lamports} lamports)`
            : "N/A";

        const lines = [
          `Address:    ${address}`,
          `Balance:    ${balance}`,
          `Owner:      ${account.owner ?? "N/A"}`,
          `Executable: ${account.executable ?? false}`,
          `Data Size:  ${account.data ? (typeof account.data === "string" ? account.data.length : JSON.stringify(account.data).length) : 0} bytes`,
          `VM Type:    ${account.vmType ?? account.vm_type ?? "svm"}`,
        ];

        return { content: [{ type: "text", text: lines.join("\n") }] };
      } catch (err: any) {
        return {
          content: [{ type: "text", text: `Error: ${err.message}` }],
          isError: true,
        };
      }
    }
  );

  server.tool(
    "get_transaction",
    "Look up a transaction by its hash. Supports both SVM (base58 signature) and EVM (0x-prefixed hash) transactions. Returns status, sender, recipient, value, fee, and logs.",
    { hash: z.string().describe("Transaction hash (base58 SVM or 0x EVM)") },
    async ({ hash }) => {
      try {
        const tx = await rpc.etoGetTransaction(hash);

        if (!tx) {
          return {
            content: [{ type: "text", text: `Transaction not found: ${hash}` }],
          };
        }

        const success = tx.success !== undefined ? tx.success : tx.status === "success" ? true : !tx.err;
        const lines = [
          `Hash:    ${hash}`,
          `VM:      ${tx.vm ?? tx.vmType ?? "N/A"}`,
          `Status:  ${success ? "success" : "failed"}`,
          `From:    ${tx.from ?? tx.feePayer ?? "N/A"}`,
          `To:      ${tx.to ?? tx.recipient ?? "N/A"}`,
          `Value:   ${tx.value !== undefined ? `${lamportsToSol(tx.value)} ETO` : "N/A"}`,
          `Fee:     ${tx.fee !== undefined ? `${lamportsToSol(tx.fee)} ETO` : "N/A"}`,
        ];

        if (tx.logs && tx.logs.length > 0) {
          lines.push(`Logs:`);
          for (const log of tx.logs) {
            lines.push(`  ${log}`);
          }
        }

        return { content: [{ type: "text", text: lines.join("\n") }] };
      } catch (err: any) {
        return {
          content: [{ type: "text", text: `Error: ${err.message}` }],
          isError: true,
        };
      }
    }
  );

  server.tool(
    "get_block",
    "Fetch block details by block height. Returns block hash, timestamp, transaction count, and VM breakdown. Optionally includes full transaction list.",
    {
      height: z.number().describe("Block height / slot number"),
      include_transactions: z
        .boolean()
        .default(false)
        .optional()
        .describe("Whether to include full transaction details"),
    },
    async ({ height, include_transactions }) => {
      try {
        const block = await rpc.etoGetBlock(height);

        if (!block) {
          return {
            content: [{ type: "text", text: `Block not found at height: ${height}` }],
          };
        }

        const ts = block.timestamp
          ? new Date(block.timestamp * 1000).toISOString()
          : "N/A";

        const lines = [
          `Height:    ${height}`,
          `Hash:      ${block.hash ?? block.blockhash ?? "N/A"}`,
          `Timestamp: ${ts}`,
          `TX Count:  ${block.txCount ?? block.transactions?.length ?? 0}`,
        ];

        if (block.vmBreakdown || block.vm_breakdown) {
          const vms = block.vmBreakdown ?? block.vm_breakdown;
          lines.push(`VM Breakdown:`);
          for (const [vm, count] of Object.entries(vms)) {
            lines.push(`  ${vm}: ${count}`);
          }
        }

        if (include_transactions && block.transactions?.length > 0) {
          lines.push(`\nTransactions:`);
          for (const tx of block.transactions) {
            const sig = tx.signature ?? tx.hash ?? tx;
            lines.push(`  ${sig}`);
          }
        }

        return { content: [{ type: "text", text: lines.join("\n") }] };
      } catch (err: any) {
        return {
          content: [{ type: "text", text: `Error: ${err.message}` }],
          isError: true,
        };
      }
    }
  );

  server.tool(
    "search",
    "Search the ETO blockchain by transaction hash, address, block height, or token name. Returns the most relevant result with type classification.",
    {
      query: z
        .string()
        .describe(
          "Search query: tx hash, address (base58 or 0x), block height number, or token name/symbol"
        ),
    },
    async ({ query }) => {
      try {
        const result = await rpc.etoSearch(query);

        if (!result) {
          return {
            content: [{ type: "text", text: `No results found for: ${query}` }],
          };
        }

        const text =
          typeof result === "string"
            ? result
            : JSON.stringify(result, null, 2);

        return {
          content: [{ type: "text", text: `Search results for "${query}":\n\n${text}` }],
        };
      } catch (err: any) {
        return {
          content: [{ type: "text", text: `Error: ${err.message}` }],
          isError: true,
        };
      }
    }
  );

  server.tool(
    "get_chain_stats",
    "Get overall ETO chain statistics including current block height, transactions per second, total transaction count, active validators, and per-VM transaction breakdown.",
    {},
    async () => {
      try {
        const stats = await rpc.etoGetStats();

        if (!stats) {
          return {
            content: [{ type: "text", text: "No stats available" }],
          };
        }

        // Field names match the Rust ChainStats struct in rpc/explorer.rs
        const tpsRecent = stats.tps_recent ?? stats.tpsRecent ?? stats.tps;
        const tpsLifetime = stats.tps_lifetime ?? stats.tpsLifetime;
        const totalTxs = stats.total_transactions ?? stats.totalTransactions ?? stats.totalTxs ?? stats.total_txs;
        const validators = stats.validator_count ?? stats.validatorCount ?? stats.validators;
        const accounts = stats.total_accounts ?? stats.totalAccounts;
        const mempool = stats.mempool_size ?? stats.mempoolSize;
        const lines = [
          `Block Height:   ${stats.block_height ?? stats.blockHeight ?? "N/A"}`,
          `TPS (recent):   ${tpsRecent ?? "N/A"}`,
          `TPS (lifetime): ${tpsLifetime ?? "N/A"}`,
          `Total TXs:      ${totalTxs ?? "N/A"}`,
          `Total Accounts: ${accounts ?? "N/A"}`,
          `Mempool Size:   ${mempool ?? "N/A"}`,
          `Validators:     ${validators ?? "N/A"}`,
          `Chain ID:       ${stats.chain_id ?? stats.chainId ?? "N/A"}`,
        ];

        const vms = stats.vmBreakdown ?? stats.vm_breakdown;
        if (vms) {
          lines.push(`VM Breakdown:`);
          for (const [vm, count] of Object.entries(vms)) {
            lines.push(`  ${vm}: ${count}`);
          }
        }

        return { content: [{ type: "text", text: lines.join("\n") }] };
      } catch (err: any) {
        return {
          content: [{ type: "text", text: `Error: ${err.message}` }],
          isError: true,
        };
      }
    }
  );

  server.tool(
    "get_block_height",
    "Get the current block height (latest slot number) of the ETO chain.",
    {},
    async () => {
      try {
        const height = await rpc.getBlockHeight();
        return {
          content: [{ type: "text", text: `Current block height: ${height}` }],
        };
      } catch (err: any) {
        return {
          content: [{ type: "text", text: `Error: ${err.message}` }],
          isError: true,
        };
      }
    }
  );

  server.tool(
    "get_account_transactions",
    "Get recent transactions for an account address. Supports pagination via limit/offset and optional VM-type filtering to narrow results to SVM, EVM, WASM, Move, or ZK transactions.",
    {
      address: z
        .string()
        .describe("Account address (base58 SVM or 0x EVM)"),
      limit: z
        .number()
        .default(20)
        .optional()
        .describe("Number of transactions to return (default 20)"),
      offset: z
        .number()
        .default(0)
        .optional()
        .describe("Pagination offset (default 0)"),
      vm_filter: z
        .enum(["all", "svm", "evm", "wasm", "move", "zk"])
        .default("all")
        .optional()
        .describe("Filter by VM type: all, svm, evm, wasm, move, or zk"),
    },
    async ({ address, limit, offset, vm_filter }) => {
      try {
        const txs = await rpc.etoGetAccountTransactions(
          address,
          limit ?? 20,
          offset ?? 0
        );

        if (!txs || txs.length === 0) {
          return {
            content: [
              {
                type: "text",
                text: `No transactions found for ${address}`,
              },
            ],
          };
        }

        const filtered =
          vm_filter && vm_filter !== "all"
            ? txs.filter((tx: any) => (tx.vm ?? tx.vmType ?? "svm").toLowerCase() === vm_filter)
            : txs;

        const lines = [
          `Transactions for ${address} (${filtered.length} results, offset=${offset ?? 0}):`,
          "",
        ];

        for (const tx of filtered) {
          const hash = tx.signature ?? tx.hash ?? "N/A";
          const vm = tx.vm ?? tx.vmType ?? "svm";
          const success = tx.success ?? !tx.err ? "OK" : "FAIL";
          const value = tx.value !== undefined
            ? `${lamportsToSol(tx.value)} ETO`
            : "";
          lines.push(`  ${hash}  [${vm}] ${success}${value ? "  " + value : ""}`);
        }

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
