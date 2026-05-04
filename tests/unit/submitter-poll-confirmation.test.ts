/**
 * Vitest unit tests for `TransactionSubmitter.pollConfirmation` error
 * handling (FN-197).
 *
 * Closes the FN-097 error-masking case where `pollConfirmation` had a bare
 * `catch {}` that hid every `getTransaction` failure, making real
 * network/JSON-RPC errors indistinguishable from "not found yet, keep
 * polling". After FN-197, only "not found" errors stay in the polling
 * loop; real errors are surfaced after `config.tx.maxPollErrors`
 * consecutive occurrences.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// maxPollErrors matches the default in config.ts (ETO_TX_MAX_POLL_ERRORS default = 3).
const MAX_POLL_ERRORS = 3;

// Silence rpc-client and submitter logging noise.
vi.mock("../../src/utils/logger.js", () => ({
  log: () => {},
  timeTool: async <T>(_n: string, fn: () => Promise<T>) => fn(),
  timeRpc: async <T>(_n: string, fn: () => Promise<T>) => fn(),
  logToolCall: () => {},
  recordToolStat: () => {},
  getToolStats: () => "",
  dumpStats: () => {},
}));

import { rpc } from "../../src/read/rpc-client.js";
import { TransactionSubmitter } from "../../src/write/submitter.js";

/* -------------------------------------------------------------------------- */
/* Helpers                                                                    */
/* -------------------------------------------------------------------------- */

// `pollConfirmation` is `private`. We bracket-access through `any` to call
// it directly without exporting a test seam from production code.
function callPoll(
  submitter: TransactionSubmitter,
  sig: string,
  remainingMs: number,
  vm: "svm" | "evm" = "svm",
): Promise<any> {
  return (submitter as any).pollConfirmation(sig, remainingMs, vm);
}

const SIG = "TestSig" + "1".repeat(80);

/* -------------------------------------------------------------------------- */
/* Tests                                                                      */
/* -------------------------------------------------------------------------- */

describe("TransactionSubmitter.pollConfirmation — FN-197 error handling", () => {
  let submitter: TransactionSubmitter;
  let getTxSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    submitter = new TransactionSubmitter();
    getTxSpy = vi.spyOn(rpc, "getTransaction");
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("keeps polling on 'not found' errors and resolves confirmed when the receipt arrives", async () => {
    let calls = 0;
    getTxSpy.mockImplementation(async () => {
      calls++;
      if (calls <= 5) {
        throw new Error("JSON-RPC error -32004: tx not found");
      }
      return { slot: 100, meta: { err: null } };
    });

    const result = await callPoll(submitter, SIG, 1000);
    expect(result.status).toBe("confirmed");
    expect(result.signature).toBe(SIG);
    expect(result.block_height).toBe(100);
    // 5 not-found throws, then a receipt → 6 total calls
    expect(calls).toBe(6);
  });

  it("surfaces a real network error after `maxPollErrors` consecutive failures", async () => {
    getTxSpy.mockImplementation(async () => {
      throw new Error("ECONNREFUSED 127.0.0.1:8899");
    });

    await expect(callPoll(submitter, SIG, 1000)).rejects.toThrow(/ECONNREFUSED/);
    // Exactly maxPollErrors throws were issued before the bubble.
    expect(getTxSpy).toHaveBeenCalledTimes(MAX_POLL_ERRORS);
  });

  it("resets the consecutive-error counter on a successful round-trip (even when tx is null)", async () => {
    let calls = 0;
    getTxSpy.mockImplementation(async () => {
      calls++;
      if (calls === 1) throw new Error("ECONNREFUSED transient");
      if (calls === 2) return null; // success round-trip → resets counter
      if (calls === 3) return null; // success round-trip → still 0
      return { slot: 100, meta: { err: null } };
    });

    const result = await callPoll(submitter, SIG, 1000);
    expect(result.status).toBe("confirmed");
    expect(calls).toBe(4);
  });

  it("returns a failed CHAIN_EXEC TransactionResult when the receipt has meta.err", async () => {
    getTxSpy.mockResolvedValueOnce({
      slot: 100,
      meta: { err: "InstructionError" },
    });

    const result = await callPoll(submitter, SIG, 1000);
    expect(result.status).toBe("failed");
    expect(result.error?.code).toBe("CHAIN_EXEC");
    expect(result.error?.raw_message).toContain("InstructionError");
  });

  it("returns timeout when the polling deadline elapses with all-null responses", async () => {
    getTxSpy.mockResolvedValue(null);

    // Spy on Date.now so we can fast-forward past the (5-second floor)
    // deadline after a single polling iteration without waiting wall-clock
    // time. The first call captures the "start" used for the deadline; the
    // second-and-later calls return a value past the deadline so the
    // `while (Date.now() < deadline)` check exits the loop.
    const realStart = Date.now();
    let nowCalls = 0;
    const nowSpy = vi.spyOn(Date, "now").mockImplementation(() => {
      nowCalls++;
      return nowCalls <= 1 ? realStart : realStart + 10_000;
    });

    try {
      const result = await callPoll(submitter, SIG, 100);
      expect(result.status).toBe("timeout");
      expect(result.signature).toBe(SIG);
    } finally {
      nowSpy.mockRestore();
    }
  });
});
