/**
 * Tests for Issue Card BPP handler (FN-125 / T-3.12.1.2).
 */

import { describe, it, expect, vi } from "vitest";
import type { AuthenticatedRequest } from "../auth.js";
import {
  issueCard,
  stubs,
  IssueCardRejected,
  REQUIRED_SCHEMAS,
  type IssueCardRequest,
  type IssueCardDeps,
} from "./issue-card.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const SUBJECT = "a".repeat(64);
const BANK_ISSUER = "b".repeat(64);
const LINKED_ACCOUNT_PDA = "c".repeat(64);

function makeBody(overrides: Partial<IssueCardRequest> = {}): IssueCardRequest {
  return {
    subject: SUBJECT,
    bank_issuer: BANK_ISSUER,
    linked_account_pda: LINKED_ACCOUNT_PDA,
    issued_slot: 1_000_000,
    ...overrides,
  };
}

function makeRequest(
  overrides: Partial<IssueCardRequest> = {},
  callerPubkey: string = SUBJECT,
): AuthenticatedRequest<IssueCardRequest> {
  return { callerPubkey, body: makeBody(overrides) };
}

function makeDeps(overrides: Partial<IssueCardDeps> = {}): IssueCardDeps {
  return {
    verifyHolderCredentials: vi.fn().mockResolvedValue(true),
    verifyLinkedAccount: vi.fn().mockResolvedValue(true),
    issueCardCredential: vi.fn().mockResolvedValue({
      tx_signature: "f".repeat(64),
      credential_pda: "e".repeat(64),
    }),
    recordCard: vi.fn().mockResolvedValue(undefined),
    flagReconciliation: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Happy path
// ---------------------------------------------------------------------------

describe("issueCard — happy path", () => {
  it("returns valid card_pda (hex64)", async () => {
    const result = await issueCard(makeRequest(), makeDeps());
    expect(result.card_pda).toMatch(/^[0-9a-f]{64}$/);
  });

  it("returns fulfillment_uri = eto://card/<pda>", async () => {
    const result = await issueCard(makeRequest(), makeDeps());
    expect(result.fulfillment_uri).toBe(`eto://card/${result.card_pda}`);
  });

  it("credential schema is card.debit.us.v1 by default", async () => {
    const result = await issueCard(makeRequest(), makeDeps());
    expect(result.credential.schema).toBe("card.debit.us.v1");
  });

  it("credential subject and issuer match request", async () => {
    const result = await issueCard(makeRequest(), makeDeps());
    expect(result.credential.subject).toBe(SUBJECT);
    expect(result.credential.issuer).toBe(BANK_ISSUER);
  });
});

// ---------------------------------------------------------------------------
// Caller authentication (FN-015)
// ---------------------------------------------------------------------------

describe("issueCard — caller authentication", () => {
  it("happy path: callerPubkey === body.subject succeeds", async () => {
    const result = await issueCard(makeRequest({}, SUBJECT), makeDeps());
    expect(result.card_pda).toMatch(/^[0-9a-f]{64}$/);
  });

  it("rejects with unauthorized_caller when callerPubkey !== body.subject", async () => {
    const deps = makeDeps();
    await expect(
      issueCard(makeRequest({}, "d".repeat(64)), deps),
    ).rejects.toMatchObject({ reason: "unauthorized_caller" });
  });

  it("does NOT invoke any dep when callerPubkey mismatches", async () => {
    const deps = makeDeps();
    await expect(
      issueCard(makeRequest({}, "d".repeat(64)), deps),
    ).rejects.toBeDefined();
    expect(deps.verifyHolderCredentials).not.toHaveBeenCalled();
    expect(deps.verifyLinkedAccount).not.toHaveBeenCalled();
    expect(deps.recordCard).not.toHaveBeenCalled();
    expect(deps.issueCardCredential).not.toHaveBeenCalled();
    expect(deps.flagReconciliation).not.toHaveBeenCalled();
  });

  it("rejects with unauthorized_caller when callerPubkey is empty string", async () => {
    const deps = makeDeps();
    await expect(
      issueCard(makeRequest({}, ""), deps),
    ).rejects.toMatchObject({ reason: "unauthorized_caller" });
    expect(deps.verifyHolderCredentials).not.toHaveBeenCalled();
  });

  it("matches case-insensitively over hex (uppercase caller, lowercase subject)", async () => {
    const upper = SUBJECT.toUpperCase();
    const result = await issueCard(makeRequest({}, upper), makeDeps());
    expect(result.credential.subject).toBe(SUBJECT);
  });
});

// ---------------------------------------------------------------------------
// Side-effect counts
// ---------------------------------------------------------------------------

describe("issueCard — side-effect call counts", () => {
  it("calls recordCard and issueCardCredential exactly once on success", async () => {
    const deps = makeDeps();
    await issueCard(makeRequest(), deps);
    expect(deps.recordCard).toHaveBeenCalledOnce();
    expect(deps.issueCardCredential).toHaveBeenCalledOnce();
  });

  it("calls issueCardCredential with the built credential", async () => {
    const deps = makeDeps();
    const result = await issueCard(makeRequest(), deps);
    expect(deps.issueCardCredential).toHaveBeenCalledWith(result.credential);
  });

  it("calls recordCard with card_pda and credential body", async () => {
    const deps = makeDeps();
    const result = await issueCard(makeRequest(), deps);
    expect(deps.recordCard).toHaveBeenCalledWith(
      result.card_pda,
      result.credential.body,
    );
  });
});

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

describe("issueCard — defaults", () => {
  it('jurisdiction defaults to "us"', async () => {
    const result = await issueCard(makeRequest({ jurisdiction: undefined }), makeDeps());
    expect(result.credential.body.jurisdiction).toBe("us");
  });

  it("spending_limit_per_day defaults to 5_000_000_000", async () => {
    const result = await issueCard(makeRequest(), makeDeps());
    expect(result.credential.body.spending_limit_per_day).toBe(5_000_000_000);
  });

  it("spending_limit_per_tx defaults to 500_000_000", async () => {
    const result = await issueCard(makeRequest(), makeDeps());
    expect(result.credential.body.spending_limit_per_tx).toBe(500_000_000);
  });

  it("expires_slot defaults to 0", async () => {
    const result = await issueCard(makeRequest({ expires_slot: undefined }), makeDeps());
    expect(result.credential.body.expires_slot).toBe(0);
  });

  it("custom spending limits are respected", async () => {
    const result = await issueCard(
      makeRequest({
        spending_limit_per_day_atomic: 1_000_000_000,
        spending_limit_per_tx_atomic: 100_000_000,
      }),
      makeDeps(),
    );
    expect(result.credential.body.spending_limit_per_day).toBe(1_000_000_000);
    expect(result.credential.body.spending_limit_per_tx).toBe(100_000_000);
  });
});

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

describe("issueCard — validation: invalid_pubkey", () => {
  it("throws invalid_pubkey for bad subject (too short)", async () => {
    // FN-015: callerPubkey must match body.subject for the validation
    // gate to be exercised at all; here both sides are the (bad) value.
    await expect(
      issueCard(makeRequest({ subject: "abc" }, "abc"), makeDeps()),
    ).rejects.toMatchObject({ reason: "invalid_pubkey" });
  });

  it("throws invalid_pubkey for bad bank_issuer", async () => {
    await expect(
      issueCard(makeRequest({ bank_issuer: "not-hex" }), makeDeps()),
    ).rejects.toMatchObject({ reason: "invalid_pubkey" });
  });

  it("throws invalid_pubkey for bad linked_account_pda", async () => {
    await expect(
      issueCard(makeRequest({ linked_account_pda: "x".repeat(64) }), makeDeps()),
    ).rejects.toMatchObject({ reason: "invalid_pubkey" });
  });

  it("throws invalid_pubkey for 65-char hex subject", async () => {
    const long = "a".repeat(65);
    await expect(
      issueCard(makeRequest({ subject: long }, long), makeDeps()),
    ).rejects.toMatchObject({ reason: "invalid_pubkey" });
  });
});

describe("issueCard — validation: invalid_jurisdiction", () => {
  it('throws invalid_jurisdiction for "USA" (3 chars)', async () => {
    await expect(
      issueCard(makeRequest({ jurisdiction: "USA" }), makeDeps()),
    ).rejects.toMatchObject({ reason: "invalid_jurisdiction" });
  });

  it('throws invalid_jurisdiction for "u1" (digit)', async () => {
    await expect(
      issueCard(makeRequest({ jurisdiction: "u1" }), makeDeps()),
    ).rejects.toMatchObject({ reason: "invalid_jurisdiction" });
  });

  it('throws invalid_jurisdiction for "US" (uppercase)', async () => {
    await expect(
      issueCard(makeRequest({ jurisdiction: "US" }), makeDeps()),
    ).rejects.toMatchObject({ reason: "invalid_jurisdiction" });
  });

  it('throws invalid_jurisdiction for "" (empty string)', async () => {
    await expect(
      issueCard(makeRequest({ jurisdiction: "" }), makeDeps()),
    ).rejects.toMatchObject({ reason: "invalid_jurisdiction" });
  });
});

describe("issueCard — validation: invalid_limit", () => {
  it("throws invalid_limit for negative spending_limit_per_day", async () => {
    await expect(
      issueCard(makeRequest({ spending_limit_per_day_atomic: -1 }), makeDeps()),
    ).rejects.toMatchObject({ reason: "invalid_limit" });
  });

  it("throws invalid_limit for negative spending_limit_per_tx", async () => {
    await expect(
      issueCard(makeRequest({ spending_limit_per_tx_atomic: -1 }), makeDeps()),
    ).rejects.toMatchObject({ reason: "invalid_limit" });
  });

  it("throws invalid_limit for non-integer spending_limit_per_day", async () => {
    await expect(
      issueCard(makeRequest({ spending_limit_per_day_atomic: 1.5 }), makeDeps()),
    ).rejects.toMatchObject({ reason: "invalid_limit" });
  });

  it("throws invalid_limit for non-integer spending_limit_per_tx", async () => {
    await expect(
      issueCard(makeRequest({ spending_limit_per_tx_atomic: 0.5 }), makeDeps()),
    ).rejects.toMatchObject({ reason: "invalid_limit" });
  });

  it("throws invalid_limit when per_tx > per_day", async () => {
    await expect(
      issueCard(
        makeRequest({
          spending_limit_per_day_atomic: 100,
          spending_limit_per_tx_atomic: 200,
        }),
        makeDeps(),
      ),
    ).rejects.toMatchObject({ reason: "invalid_limit" });
  });

  it("accepts per_tx == per_day (edge case)", async () => {
    await expect(
      issueCard(
        makeRequest({
          spending_limit_per_day_atomic: 1_000_000,
          spending_limit_per_tx_atomic: 1_000_000,
        }),
        makeDeps(),
      ),
    ).resolves.toBeDefined();
  });

  it("accepts per_tx == 0 and per_day == 0 (zero limits)", async () => {
    await expect(
      issueCard(
        makeRequest({
          spending_limit_per_day_atomic: 0,
          spending_limit_per_tx_atomic: 0,
        }),
        makeDeps(),
      ),
    ).resolves.toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// Credentials gate
// ---------------------------------------------------------------------------

describe("issueCard — credentials gate", () => {
  it("throws credentials_missing when verifyHolderCredentials returns false", async () => {
    const deps = makeDeps({
      verifyHolderCredentials: vi.fn().mockResolvedValue(false),
    });
    await expect(issueCard(makeRequest(), deps)).rejects.toMatchObject({
      reason: "credentials_missing",
    });
  });

  it("does NOT call recordCard or issueCardCredential when credentials gate fails", async () => {
    const deps = makeDeps({
      verifyHolderCredentials: vi.fn().mockResolvedValue(false),
    });
    await expect(issueCard(makeRequest(), deps)).rejects.toBeDefined();
    expect(deps.recordCard).not.toHaveBeenCalled();
    expect(deps.issueCardCredential).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Account gate
// ---------------------------------------------------------------------------

describe("issueCard — account gate", () => {
  it("throws account_not_found when verifyLinkedAccount returns false", async () => {
    const deps = makeDeps({
      verifyLinkedAccount: vi.fn().mockResolvedValue(false),
    });
    await expect(issueCard(makeRequest(), deps)).rejects.toMatchObject({
      reason: "account_not_found",
    });
  });

  it("does NOT call recordCard or issueCardCredential when account gate fails", async () => {
    const deps = makeDeps({
      verifyLinkedAccount: vi.fn().mockResolvedValue(false),
    });
    await expect(issueCard(makeRequest(), deps)).rejects.toBeDefined();
    expect(deps.recordCard).not.toHaveBeenCalled();
    expect(deps.issueCardCredential).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Atomicity
// ---------------------------------------------------------------------------

describe("issueCard — atomicity", () => {
  it("throws ledger_failed when recordCard rejects, and does NOT call issueCardCredential", async () => {
    const deps = makeDeps({
      recordCard: vi.fn().mockRejectedValue(new Error("db down")),
    });
    await expect(issueCard(makeRequest(), deps)).rejects.toMatchObject({
      reason: "ledger_failed",
    });
    expect(deps.issueCardCredential).not.toHaveBeenCalled();
  });

  it("throws issue_failed when issueCardCredential rejects", async () => {
    const deps = makeDeps({
      issueCardCredential: vi.fn().mockRejectedValue(new Error("chain error")),
    });
    await expect(issueCard(makeRequest(), deps)).rejects.toMatchObject({
      reason: "issue_failed",
    });
  });

  it("recordCard IS called before issueCardCredential fails", async () => {
    const callOrder: string[] = [];
    const deps = makeDeps({
      recordCard: vi.fn().mockImplementation(async () => {
        callOrder.push("recordCard");
      }),
      issueCardCredential: vi.fn().mockImplementation(async () => {
        callOrder.push("issueCardCredential");
        throw new Error("chain error");
      }),
    });
    await expect(issueCard(makeRequest(), deps)).rejects.toBeDefined();
    expect(callOrder).toEqual(["recordCard", "issueCardCredential"]);
  });
});

// ---------------------------------------------------------------------------
// PDA determinism
// ---------------------------------------------------------------------------

describe("issueCard — PDA determinism", () => {
  it("same inputs → same card_pda", async () => {
    const req = makeRequest();
    const r1 = await issueCard(req, makeDeps());
    const r2 = await issueCard(req, makeDeps());
    expect(r1.card_pda).toBe(r2.card_pda);
  });

  it("differing issued_slot → different card_pda", async () => {
    const r1 = await issueCard(makeRequest({ issued_slot: 1_000 }), makeDeps());
    const r2 = await issueCard(makeRequest({ issued_slot: 2_000 }), makeDeps());
    expect(r1.card_pda).not.toBe(r2.card_pda);
  });

  it("differing subject → different card_pda", async () => {
    const A = "a".repeat(64);
    const B = "b".repeat(64);
    const r1 = await issueCard(makeRequest({ subject: A }, A), makeDeps());
    const r2 = await issueCard(makeRequest({ subject: B }, B), makeDeps());
    expect(r1.card_pda).not.toBe(r2.card_pda);
  });

  it("differing linked_account_pda → different card_pda", async () => {
    const r1 = await issueCard(makeRequest({ linked_account_pda: "c".repeat(64) }), makeDeps());
    const r2 = await issueCard(makeRequest({ linked_account_pda: "d".repeat(64) }), makeDeps());
    expect(r1.card_pda).not.toBe(r2.card_pda);
  });
});

// ---------------------------------------------------------------------------
// Credential schema fields
// ---------------------------------------------------------------------------

describe("issueCard — credential schema fields", () => {
  it("body has all 6 required fields from card-debit.json", async () => {
    const result = await issueCard(makeRequest(), makeDeps());
    const body = result.credential.body;
    expect(body).toHaveProperty("holder");
    expect(body).toHaveProperty("linked_account_pda");
    expect(body).toHaveProperty("jurisdiction");
    expect(body).toHaveProperty("card_id_hash");
    expect(body).toHaveProperty("issued_slot");
    expect(body).toHaveProperty("spending_limit_per_day");
  });

  it("card_id_hash is 64-char lowercase hex", async () => {
    const result = await issueCard(makeRequest(), makeDeps());
    expect(result.credential.body.card_id_hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("body.holder equals request.subject", async () => {
    const result = await issueCard(makeRequest(), makeDeps());
    expect(result.credential.body.holder).toBe(SUBJECT);
  });

  it("body.linked_account_pda equals request.linked_account_pda", async () => {
    const result = await issueCard(makeRequest(), makeDeps());
    expect(result.credential.body.linked_account_pda).toBe(LINKED_ACCOUNT_PDA);
  });

  it("body.issued_slot equals request.issued_slot", async () => {
    const result = await issueCard(makeRequest({ issued_slot: 9999 }), makeDeps());
    expect(result.credential.body.issued_slot).toBe(9999);
  });

  it("body.network_brand is 'internal'", async () => {
    const result = await issueCard(makeRequest(), makeDeps());
    expect(result.credential.body.network_brand).toBe("internal");
  });

  it("body.tier is 'standard'", async () => {
    const result = await issueCard(makeRequest(), makeDeps());
    expect(result.credential.body.tier).toBe("standard");
  });
});

// ---------------------------------------------------------------------------
// REQUIRED_SCHEMAS
// ---------------------------------------------------------------------------

describe("issueCard — REQUIRED_SCHEMAS", () => {
  it("equals [verified-human, kyc.us-test]", () => {
    expect(REQUIRED_SCHEMAS).toEqual([
      "eto.beckn.schema.verified-human.v1",
      "eto.beckn.schema.kyc.us-test.v1",
    ]);
  });

  it("passes REQUIRED_SCHEMAS verbatim to verifyHolderCredentials", async () => {
    const deps = makeDeps();
    await issueCard(makeRequest(), deps);
    expect(deps.verifyHolderCredentials).toHaveBeenCalledWith(
      SUBJECT,
      REQUIRED_SCHEMAS,
    );
  });
});

// ---------------------------------------------------------------------------
// Stubs smoke test
// ---------------------------------------------------------------------------

describe("issueCard — stubs smoke", () => {
  it("stubs.verifyHolderCredentials returns true", async () => {
    const result = await stubs.verifyHolderCredentials(SUBJECT, REQUIRED_SCHEMAS);
    expect(result).toBe(true);
  });

  it("stubs.verifyLinkedAccount returns true", async () => {
    const result = await stubs.verifyLinkedAccount(LINKED_ACCOUNT_PDA, SUBJECT);
    expect(result).toBe(true);
  });

  it("stubs.issueCardCredential returns 64-char hex tx_signature and credential_pda", async () => {
    const dummyCred = {
      schema: "card.debit.us.v1" as const,
      subject: SUBJECT,
      issuer: BANK_ISSUER,
      body: {
        holder: SUBJECT,
        linked_account_pda: LINKED_ACCOUNT_PDA,
        jurisdiction: "us",
        card_id_hash: "0".repeat(64),
        issued_slot: 1,
        expires_slot: 0,
        spending_limit_per_day: 5_000_000_000,
        spending_limit_per_tx: 500_000_000,
        network_brand: "internal" as const,
        tier: "standard" as const,
      },
    };
    const result = await stubs.issueCardCredential(dummyCred);
    expect(result.tx_signature).toMatch(/^[0-9a-f]{64}$/);
    expect(result.credential_pda).toMatch(/^[0-9a-f]{64}$/);
  });

  it("stubs.recordCard resolves without error", async () => {
    const body = {
      holder: SUBJECT,
      linked_account_pda: LINKED_ACCOUNT_PDA,
      jurisdiction: "us",
      card_id_hash: "0".repeat(64),
      issued_slot: 1,
      expires_slot: 0,
      spending_limit_per_day: 5_000_000_000,
      spending_limit_per_tx: 500_000_000,
      network_brand: "internal" as const,
      tier: "standard" as const,
    };
    await expect(stubs.recordCard("pda123", body)).resolves.toBeUndefined();
  });

  it("full handler run with stubs succeeds end-to-end", async () => {
    const result = await issueCard(makeRequest(), stubs);
    expect(result.card_pda).toMatch(/^[0-9a-f]{64}$/);
    expect(result.credential.schema).toBe("card.debit.us.v1");
    expect(result.fulfillment_uri).toBe(`eto://card/${result.card_pda}`);
  });
});
