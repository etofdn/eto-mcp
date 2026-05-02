/**
 * FN-090 — Tests for `makeProdIssueCardCredential` adapter.
 *
 * Mirrors FN-072's adapter test shape. Verifies:
 *   - Issuer-authority mismatch throws a plain Error (not BankIssuerError).
 *   - snake_case → camelCase field mapping is exhaustive and correct.
 *   - subject IS holder (v0 single-owner invariant).
 *   - expires_slot=0 is dropped from the output (not passed as literal 0).
 *   - The real `issueCardCredential` is invoked with the mapped input.
 *   - Response is unwrapped to { tx_signature, credential_pda }.
 */
import { describe, it, expect, vi } from "vitest";
import { makeProdIssueCardCredential } from "./issue-card";
import type { IssueCardCredential } from "./issue-card";
import type { BankIssuerDeps } from "../../../../src/issuers/bank";

const ISSUER_AUTH = "0".repeat(64);
const SUBJECT = "1".repeat(64);
const LINKED_ACCOUNT = "2".repeat(64);
const CARD_HASH = "3".repeat(64);

function makeCredential(overrides: Partial<IssueCardCredential> = {}): IssueCardCredential {
  return {
    schema: "card.debit.us.v1",
    subject: SUBJECT,
    issuer: ISSUER_AUTH,
    body: {
      holder: SUBJECT,
      linked_account_pda: LINKED_ACCOUNT,
      jurisdiction: "us",
      card_id_hash: CARD_HASH,
      issued_slot: 1_000_000,
      expires_slot: 2_000_000,
      spending_limit_per_day: 50_000,
      spending_limit_per_tx: 10_000,
      network_brand: "internal",
      tier: "standard",
    },
    ...overrides,
  };
}

function makeBankIssuer(): BankIssuerDeps {
  return {
    issuerAuthorityPubkey: ISSUER_AUTH,
  } as unknown as BankIssuerDeps;
}

describe("makeProdIssueCardCredential", () => {
  it("throws plain Error('issuer authority mismatch') on mismatched issuer", async () => {
    const adapter = makeProdIssueCardCredential(makeBankIssuer());
    const cred = makeCredential({ issuer: "ff".repeat(32) });
    await expect(adapter(cred)).rejects.toThrow("issuer authority mismatch");
  });

  it("maps snake_case body → camelCase IssueCardInput", async () => {
    const captured: { req?: unknown } = {};
    const issuerMock = {
      ...makeBankIssuer(),
    };
    const adapter = makeProdIssueCardCredential(issuerMock);
    // Patch the underlying issuer call by spying on the import boundary
    // via vi.mock at suite level — but for a focused field-mapping test,
    // a local proxy is enough.
    const originalModule = await import("../../../../src/issuers/bank");
    const realFn = originalModule.issueCardCredential;
    const spy = vi.spyOn(originalModule, "issueCardCredential").mockImplementation(async (_deps, req) => {
      captured.req = req;
      return {
        status: "issued" as const,
        credentialPda: "pda-1",
        txSignature: "tx-1",
        claimUri: "claim",
        bindingKey: req.cardIdHash,
      };
    });

    try {
      const out = await adapter(makeCredential());
      expect(out).toEqual({ tx_signature: "tx-1", credential_pda: "pda-1" });
      const req = captured.req as Record<string, unknown>;
      expect(req.subjectAgentCardPubkey).toBe(SUBJECT);
      expect(req.holder).toBe(SUBJECT); // subject IS holder
      expect(req.cardIdHash).toBe(CARD_HASH);
      expect(req.linkedAccountPda).toBe(LINKED_ACCOUNT);
      expect(req.jurisdiction).toBe("us");
      expect(req.issuedSlot).toBe(1_000_000);
      expect(req.spendingLimitPerDay).toBe(50_000);
      expect(req.spendingLimitPerTx).toBe(10_000);
      expect(req.expiresSlot).toBe(2_000_000);
      expect(req.networkBrand).toBe("internal");
      expect(req.tier).toBe("standard");
    } finally {
      spy.mockRestore();
      void realFn;
    }
  });

  it("threads merchant_category_blocklist when set (FN-103)", async () => {
    const captured: { req?: any } = {};
    const originalModule = await import("../../../../src/issuers/bank");
    const spy = vi
      .spyOn(originalModule, "issueCardCredential")
      .mockImplementation(async (_deps, req) => {
        captured.req = req;
        return {
          status: "issued" as const,
          credentialPda: "pda-3",
          txSignature: "tx-3",
          claimUri: "claim",
          bindingKey: req.cardIdHash,
        };
      });
    try {
      const adapter = makeProdIssueCardCredential(makeBankIssuer());
      const cred = makeCredential();
      cred.body.merchant_category_blocklist = ["7995", "5912"];
      await adapter(cred);
      expect(captured.req.merchantCategoryBlocklist).toEqual(["7995", "5912"]);
    } finally {
      spy.mockRestore();
    }
  });

  it("omits merchantCategoryBlocklist when blocklist is empty or absent (FN-103)", async () => {
    const captured: { req?: any } = {};
    const originalModule = await import("../../../../src/issuers/bank");
    const spy = vi
      .spyOn(originalModule, "issueCardCredential")
      .mockImplementation(async (_deps, req) => {
        captured.req = req;
        return {
          status: "issued" as const,
          credentialPda: "pda-4",
          txSignature: "tx-4",
          claimUri: "claim",
          bindingKey: req.cardIdHash,
        };
      });
    try {
      const adapter = makeProdIssueCardCredential(makeBankIssuer());
      await adapter(makeCredential());
      expect(Object.prototype.hasOwnProperty.call(captured.req, "merchantCategoryBlocklist")).toBe(false);
      const empty = makeCredential();
      empty.body.merchant_category_blocklist = [];
      await adapter(empty);
      expect(Object.prototype.hasOwnProperty.call(captured.req, "merchantCategoryBlocklist")).toBe(false);
    } finally {
      spy.mockRestore();
    }
  });

  it("omits expiresSlot when expires_slot === 0 (no-expiry sentinel)", async () => {
    const captured: { req?: any } = {};
    const originalModule = await import("../../../../src/issuers/bank");
    const spy = vi.spyOn(originalModule, "issueCardCredential").mockImplementation(async (_deps, req) => {
      captured.req = req;
      return {
        status: "issued" as const,
        credentialPda: "pda-2",
        txSignature: "tx-2",
        claimUri: "claim",
        bindingKey: req.cardIdHash,
      };
    });
    try {
      const adapter = makeProdIssueCardCredential(makeBankIssuer());
      const cred = makeCredential();
      cred.body.expires_slot = 0;
      await adapter(cred);
      expect(Object.prototype.hasOwnProperty.call(captured.req, "expiresSlot")).toBe(false);
    } finally {
      spy.mockRestore();
    }
  });
});
