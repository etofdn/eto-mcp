import { describe, test, expect, vi, beforeEach, afterEach } from "vitest";

// `src/config.ts` currently has duplicate `export` declarations (a pre-existing
// merge artifact tracked separately). esbuild refuses to transform it, which
// would otherwise break this test the moment it pulls in `submitter.js`.
// Stub the module with the minimum surface our submitter touches so the
// coalescing path can be exercised in isolation.
vi.mock("../../src/config.js", () => ({
  config: {
    tx: {
      defaultTimeoutMs: 30_000,
      maxRetries: 3,
      confirmationPollMs: 400,
    },
  },
}));

// `rpc-client` and `blockhash-cache` are pulled in transitively by the
// submitter but should never be invoked — `_submit` is fully stubbed in
// every test below. Provide minimal stand-ins so the import graph resolves.
vi.mock("../../src/read/rpc-client.js", () => ({
  rpc: {
    sendTransaction: vi.fn(),
    getTransaction: vi.fn(),
  },
}));
vi.mock("../../src/write/blockhash-cache.js", () => ({
  blockhashCache: {
    refresh: vi.fn(),
    getBlockhash: vi.fn(),
  },
}));

const { TransactionSubmitter } = await import("../../src/write/submitter.js");
import type { TransactionResult } from "../../src/models/index.js";

/**
 * Regression suite for the parallel-coalescing semantics of
 * `TransactionSubmitter.submitAndConfirm`. We stub the inner `_submit`
 * via `vi.spyOn` so no RPC calls occur — the focus is the in-flight
 * `Map` and the `coalesced` flag handling on the result.
 */
describe("TransactionSubmitter idempotency coalescing", () => {
  let submitter: TransactionSubmitter;
  // Track resolvers so each test can release `_submit` deterministically.
  let pending: Array<(r: TransactionResult) => void>;
  let submitSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    submitter = new TransactionSubmitter();
    pending = [];
    // Stub the private `_submit` — each invocation returns a new deferred
    // promise whose resolver is pushed onto `pending`. This guarantees
    // tests can fire two `submitAndConfirm` calls back-to-back and
    // observe the in-flight entry before resolving.
    submitSpy = vi
      .spyOn(submitter as any, "_submit")
      .mockImplementation(() => {
        return new Promise<TransactionResult>((resolve) => {
          pending.push(resolve);
        });
      });
  });

  afterEach(() => {
    submitSpy.mockRestore();
  });

  function baseParams(idempotencyKey?: string) {
    return {
      signedTxBase64: "AA==",
      vm: "svm" as const,
      ...(idempotencyKey ? { idempotencyKey } : {}),
    };
  }

  function makeResult(signature: string): TransactionResult {
    return {
      status: "confirmed",
      signature,
      retries: 0,
      latency_ms: 0,
    };
  }

  test("second caller with same idempotency key gets coalesced=true; original is untouched", async () => {
    const p1 = submitter.submitAndConfirm(baseParams("key-A"));
    const p2 = submitter.submitAndConfirm(baseParams("key-A"));

    // Only the first call should hit `_submit`; the second is coalesced
    // into the in-flight promise.
    expect(submitSpy).toHaveBeenCalledTimes(1);
    expect(pending.length).toBe(1);

    // Resolve the single in-flight submission.
    pending[0](makeResult("sigA"));

    const [r1, r2] = await Promise.all([p1, p2]);

    expect(r1.signature).toBe("sigA");
    expect(r2.signature).toBe("sigA");
    // Original caller's result must NOT be tagged.
    expect(r1.coalesced).toBeFalsy();
    // Second caller must be tagged.
    expect(r2.coalesced).toBe(true);
  });

  test("original caller's resolved result is not mutated even after coalesced caller resolves", async () => {
    const p1 = submitter.submitAndConfirm(baseParams("key-B"));
    const p2 = submitter.submitAndConfirm(baseParams("key-B"));

    pending[0](makeResult("sigB"));

    const r1 = await p1;
    // Snapshot before the second caller observes its coalesced copy.
    const r1CoalescedBefore = r1.coalesced;
    const r2 = await p2;

    // r1 reference must remain untouched even after r2 has resolved with
    // its `{...r, coalesced: true}` copy.
    expect(r1.coalesced).toBe(r1CoalescedBefore);
    expect(r1.coalesced).toBeFalsy();
    expect(r2.coalesced).toBe(true);
    // Confirm r1 and r2 are different object references — spread copy.
    expect(r1).not.toBe(r2);
  });

  test("two parallel calls without idempotency key do not coalesce", async () => {
    const p1 = submitter.submitAndConfirm(baseParams());
    const p2 = submitter.submitAndConfirm(baseParams());

    // Both calls must reach `_submit` independently.
    expect(submitSpy).toHaveBeenCalledTimes(2);
    expect(pending.length).toBe(2);

    pending[0](makeResult("sig1"));
    pending[1](makeResult("sig2"));

    const [r1, r2] = await Promise.all([p1, p2]);
    expect(r1.coalesced).toBeFalsy();
    expect(r2.coalesced).toBeFalsy();
    expect(r1.signature).toBe("sig1");
    expect(r2.signature).toBe("sig2");
  });

  test("sequential reuse after settle still coalesces (in-flight map persists ~5 minutes)", async () => {
    // Per current implementation in src/write/submitter.ts, after `_submit`
    // resolves, a `setTimeout(..., 300_000)` is scheduled to evict the
    // in-flight entry. That setTimeout has NOT fired yet when the second
    // sequential call arrives, so the second caller still observes the
    // settled in-flight promise and IS tagged `coalesced: true`.
    const p1 = submitter.submitAndConfirm(baseParams("key-C"));
    pending[0](makeResult("sigC"));
    const r1 = await p1;

    // Now fully settled. Fire a second call with the same key.
    const r2 = await submitter.submitAndConfirm(baseParams("key-C"));

    // `_submit` should still have been called only once — the second
    // caller short-circuits to the cached settled promise.
    expect(submitSpy).toHaveBeenCalledTimes(1);

    expect(r1.coalesced).toBeFalsy();
    expect(r1.signature).toBe("sigC");
    expect(r2.coalesced).toBe(true);
    expect(r2.signature).toBe("sigC");
  });
});
