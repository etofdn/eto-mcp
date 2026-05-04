import { config } from "../config.js";
import { rpc } from "../read/rpc-client.js";
import { blockhashCache } from "./blockhash-cache.js";
import { log } from "../utils/logger.js";
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

    // Idempotency check. When two callers race with the same key, both await
    // the same underlying submission, but only the second-and-later callers
    // get a result tagged `coalesced: true` so they can detect the share.
    // The original caller's result remains untouched (no mutation of the
    // shared promise's resolved value).
    if (params.idempotencyKey) {
      const existing = inFlight.get(params.idempotencyKey);
      if (existing) return existing.then((r) => ({ ...r, coalesced: true }));
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
        // Submit — FN-090: forward commitment so the node processes the tx
        // at the requested level. Omit config object when no commitment is
        // set to preserve backward-compatible call shape.
        const commitmentCfg = params.commitment ? { commitment: params.commitment } : undefined;
        const signature = await rpc.sendTransaction(params.signedTxBase64, commitmentCfg);

        // Poll for confirmation
        const result = await this.pollConfirmation(
          signature,
          timeout - (Date.now() - startTime),
          params.vm,
          commitmentCfg,
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
    commitmentCfg?: { commitment?: "submitted" | "confirmed" | "finalized" },
  ): Promise<TransactionResult> {
    const deadline = Date.now() + Math.max(remainingMs, 5000);
    // FN-197: count consecutive non-"not found" RPC failures. A single
    // transient blip (e.g. brief network glitch) should not abort the
    // polling loop, but a sustained failure window must surface to the
    // caller so they don’t spin silently until timeout. Reset on any
    // successful round-trip (whether tx is null or a receipt).
    let consecutiveErrors = 0;

    while (Date.now() < deadline) {
      try {
        // FN-090: forward commitment so the node returns the tx at the
        // requested level, preventing poll timeouts for txs visible only
        // at a higher commitment level than the node default.
        const tx: any = await rpc.getTransaction(signature, commitmentCfg);
        consecutiveErrors = 0;
        if (tx) {
          // The receipt arrives whether the tx succeeded or failed; check
          // success/error before reporting "confirmed". Otherwise every failed
          // on-chain instruction looks like a successful submission to callers.
          const success = tx.success !== false && !tx.error && (tx.meta?.err == null);
          if (!success) {
            const errMsg = tx.error ?? tx.meta?.err ?? "transaction failed on-chain";
            return {
              status: "failed",
              signature,
              block_height: tx.slot ?? tx.blockHeight,
              timestamp: tx.blockTime,
              gas_used: tx.meta?.computeUnitsConsumed ?? tx.computeUnitsUsed,
              fee: tx.meta?.fee ?? tx.fee,
              retries: 0,
              latency_ms: 0,
              error: {
                code: "CHAIN_EXEC",
                raw_message: String(errMsg),
                explanation: String(errMsg),
                recovery_hints: [],
                retryable: false,
              },
            };
          }
          return {
            status: "confirmed",
            signature,
            block_height: tx.slot ?? tx.blockHeight,
            timestamp: tx.blockTime,
            gas_used: tx.meta?.computeUnitsConsumed ?? tx.computeUnitsUsed,
            fee: tx.meta?.fee ?? tx.fee,
            retries: 0,
            latency_ms: 0,
          };
        }
      } catch (e: any) {
        // FN-197 / FN-099: only swallow "transaction not found yet" — that
        // is the expected polling case. Real RPC/network failures are
        // tolerated up to `config.tx.maxPollErrors` consecutive occurrences
        // before bubbling, which gives roughly
        // `maxPollErrors * confirmationPollMs` of tolerance for transient
        // node hiccups. Anything beyond that surfaces to the caller so
        // the loop never spins silently until timeout.
        const msg = String(e?.message ?? e ?? "");
        const notFound =
          /not\s*found|unknown\s*transaction|invalid\s*signature/i.test(msg) ||
          /JSON-RPC\s*error\s*-32004/.test(msg) || // common "tx not found" code
          /JSON-RPC\s*error\s*-32602/.test(msg); // invalid params (sig not seen yet)
        if (notFound) {
          // Expected polling case — reset the counter and keep polling.
          consecutiveErrors = 0;
        } else {
          consecutiveErrors++;
          if (consecutiveErrors >= config.tx.maxPollErrors) {
            // Threshold reached: the node looks sick. Bubble to _submit’s
            // outer retry/non-retryable classifier.
            throw e;
          }
          log("warn", "rpc", "pollConfirmation transient error", {
            attempt: consecutiveErrors,
            msg,
          });
        }
      }
      await new Promise<void>((r) => setTimeout(r, config.tx.confirmationPollMs));
    }

    return { status: "timeout", signature, retries: 0, latency_ms: 0 };
  }
}

export const submitter = new TransactionSubmitter();
