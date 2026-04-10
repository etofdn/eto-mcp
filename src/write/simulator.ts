import { config } from "../config.js";
import type { SimulationResult, StateChange, TokenMovement } from "../models/index.js";
import bs58 from "bs58";

/**
 * Extract account public keys from a base64-encoded SVM transaction.
 * Returns an empty array if the transaction cannot be decoded.
 */
function extractAccountKeys(txBase64: string): string[] {
  try {
    const txBytes = Buffer.from(txBase64, "base64");
    let offset = 0;

    // Read compact-u16 signature count
    let sigCount = 0;
    let shift = 0;
    while (offset < txBytes.length) {
      const byte = txBytes[offset++];
      sigCount |= (byte & 0x7f) << shift;
      if ((byte & 0x80) === 0) break;
      shift += 7;
    }

    // Skip signatures (each is 64 bytes)
    offset += sigCount * 64;

    // Message header: 3 bytes (numRequiredSignatures, numReadonlySigned, numReadonlyUnsigned)
    offset += 3;

    // Read compact-u16 account key count
    let accountCount = 0;
    shift = 0;
    while (offset < txBytes.length) {
      const byte = txBytes[offset++];
      accountCount |= (byte & 0x7f) << shift;
      if ((byte & 0x80) === 0) break;
      shift += 7;
    }

    const keys: string[] = [];
    for (let i = 0; i < accountCount && offset + 32 <= txBytes.length; i++) {
      const pubkeyBytes = txBytes.subarray(offset, offset + 32);
      keys.push(bs58.encode(pubkeyBytes));
      offset += 32;
    }
    return keys;
  } catch {
    return [];
  }
}

interface SimulatedAccountInfo {
  lamports: number;
  data: string[];
  owner: string;
  executable: boolean;
  rentEpoch: number;
}

export class SimulationEngine {
  /**
   * Simulate a transaction without executing it.
   * Calls the ETO node's simulateTransaction RPC (if available),
   * falling back to a basic "not available" result.
   */
  async simulate(txBase64: string, vm: string = "svm"): Promise<SimulationResult> {
    try {
      const response = await fetch(config.etoRpcUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "simulateTransaction",
          params: [txBase64, { encoding: "base64", accounts: { encoding: "base64", addresses: [] } }],
        }),
      });

      const json = await response.json() as {
        result?: {
          value?: {
            err: unknown;
            unitsConsumed?: number;
            logs?: string[];
            accounts?: (SimulatedAccountInfo | null)[];
          };
        };
      };
      const value = json.result?.value;

      // Extract real account addresses from the transaction
      const accountKeys = extractAccountKeys(txBase64);

      // Parse state_changes from account diffs
      const state_changes: StateChange[] = [];
      if (value?.accounts) {
        for (let i = 0; i < value.accounts.length; i++) {
          const post = value.accounts[i];
          if (!post) continue;
          const addr = accountKeys[i] ?? `account_${i}`;
          state_changes.push({
            address: addr,
            field: "balance",
            before: "0",
            after: String(post.lamports),
            description: `Account ${addr} lamports: ${post.lamports}`,
          });
          if (post.data?.[0]) {
            state_changes.push({
              address: addr,
              field: "data",
              before: "",
              after: post.data[0],
              description: `Account ${addr} data updated`,
            });
          }
        }
      }

      // Parse token_movements from Transfer log entries
      const token_movements: TokenMovement[] = [];
      const logs = value?.logs || [];
      for (const log of logs) {
        // Match "Program log: Transfer from <from> to <to> of <amount>"
        const transferMatch = log.match(/Transfer.*?(\w{32,44}).*?(\w{32,44}).*?(\d+)/);
        if (transferMatch) {
          token_movements.push({
            token: "native",
            from: transferMatch[1],
            to: transferMatch[2],
            amount: transferMatch[3],
            decimals: 9,
            human_amount: (parseInt(transferMatch[3]) / 1e9).toFixed(9),
          });
        }
      }

      return {
        success: value?.err === null,
        state_changes,
        token_movements,
        gas_used: value?.unitsConsumed || 0,
        fee: 5000, // base fee
        logs,
        error: value?.err ? JSON.stringify(value.err) : undefined,
        summary: value?.err
          ? `Simulation failed: ${JSON.stringify(value.err)}`
          : `Simulation succeeded. Estimated compute: ${value?.unitsConsumed ?? "unknown"} CU.`,
      };
    } catch (error: unknown) {
      const errMsg = error instanceof Error ? error.message : String(error);
      return {
        success: false,
        state_changes: [],
        token_movements: [],
        gas_used: 0,
        fee: 5000,
        logs: [`Simulation unavailable: ${errMsg}`],
        summary: "Simulation unavailable.",
      };
    }
  }
}

export const simulator = new SimulationEngine();
