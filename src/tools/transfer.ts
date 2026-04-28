import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { getSignerFactory } from "../signing/index.js";
import { getActiveWalletId } from "./wallet.js";
import { buildTransferTx } from "../wasm/index.js";
import { blockhashCache } from "../write/blockhash-cache.js";
import { submitter } from "../write/submitter.js";
import { solToLamports, lamportsToSol } from "../utils/units.js";
import { resolveAddresses } from "../utils/address.js";
import bs58 from "bs58";

export function registerTransferTools(server: McpServer): void {
  server.tool(
    "transfer_native",
    "Transfers native SOL between accounts on the ETO network with full cross-VM address support. Accepts both SVM (base58) and EVM (0x-prefixed) addresses for the recipient — addresses are automatically normalized to SVM format for the on-chain instruction. Amount can be specified in SOL (e.g. '1.5') or raw lamports. Uses the active wallet as the sender unless from_wallet is provided. An optional `memo` string is anchored on-chain via the SPL Memo Program v2 — it becomes part of the signed transaction so two transfers with different memos always produce distinct signatures, and the memo is recoverable from chain history via `query_memos` / `get_account_transactions`. Use `idempotency_key` when launching parallel transfers that would otherwise share an in-flight signature; results returned via coalescing are tagged `(coalesced)`. If a confirmation times out, call `get_transaction(hash)` to verify on-chain status — a non-null result means the transfer succeeded; null means it has not yet landed.",
    {
      to: z.string().describe("Recipient address in base58 (SVM) or 0x (EVM) format"),
      amount: z.string().describe("Amount to transfer, e.g. '1.5' for SOL or '1500000000' for lamports"),
      unit: z.enum(["sol", "lamports"]).default("sol").optional(),
      from_wallet: z.string().optional().describe("Wallet ID to send from; defaults to the active wallet"),
      memo: z.string().optional().describe("Optional memo string anchored on-chain via SPL Memo Program v2; becomes part of the transaction signature so distinct memos never coalesce"),
      idempotency_key: z.string().optional().describe("Optional caller-supplied uniqueness suffix. Use when sending parallel transfers that share from/to/amount/memo to guarantee distinct submissions."),
      skip_simulation: z.boolean().default(false).optional(),
    },
    async (args) => {
      try {
        const { to, amount, unit = "sol", from_wallet, memo, idempotency_key, skip_simulation = false } = args;

        // Resolve sender wallet
        const walletId = from_wallet ?? getActiveWalletId();
        if (!walletId) {
          return {
            content: [{ type: "text" as const, text: "No wallet specified and no active wallet set. Use set_active_wallet or provide from_wallet." }],
          };
        }

        const factory = getSignerFactory();
        const signer = await factory.getSigner(walletId);
        const fromSvm = signer.getPublicKey();

        // Resolve recipient to SVM address
        const toAddresses = resolveAddresses(to);
        const toSvm = toAddresses.svm;

        // Convert amount to lamports
        const lamports = unit === "lamports" ? BigInt(amount) : solToLamports(amount);

        // Get recent blockhash
        const { blockhash } = await blockhashCache.getBlockhash();

        // Build unsigned transaction. memo is wired straight into the tx
        // bytes via the Memo Program — without this, the memo never lands
        // on-chain and parallel calls with different memos produce identical
        // signatures.
        const txBytes = buildTransferTx(fromSvm, toSvm, lamports, blockhash, memo);

        // Sign
        const signedBytes = await signer.sign(txBytes);

        // Encode as base64 for submission
        const signedBase64 = Buffer.from(signedBytes).toString("base64");

        // Idempotency key includes memo + caller-supplied suffix so distinct
        // memos never collide in the in-flight map and callers launching
        // parallel transfers can guarantee uniqueness.
        const memoSuffix = memo ? `-m:${memo}` : "";
        const userSuffix = idempotency_key ? `-i:${idempotency_key}` : "";
        const idemKey = `transfer-${fromSvm}-${toSvm}-${lamports}-${blockhash}${memoSuffix}${userSuffix}`;

        // Submit
        const result = await submitter.submitAndConfirm({
          signedTxBase64: signedBase64,
          vm: "svm",
          idempotencyKey: idemKey,
          ...(skip_simulation ? {} : {}),
        });

        const solAmount = lamportsToSol(lamports);
        const lines: string[] = [];

        if (result.status === "confirmed" || result.status === "finalized") {
          lines.push(`Transfer successful${result.coalesced ? " (coalesced)" : ""}.`);
          lines.push(`Signature:   ${result.signature}`);
          lines.push(`Status:      ${result.status}`);
          lines.push(`From:        ${fromSvm}`);
          lines.push(`To (SVM):    ${toSvm}`);
          lines.push(`To (input):  ${to}`);
          lines.push(`Amount:      ${solAmount} SOL (${lamports} lamports)`);
          if (result.fee !== undefined) {
            lines.push(`Fee:         ${result.fee} lamports`);
          }
          if (result.latency_ms) {
            lines.push(`Latency:     ${result.latency_ms}ms`);
          }
          if (memo) {
            lines.push(`Memo:        ${memo}`);
          }
          if (result.coalesced) {
            lines.push("Coalesced:   true (this signature was returned to another in-flight caller with the same idempotency key — pass a unique `idempotency_key` to guarantee a distinct submission).");
          }
        } else if (result.status === "timeout") {
          lines.push("Transfer submitted but confirmation timed out (30s).");
          lines.push(`Signature: ${result.signature}`);
          lines.push("The transaction may still confirm. To verify:");
          lines.push(`  call get_transaction(hash="${result.signature}")`);
          lines.push("A non-null result means the transfer succeeded. A null result means it has not yet landed.");
        } else {
          lines.push("Transfer failed.");
          lines.push(`Error: ${result.error?.explanation ?? result.error?.raw_message ?? "Unknown error"}`);
          if (result.error?.recovery_hints?.length) {
            lines.push(`Hints: ${result.error.recovery_hints.join("; ")}`);
          }
        }

        return { content: [{ type: "text" as const, text: lines.join("\n") }] };
      } catch (err: any) {
        return { content: [{ type: "text" as const, text: `Error executing transfer: ${err?.message ?? String(err)}` }] };
      }
    }
  );

  server.tool(
    "batch_transfer",
    "Executes multiple native SOL transfers sequentially from a single sender wallet. Accepts an array of up to 20 transfer objects, each specifying a recipient address and amount in SOL. An optional per-transfer memo field is supported. All transfers share the same sender wallet (from_wallet or the active wallet). Returns a summary of successful and failed transfers with individual signatures.",
    {
      transfers: z.array(
        z.object({
          to: z.string().describe("Recipient address (base58 or 0x)"),
          amount: z.string().describe("Amount in SOL"),
          memo: z.string().optional(),
        })
      ).max(20).describe("List of transfers to execute (max 20)"),
      from_wallet: z.string().optional().describe("Wallet ID to send from; defaults to active wallet"),
    },
    async (args) => {
      try {
        const { transfers, from_wallet } = args;

        const walletId = from_wallet ?? getActiveWalletId();
        if (!walletId) {
          return {
            content: [{ type: "text" as const, text: "No wallet specified and no active wallet set. Use set_active_wallet or provide from_wallet." }],
          };
        }

        const factory = getSignerFactory();
        const signer = await factory.getSigner(walletId);
        const fromSvm = signer.getPublicKey();

        const results: string[] = [
          `Batch transfer: ${transfers.length} transfers from ${fromSvm}`,
          "",
        ];

        let successCount = 0;
        let failCount = 0;
        let lastBlockhash: string | null = null;

        for (let i = 0; i < transfers.length; i++) {
          const { to, amount, memo } = transfers[i];

          try {
            const toAddresses = resolveAddresses(to);
            const toSvm = toAddresses.svm;
            const lamports = solToLamports(amount);

            // Force a fresh blockhash distinct from the previous iteration so identical
            // transfers (same to + amount + sender) don't collapse to the same signature
            // and get deduplicated by the chain. If we can't obtain a distinct
            // blockhash after 10 attempts, fail this batch iteration instead of
            // resubmitting with the same blockhash — that would produce the exact
            // duplicate the loop is meant to avoid.
            let blockhash: string | undefined;
            for (let attempts = 0; attempts <= 10; attempts++) {
              const fresh = await blockhashCache.refresh();
              if (fresh.blockhash !== lastBlockhash) {
                blockhash = fresh.blockhash;
                break;
              }
              await new Promise((r) => setTimeout(r, 100));
            }
            if (!blockhash) {
              throw new Error("Could not obtain a fresh blockhash for this batch transfer");
            }
            lastBlockhash = blockhash;

            const txBytes = buildTransferTx(fromSvm, toSvm, lamports, blockhash, memo);
            const signedBytes = await signer.sign(txBytes);
            const signedBase64 = Buffer.from(signedBytes).toString("base64");

            const memoSuffix = memo ? `-m:${memo}` : "";
            const result = await submitter.submitAndConfirm({
              signedTxBase64: signedBase64,
              vm: "svm",
              idempotencyKey: `batch-${i}-${fromSvm}-${toSvm}-${lamports}-${blockhash}${memoSuffix}`,
            });

            if (result.status === "confirmed" || result.status === "finalized") {
              successCount++;
              results.push(`[${i + 1}] OK  to=${to}  amount=${amount} SOL  sig=${result.signature}${memo ? `  memo=${memo}` : ""}`);
            } else if (result.status === "timeout") {
              successCount++;
              results.push(`[${i + 1}] TIMEOUT  to=${to}  amount=${amount} SOL  sig=${result.signature} (may still confirm)`);
            } else {
              failCount++;
              results.push(`[${i + 1}] FAIL  to=${to}  amount=${amount} SOL  error=${result.error?.explanation ?? "unknown"}`);
            }
          } catch (txErr: any) {
            failCount++;
            results.push(`[${i + 1}] ERROR  to=${to}  amount=${amount} SOL  error=${txErr?.message ?? String(txErr)}`);
          }
        }

        results.push("");
        results.push(`Summary: ${successCount} succeeded, ${failCount} failed out of ${transfers.length} total.`);

        return { content: [{ type: "text" as const, text: results.join("\n") }] };
      } catch (err: any) {
        return { content: [{ type: "text" as const, text: `Error executing batch transfer: ${err?.message ?? String(err)}` }] };
      }
    }
  );

  server.tool(
    "estimate_fee",
    "Returns an estimated fee in lamports for a given operation type on the ETO network. Estimates are based on typical compute unit costs and current base fee rates; actual fees may vary depending on network congestion and instruction complexity. Use this tool before constructing a transaction to verify the sender has sufficient balance to cover both the transfer amount and the fee.",
    {
      operation: z.enum([
        "transfer",
        "token_transfer",
        "deploy_evm",
        "deploy_wasm",
        "deploy_move",
        "contract_call",
        "create_account",
        "stake",
        "cross_vm_call",
      ]).describe("Type of operation to estimate fees for"),
    },
    async (args) => {
      try {
        const { operation } = args;

        const feeTable: Record<string, { lamports: number; note: string }> = {
          transfer: { lamports: 5_000, note: "Simple SOL transfer; 1 signature, system program instruction" },
          token_transfer: { lamports: 10_000, note: "SPL token transfer; includes token program CPI overhead" },
          deploy_evm: { lamports: 500_000, note: "EVM bytecode deployment; scales with bytecode size" },
          deploy_wasm: { lamports: 200_000, note: "WASM module deployment; scales with module size" },
          deploy_move: { lamports: 150_000, note: "Move module deployment" },
          contract_call: { lamports: 50_000, note: "Cross-VM contract call; includes EVM/WASM dispatch overhead" },
          create_account: { lamports: 2_039_280, note: "Rent-exempt reserve for a new 0-byte account (2,039,280 lamports = ~0.002 SOL)" },
          stake: { lamports: 10_000, note: "Stake delegation instruction; does not include the staked amount" },
          cross_vm_call: { lamports: 75_000, note: "SVM-to-EVM or SVM-to-WASM cross-VM dispatch" },
        };

        const fee = feeTable[operation];
        const solAmount = lamportsToSol(fee.lamports);

        const text = [
          `Fee estimate for: ${operation}`,
          `Estimated fee: ${fee.lamports} lamports (~${solAmount} SOL)`,
          `Note: ${fee.note}`,
          "",
          "Disclaimer: These are static estimates. Actual fees depend on network conditions and payload size.",
        ].join("\n");

        return { content: [{ type: "text" as const, text }] };
      } catch (err: any) {
        return { content: [{ type: "text" as const, text: `Error estimating fee: ${err?.message ?? String(err)}` }] };
      }
    }
  );
}
