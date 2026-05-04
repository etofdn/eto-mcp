/**
 * Tests for the Bank-as-BPP dispatcher (FN-096) — caller-authentication
 * plumbing point added by FN-015.
 *
 * These tests document the FN-015 contract:
 *   - {@link extractCallerPubkey} reads a defensive `callerPubkey` field
 *     from the inbound `TaskRequest` and returns `undefined` when it is
 *     missing or empty (the current state until FN-073 / FN-075 land).
 *   - The dispatcher MUST NOT throw on requests that lack `callerPubkey`
 *     today; per-capability handlers are still stubs and short-circuit
 *     via `STUB_REASONS`, so the existing wire contract is preserved.
 *   - When FN-073 / FN-075 populate `callerPubkey`, {@link extractCallerPubkey}
 *     surfaces it so the dispatcher can build `AuthenticatedRequest<T>`
 *     for per-capability handlers.
 */

import { describe, it, expect } from "vitest";
import type { TaskRequest } from "../../templates/bpp/index.js";
import {
  createBankHandler,
  extractCallerPubkey,
  UNAUTHORIZED_CALLER_REASON,
} from "./handler.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeReq(
  overrides: Partial<TaskRequest<unknown>> & { callerPubkey?: string } = {},
): TaskRequest<unknown> {
  const { callerPubkey, ...rest } = overrides;
  const base: TaskRequest<unknown> = {
    taskId: "task-123",
    bapPubkey: "00".repeat(32),
    bppPubkey: "11".repeat(32),
    networkPubkey: "22".repeat(32),
    action: "bank.card",
    input: {},
    ...rest,
  };
  if (callerPubkey !== undefined) {
    return { ...base, callerPubkey } as TaskRequest<unknown>;
  }
  return base;
}

// ---------------------------------------------------------------------------
// extractCallerPubkey
// ---------------------------------------------------------------------------

describe("extractCallerPubkey (FN-015 plumbing point)", () => {
  it("returns undefined when callerPubkey is missing (pre-FN-073/FN-075)", () => {
    expect(extractCallerPubkey(makeReq())).toBeUndefined();
  });

  it("returns undefined when callerPubkey is the empty string", () => {
    expect(extractCallerPubkey(makeReq({ callerPubkey: "" }))).toBeUndefined();
  });

  it("returns the verified caller pubkey when populated", () => {
    const pk = "ab".repeat(32);
    expect(extractCallerPubkey(makeReq({ callerPubkey: pk }))).toBe(pk);
  });

  it("returns undefined for a non-string callerPubkey value", () => {
    const req = {
      taskId: "t",
      bapPubkey: "00".repeat(32),
      bppPubkey: "11".repeat(32),
      networkPubkey: "22".repeat(32),
      action: "bank.card",
      input: {},
      callerPubkey: 1234,
    } as unknown as TaskRequest<unknown>;
    expect(extractCallerPubkey(req)).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Dispatcher fail-closed / stub-preserving behaviour
// ---------------------------------------------------------------------------

describe("createBankHandler — FN-015 caller-auth contract", () => {
  it("does not throw on requests without callerPubkey (pre-gateway-plumbing)", async () => {
    const handler = createBankHandler();
    await expect(
      handler.handleTask(makeReq({ action: "bank.card" })),
    ).resolves.toEqual({
      status: "failure",
      reason: expect.stringContaining("not_implemented: bank.card"),
    });
  });

  it("preserves the existing stub failure for each known capability", async () => {
    const handler = createBankHandler();
    for (const action of [
      "bank.checking",
      "bank.savings",
      "bank.fiat-ramp",
      "bank.card",
      "bank.wire",
    ]) {
      const result = await handler.handleTask(makeReq({ action }));
      expect(result).toEqual({
        status: "failure",
        reason: expect.stringContaining(`not_implemented: ${action}`),
      });
    }
  });

  it("returns unknown_action for unrecognised actions", async () => {
    const handler = createBankHandler();
    const result = await handler.handleTask(
      makeReq({ action: "bank.unknown" }),
    );
    expect(result).toEqual({
      status: "failure",
      reason: "unknown_action: bank.unknown",
    });
  });

  it("does not throw when callerPubkey IS populated (forward-compat with FN-073/FN-075)", async () => {
    const handler = createBankHandler();
    const result = await handler.handleTask(
      makeReq({ action: "bank.card", callerPubkey: "ab".repeat(32) }),
    );
    expect(result.status).toBe("failure");
  });

  it("re-exports UNAUTHORIZED_CALLER_REASON for downstream callers", () => {
    expect(UNAUTHORIZED_CALLER_REASON).toBe("unauthorized_caller");
  });
});
