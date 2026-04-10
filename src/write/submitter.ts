import { config } from "../config.js";
import { rpc } from "../read/rpc-client.js";
import { blockhashCache } from "./blockhash-cache.js";
import type { TransactionResult } from "../models/index.js";

export interface SubmitParams {
  signedTxBase64: string;
  vm: "svm" | "evm" | "wasm" | "move" | "zk";
  idempotencyKey?: string;
  timeoutMs?: number;
  commitment?: "submitted" | "confirmed" | "finalized";
}

// In-flight tracking for idempotency (in-memory for Phase 1, Redis later)
const inFlight = new Map<string, Promise<TransactionResult>>();
const inFlightTimestamps = new Map<string, number>();

// Clean up stale entries older than 10 minutes
setInterval(() => {
  const cutoff = Date.now() - 10 * 60 * 1000;
  for (const [key, ts] of inFlightTimestamps) {
    if (ts < cutoff) {
      inFlight.delete(key);
      inFlightTimestamps.delete(key);
    }
  }
}, 60_000).unref();

export class TransactionSubmitter {
  async submitAndConfirm(params: SubmitParams): Promise<TransactionResult> {
    const timeout = params.timeoutMs || config.tx.defaultTimeoutMs;

    // Idempotency check
    if (params.idempotencyKey) {
      const existing = inFlight.get(params.idempotencyKey);
      if (existing) return existing;
    }

    const promise = this._submit(params, timeout);

    if (params.idempotencyKey) {
      inFlight.set(params.idempotencyKey, promise);
      inFlightTimestamps.set(params.idempotencyKey, Date.now());
      promise.finally(() => {
        // Clean up after 5 minutes
        setTimeout(() => {
          inFlight.delete(params.idempotencyKey!);
          inFlightTimestamps.delete(params.idempotencyKey!);
        }, 300_000);
      });
    }

    return promise;
  }

  private async _submit(params: SubmitParams, timeout: number): Promise<TransactionResult> {
    const startTime = Date.now();
    let retries = 0;
    let lastError: string | undefined;

    while (retries <= config.tx.maxRetries) {
      try {
        // Submit
        const signature = await rpc.sendTransaction(params.signedTxBase64);

        // Poll for confirmation
        const result = await this.pollConfirmation(
          signature,
          timeout - (Date.now() - startTime),
          params.vm,
        );
        result.retries = retries;
        result.latency_ms = Date.now() - startTime;
        return result;
      } catch (err: any) {
        const errMsg = err?.message || String(err);
        lastError = errMsg;

        // Retryable errors
        if (errMsg.includes("BlockhashNotFound") || errMsg.includes("blockhash")) {
          retries++;
          await blockhashCache.refresh();
          continue;
        }
        if (errMsg.includes("NonceTooLow") || errMsg.includes("nonce")) {
          retries++;
          continue;
        }

        // Non-retryable
        return {
          status: "failed",
          signature: "",
          error: {
            code: "CHAIN_005",
            raw_message: errMsg,
            explanation: errMsg,
            recovery_hints: [],
            retryable: false,
          },
          retries,
          latency_ms: Date.now() - startTime,
        };
      }
    }

    return {
      status: "failed",
      signature: "",
      error: {
        code: "CHAIN_999",
        raw_message: lastError || "Max retries exceeded",
        explanation: `Transaction failed after ${retries} retries: ${lastError}`,
        recovery_hints: ["Try again later"],
        retryable: true,
      },
      retries,
      latency_ms: Date.now() - startTime,
    };
  }

  private async pollConfirmation(
    signature: string,
    remainingMs: number,
    _vm: string,
  ): Promise<TransactionResult> {
    const deadline = Date.now() + Math.max(remainingMs, 5000);

    while (Date.now() < deadline) {
      try {
        const tx = await rpc.getTransaction(signature);
        if (tx) {
          return {
            status: "confirmed",
            signature,
            block_height: tx.slot || tx.blockHeight,
            timestamp: tx.blockTime,
            gas_used: tx.meta?.computeUnitsConsumed,
            fee: tx.meta?.fee,
            retries: 0,
            latency_ms: 0,
          };
        }
      } catch {
        // Transaction not found yet, keep polling
      }
      await new Promise<void>((r) => setTimeout(r, config.tx.confirmationPollMs));
    }

    return { status: "timeout", signature, retries: 0, latency_ms: 0 };
  }
}

export const submitter = new TransactionSubmitter();
