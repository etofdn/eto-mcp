import { config } from "../config.js";
import type { SimulationResult } from "../models/index.js";

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
          params: [txBase64, { encoding: "base64" }],
        }),
      });

      const json = await response.json() as { result?: { value?: { err: any; unitsConsumed?: number; logs?: string[] } } };
      const value = json.result?.value;

      return {
        success: value?.err === null,
        state_changes: [],
        token_movements: [],
        gas_used: value?.unitsConsumed || 0,
        fee: 5000, // base fee
        logs: value?.logs || [],
        error: value?.err ? JSON.stringify(value.err) : undefined,
        summary: value?.err
          ? `Simulation failed: ${JSON.stringify(value.err)}`
          : `Simulation succeeded. Estimated compute: ${value?.unitsConsumed ?? "unknown"} CU.`,
      };
    } catch {
      // Fallback: return a basic "we couldn't simulate" result
      return {
        success: true,
        state_changes: [],
        token_movements: [],
        gas_used: 0,
        fee: 5000,
        logs: [],
        summary: "Simulation not available. Transaction will be submitted directly.",
      };
    }
  }
}

export const simulator = new SimulationEngine();
