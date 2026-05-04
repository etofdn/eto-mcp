/**
 * FN-191 — issue-card flagReconciliation hook tests.
 *
 * AC:
 *   - flagReconciliation is invoked exactly once with (card_pda, holder, body)
 *     when issueCardCredential throws after recordCard succeeded.
 *   - flagReconciliation is NOT invoked when issueCardCredential succeeds.
 *   - flagReconciliation is NOT invoked when recordCard itself throws
 *     (no orphan to reconcile in that case — ledger never wrote).
 *   - flagReconciliation that itself throws does not mask the primary
 *     `issue_failed` error.
 */
import { describe, it, expect, vi } from "vitest";
import { issueCard, IssueCardRejected, type IssueCardDeps } from "./issue-card";

const SUBJECT = "1".repeat(64);
const BANK = "0".repeat(64);
const LINKED = "2".repeat(64);

function baseDeps(): IssueCardDeps {
  return {
    verifyHolderCredentials: vi.fn().mockResolvedValue(true),
    verifyLinkedAccount: vi.fn().mockResolvedValue(true),
    issueCardCredential: vi.fn().mockResolvedValue({ tx_signature: "tx", credential_pda: "pda" }),
    recordCard: vi.fn().mockResolvedValue(undefined),
    flagReconciliation: vi.fn().mockResolvedValue(undefined),
  };
}

const req = {
  callerPubkey: SUBJECT,
  body: {
    subject: SUBJECT,
    bank_issuer: BANK,
    linked_account_pda: LINKED,
    issued_slot: 1_000_000,
  },
};

describe("FN-191 — issue-card flagReconciliation", () => {
  it("invokes flagReconciliation exactly once when issueCardCredential throws", async () => {
    const deps = baseDeps();
    deps.issueCardCredential = vi.fn().mockRejectedValue(new Error("chain rpc down"));
    await expect(issueCard(req, deps)).rejects.toThrow(IssueCardRejected);
    expect(deps.flagReconciliation).toHaveBeenCalledOnce();
    const [card_pda, holder, body] = (deps.flagReconciliation as any).mock.calls[0]!;
    expect(card_pda).toMatch(/^[0-9a-f]{64}$/);
    expect(holder).toBe(SUBJECT);
    expect(body.linked_account_pda).toBe(LINKED);
  });

  it("does NOT invoke flagReconciliation on the happy path", async () => {
    const deps = baseDeps();
    await issueCard(req, deps);
    expect(deps.flagReconciliation).not.toHaveBeenCalled();
  });

  it("does NOT invoke flagReconciliation when recordCard itself throws (nothing to reconcile)", async () => {
    const deps = baseDeps();
    deps.recordCard = vi.fn().mockRejectedValue(new Error("ledger down"));
    await expect(issueCard(req, deps)).rejects.toThrow(IssueCardRejected);
    expect(deps.flagReconciliation).not.toHaveBeenCalled();
  });

  it("does NOT mask the primary issue_failed error if flagReconciliation itself throws", async () => {
    const deps = baseDeps();
    deps.issueCardCredential = vi.fn().mockRejectedValue(new Error("chain rpc down"));
    deps.flagReconciliation = vi.fn().mockRejectedValue(new Error("flag service down"));
    await expect(issueCard(req, deps)).rejects.toMatchObject({
      reason: "issue_failed",
    });
    expect(deps.flagReconciliation).toHaveBeenCalledOnce();
  });
});
