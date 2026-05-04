import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { rpc } from "../read/rpc-client.js";
import { solToLamports } from "../utils/units.js";

export function registerDevnetTools(server: McpServer): void {
  server.tool(
    "airdrop",
    "Request a devnet/testnet ETO airdrop to an address. Maximum 100 ETO per request. Uses the active wallet address if none is specified. Returns the transaction signature on success.",
    {
      address: z
        .string()
        .optional()
        .describe("Recipient address (base58 SVM or 0x EVM). Uses active wallet if not specified."),
      amount: z
        .string()
        .default("10")
        .optional()
        .describe("Amount of ETO to airdrop (max 100, default 10)"),
    },
    async ({ address, amount }) => {
      try {
        const amountNum = parseFloat(amount ?? "10");

        if (isNaN(amountNum) || amountNum <= 0) {
          return {
            content: [{ type: "text", text: "Error: amount must be a positive number" }],
            isError: true,
          };
        }

        if (amountNum > 100) {
          return {
            content: [{ type: "text", text: "Error: airdrop amount cannot exceed 100 ETO" }],
            isError: true,
          };
        }

        if (!address) {
          return {
            content: [{ type: "text", text: "Error: no address specified and no active wallet available" }],
            isError: true,
          };
        }

        const lamports = Number(solToLamports(String(amountNum)));
        const sig = await rpc.faucet(address, lamports);

        // FN-098: do not report success on the bare faucet sig — the
        // local node may run a mock/phantom faucet (FN-196). Poll
        // getTransaction until the sig actually lands, with a 30s
        // ceiling. If it never lands, fail loudly so the caller
        // doesn't think their balance was credited.
        const deadline = Date.now() + 30_000;
        let landed = false;
        let lastErr: string | null = null;
        while (Date.now() < deadline) {
          try {
            const tx: any = await rpc.getTransaction(sig);
            if (tx) {
              const ok = tx.success !== false && !tx.error && tx.meta?.err == null;
              if (!ok) {
                lastErr = String(tx.error ?? tx.meta?.err ?? "transaction failed on-chain");
                break;
              }
              landed = true;
              break;
            }
          } catch (e: any) {
            const msg = String(e?.message ?? e ?? "");
            if (!/not\s*found|unknown\s*transaction|invalid\s*signature/i.test(msg)) {
              lastErr = msg;
              break;
            }
          }
          await new Promise<void>((r) => setTimeout(r, 500));
        }

        if (!landed) {
          return {
            content: [{
              type: "text",
              text:
                lastErr
                  ? `Error: airdrop failed — ${lastErr} (sig: ${sig})`
                  : `Error: airdrop signature ${sig} did not land within 30s. The local node may run a mock faucet — see FN-196.`,
            }],
            isError: true,
          };
        }

        return {
          content: [
            {
              type: "text",
              text: `Airdropped ${amountNum} ETO to ${address}. Signature: ${sig} (confirmed)`,
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
    "get_health",
    "Check the health and connectivity status of the ETO RPC node. Returns 'ok' if the node is healthy and reachable.",
    {},
    async () => {
      try {
        const result = await rpc.getHealth();
        return {
          content: [{ type: "text", text: `ETO node status: ${result}` }],
        };
      } catch (err: any) {
        return {
          content: [{ type: "text", text: `Error: ${err.message}` }],
          isError: true,
        };
      }
    }
  );
}
