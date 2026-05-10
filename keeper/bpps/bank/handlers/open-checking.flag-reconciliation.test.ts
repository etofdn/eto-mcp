/**
 * FN-191 — open-checking flagReconciliation hook tests.
 *
 * AC:
 *   - flagReconciliation is invoked exactly once with
 *     (account_pda, holder, body) when issueCheckingCredential throws after
 *     recordCheckingAccount succeeded.
 *   - flagReconciliation is NOT invoked on the happy path.
 *   - flagReconciliation is NOT invoked when recordCheckingAccount itself throws.
 *   - flagReconciliation that itself throws does not mask the primary
 *     `issue_failed` error.
 */
import { describe, it, expect, vi } from "vitest";
import { openChecking, OpenCheckingRejected, type OpenCheckingDeps } from "./open-checking";

const SUBJECT = "1".repeat(64);
const BANK = "0".repeat(64);

function baseDeps(): OpenCheckingDeps {
  return {
    verifyHolderCredentials: vi.fn().mockResolvedValue(true),
    issueCheckingCredential: vi.fn().mockResolvedValue({ tx_signature: "tx", credential_pda: "pda" }),
    recordCheckingAccount: vi.fn().mockResolvedValue(undefined),
    flagReconciliation: vi.fn().mockResolvedValue(undefined),
  };
}

const req = {
  callerPubkey: SUBJECT,
  body: {
    subject: SUBJECT,
    bank_issuer: BANK,
    opened_slot: 1_000_000,
    opening_deposit_atomic: 5_000_000,
  },
};

describe("FN-191 — open-checking flagReconciliation", () => {
  it("invokes flagReconciliation exactly once when issueCheckingCredential throws", async () => {
    const deps = baseDeps();
    deps.issueCheckingCredential = vi.fn().mockRejectedValue(new Error("chain rpc down"));
    await expect(openChecking(req, deps)).rejects.toThrow(OpenCheckingRejected);
    expect(deps.flagReconciliation).toHaveBeenCalledOnce();
    const [account_pda, holder, body] = (deps.flagReconciliation as any).mock.calls[0]!;
    expect(account_pda).toMatch(/^[0-9a-f]{64}$/);
    expect(holder).toBe(SUBJECT);
    expect(body.opened_slot).toBe(1_000_000);
    expect(body.opening_balance).toBe(5_000_000);
  });

  it("does NOT invoke flagReconciliation on the happy path", async () => {
    const deps = baseDeps();
    await openChecking(req, deps);
    expect(deps.flagReconciliation).not.toHaveBeenCalled();
  });

  it("does NOT invoke flagReconciliation when recordCheckingAccount itself throws", async () => {
    const deps = baseDeps();
    deps.recordCheckingAccount = vi.fn().mockRejectedValue(new Error("ledger down"));
    await expect(openChecking(req, deps)).rejects.toThrow(OpenCheckingRejected);
    expect(deps.flagReconciliation).not.toHaveBeenCalled();
  });

  it("does NOT mask the primary issue_failed error if flagReconciliation itself throws", async () => {
    const deps = baseDeps();
    deps.issueCheckingCredential = vi.fn().mockRejectedValue(new Error("chain rpc down"));
    deps.flagReconciliation = vi.fn().mockRejectedValue(new Error("flag service down"));
    await expect(openChecking(req, deps)).rejects.toMatchObject({
      reason: "issue_failed",
    });
    expect(deps.flagReconciliation).toHaveBeenCalledOnce();
  });
});
