/**
 * Bank real-issuer service (FN-097 / T-3.9.1.3).
 *
 * # Purpose
 *
 * This is the **production** counterpart to `bank-mock.ts` for the
 * bank-as-BPP catalogue's account and card issuance flows. It mints
 * on-chain credentials under the bank's issuer authority key for the
 * three credential families:
 *
 *   - `account.checking.v1`  — checking account
 *   - `account.savings.v1`   — savings account
 *   - `card.debit.v1`        — debit card
 *
 * Future wiring:
 *   - `keeper/bpps/bank/handlers/open-checking.ts`  (FN-115)
 *   - `keeper/bpps/bank/handlers/open-savings.ts`   (FN-121)
 *   - `keeper/bpps/bank/handlers/issue-card.ts`     (FN-125)
 *
 * # Architecture (mirrors bank-mock.ts)
 *
 * All side-effects are dependency-injected (`BankIssuerDeps`) so unit
 * tests stay fully deterministic. The module is a **pure business-logic
 * core** — no global state, no singletons. The only bundled store is
 * `InMemoryBankIssuerStore`; a Postgres/SQLite adapter is a follow-up.
 *
 * # JCS / sha256 reuse
 *
 * `jcsCanonicalize` and `sha256Hex` are re-exported from `bank-mock.ts`.
 * This keeps a single JCS implementation in the codebase and makes the
 * `claim_hash = sha256(jcs(vc))` convention testable from one place.
 * (sha256Hex was promoted to an exported function in bank-mock.ts in this
 * same task as an additive change — no behaviour change.)
 *
 * # Case-conversion
 *
 * Input types (`IssueCheckingInput`, etc.) use camelCase.
 * `credentialSubject` keys inside the emitted VC use snake_case matching
 * the schema-of-record. The mapping is explicit inside each `build*Vc`
 * factory function.
 *
 * @module bank
 */

import {
  jcsCanonicalize,
  sha256Hex,
} from "./bank-mock.js";
import { computeClaimCommitments } from "./claim-commitments.js";

import {
  BANK_ISSUER_SCHEMA_LABELS,
  BankIssuerError,
  type BankCredentialKind,
  type BankIssuerDeps,
  type BankIssuerRow,
  type BankIssuerStore,
  type BankIssueResponse,
  type BankRevokeRequest,
  type BankRevokeResponse,
  type IssueCheckingInput,
  type IssueCardInput,
  type IssueSavingsInput,
} from "./bank.types.js";

export {
  BankIssuerError,
  BANK_ISSUER_SCHEMA_LABELS,
} from "./bank.types.js";
export type {
  BankCredentialKind,
  BankIssuerDeps,
  BankIssuerErrorKind,
  BankIssuerRow,
  BankIssuerStore,
  BankIssueResponse,
  BankRevokeRequest,
  BankRevokeResponse,
  IssueCheckingInput,
  IssueCardInput,
  IssueSavingsInput,
  IssueCredentialClient,
  RevokeCredentialClient,
  VcPinner,
  SlotClock,
} from "./bank.types.js";

// ---------------------------------------------------------------------------
// Issuer DID
// ---------------------------------------------------------------------------

/**
 * W3C-VC `issuer` field for all three credential families in v0.
 * Centralised so a future rename is a single-line change.
 * Matches `spec/banking/credentials/account-checking.json` and
 * `spec/banking/credentials/README.md`.
 */
export const BANK_ISSUER_DID = "did:eto:bank:eto-reference" as const;

// ---------------------------------------------------------------------------
// Schema-id constants
// ---------------------------------------------------------------------------

/**
 * On-chain schema ID for `account.checking.v1`.
 * Derived as `sha256(utf8("eto.beckn.schema.account.checking.v1"))`,
 * lowercase 64-char hex, no `0x` prefix. Same convention as all other
 * schema IDs in this codebase (see `required-creds.ts`, `kyc-test.ts`).
 */
export const ACCOUNT_CHECKING_SCHEMA_ID_HEX = sha256Hex(
  BANK_ISSUER_SCHEMA_LABELS["account.checking"],
);

/**
 * On-chain schema ID for `account.savings.v1`.
 * Pre-image: `"eto.beckn.schema.account.savings.v1"`.
 */
export const ACCOUNT_SAVINGS_SCHEMA_ID_HEX = sha256Hex(
  BANK_ISSUER_SCHEMA_LABELS["account.savings"],
);

/**
 * On-chain schema ID for `card.debit.v1`.
 * Pre-image: `"eto.beckn.schema.card.debit.v1"`.
 * Note: v0 is jurisdiction-agnostic (jurisdiction lives in
 * `credentialSubject`). A jurisdiction-suffixed schema split is a
 * future hardening task.
 */
export const CARD_DEBIT_SCHEMA_ID_HEX = sha256Hex(
  BANK_ISSUER_SCHEMA_LABELS["card.debit"],
);

/**
 * Table-driven dispatch map from credential kind to schema ID hex.
 * Frozen at module load.
 */
export const BANK_ISSUER_SCHEMA_IDS_HEX: Readonly<
  Record<BankCredentialKind, string>
> = Object.freeze({
  "account.checking": ACCOUNT_CHECKING_SCHEMA_ID_HEX,
  "account.savings": ACCOUNT_SAVINGS_SCHEMA_ID_HEX,
  "card.debit": CARD_DEBIT_SCHEMA_ID_HEX,
});

// ---------------------------------------------------------------------------
// Re-export JCS helpers for callers that need them without importing bank-mock
// ---------------------------------------------------------------------------

export { jcsCanonicalize, sha256Hex } from "./bank-mock.js";

// ---------------------------------------------------------------------------
// no-expiry sentinel (matches bank-mock.ts)
// ---------------------------------------------------------------------------

const VALID_UNTIL_NO_BOUND = 0n;

// ---------------------------------------------------------------------------
// VC builders
// ---------------------------------------------------------------------------

/**
 * Build the off-chain W3C-VC envelope for an `account.checking.v1` credential.
 *
 * `credentialSubject` keys are snake_case matching the schema-of-record
 * (`open-checking.ts` → `OpenCheckingResult.credential.body`).
 * No `proof` block in v0 — production signs after JCS canonicalisation.
 */
export function buildAccountCheckingVc(input: {
  readonly subjectAgentCardPubkey: string;
  readonly issuerAuthorityPubkey: string;
  readonly checkingAccountPda: string;
  readonly holder: string;
  readonly openedSlot: number;
  readonly currency: "eUSD";
  readonly openingBalance: number;
  readonly issuanceDate: string;
}): Record<string, unknown> {
  return {
    "@context": [
      "https://www.w3.org/2018/credentials/v1",
      "https://schema.eto.dev/banking/account-checking/v1",
    ],
    type: ["VerifiableCredential", "CheckingAccountCredential"],
    issuer: BANK_ISSUER_DID,
    issuanceDate: input.issuanceDate,
    credentialSubject: {
      id: `did:eto:agentcard:${input.subjectAgentCardPubkey}`,
      account_pda: input.checkingAccountPda,
      holder: input.holder,
      opened_slot: input.openedSlot,
      currency: input.currency,
      opening_balance: input.openingBalance,
    },
    issuerAuthority: input.issuerAuthorityPubkey,
  };
}

/**
 * Build the off-chain W3C-VC envelope for an `account.savings.v1` credential.
 *
 * `credentialSubject` keys conform to `spec/banking/credentials/account-savings.json`.
 * Optional fields (`apy_bps`, `tier`) are only included when the caller
 * supplies them, using `...(x !== undefined ? { key: x } : {})` spread
 * to satisfy `exactOptionalPropertyTypes`.
 */
export function buildAccountSavingsVc(input: {
  readonly subjectAgentCardPubkey: string;
  readonly issuerAuthorityPubkey: string;
  readonly savingsAccountPda: string;
  readonly holder: string;
  readonly openedSlot: number;
  readonly currency: "eUSD";
  readonly minBalance: number;
  readonly apyBps?: number;
  readonly tier?: "standard" | "premium" | "private";
  readonly issuanceDate: string;
}): Record<string, unknown> {
  return {
    "@context": [
      "https://www.w3.org/2018/credentials/v1",
      "https://schema.eto.dev/banking/account-savings/v1",
    ],
    type: ["VerifiableCredential", "SavingsAccountCredential"],
    issuer: BANK_ISSUER_DID,
    issuanceDate: input.issuanceDate,
    credentialSubject: {
      id: `did:eto:agentcard:${input.subjectAgentCardPubkey}`,
      account_pda: input.savingsAccountPda,
      holder: input.holder,
      opened_slot: input.openedSlot,
      currency: input.currency,
      min_balance: input.minBalance,
      ...(input.apyBps !== undefined ? { apy_bps: input.apyBps } : {}),
      ...(input.tier !== undefined ? { tier: input.tier } : {}),
    },
    issuerAuthority: input.issuerAuthorityPubkey,
  };
}

/**
 * Build the off-chain W3C-VC envelope for a `card.debit.v1` credential.
 *
 * `credentialSubject` keys conform to `spec/banking/credentials/card-debit.json`.
 * Optional fields are only included when supplied by the caller.
 */
export function buildCardDebitVc(input: {
  readonly subjectAgentCardPubkey: string;
  readonly issuerAuthorityPubkey: string;
  readonly cardIdHash: string;
  readonly holder: string;
  readonly linkedAccountPda: string;
  readonly jurisdiction: string;
  readonly issuedSlot: number;
  readonly spendingLimitPerDay: number;
  readonly expiresSlot?: number;
  readonly spendingLimitPerTx?: number;
  readonly merchantCategoryBlocklist?: string[];
  readonly networkBrand?: "visa" | "mastercard" | "amex" | "internal";
  readonly tier?: "standard" | "premium" | "metal";
  readonly issuanceDate: string;
}): Record<string, unknown> {
  return {
    "@context": [
      "https://www.w3.org/2018/credentials/v1",
      "https://schema.eto.dev/banking/card-debit/v1",
    ],
    type: ["VerifiableCredential", "DebitCardCredential"],
    issuer: BANK_ISSUER_DID,
    issuanceDate: input.issuanceDate,
    credentialSubject: {
      id: `did:eto:agentcard:${input.subjectAgentCardPubkey}`,
      holder: input.holder,
      linked_account_pda: input.linkedAccountPda,
      jurisdiction: input.jurisdiction,
      card_id_hash: input.cardIdHash,
      issued_slot: input.issuedSlot,
      spending_limit_per_day: input.spendingLimitPerDay,
      ...(input.expiresSlot !== undefined ? { expires_slot: input.expiresSlot } : {}),
      ...(input.spendingLimitPerTx !== undefined ? { spending_limit_per_tx: input.spendingLimitPerTx } : {}),
      ...(input.merchantCategoryBlocklist !== undefined ? { merchant_category_blocklist: input.merchantCategoryBlocklist } : {}),
      ...(input.networkBrand !== undefined ? { network_brand: input.networkBrand } : {}),
      ...(input.tier !== undefined ? { tier: input.tier } : {}),
    },
    issuerAuthority: input.issuerAuthorityPubkey,
  };
}

// ---------------------------------------------------------------------------
// Core issuance logic (shared across the three entry points)
// ---------------------------------------------------------------------------

function defaultNowUnix(): number {
  return Math.floor(Date.now() / 1000);
}

async function issueCredential(
  deps: BankIssuerDeps,
  kind: BankCredentialKind,
  bindingKey: string,
  subjectAgentCardPubkey: string,
  baseVc: Record<string, unknown>,
): Promise<BankIssueResponse> {
  const schemaIdHex = BANK_ISSUER_SCHEMA_IDS_HEX[kind];

  // Step 2 — §10.3.1: per-leaf Poseidon-2 commitments embedded BEFORE
  // canonicalisation so `claim_hash` binds them. The CSPRNG hook is
  // injected via `deps.randomBytes` for deterministic test KATs.
  const claimCommitments = computeClaimCommitments(
    baseVc["credentialSubject"] as Record<string, unknown>,
    { randomBytes: deps.randomBytes },
  );
  const vc = { ...baseVc, claimCommitments };
  const claimJcs = jcsCanonicalize(vc);
  const claimHashHex = sha256Hex(claimJcs);

  const { uri: claimUri } = await deps.pinner.pin(claimJcs);

  const slot = await deps.clock.currentSlot();

  let chainResult;
  try {
    chainResult = await deps.chain.issueCredential({
      subjectAgentCardPubkey,
      schemaIdHex,
      claimUri,
      claimHashHex,
      validFromSlot: slot,
      validUntilSlot: VALID_UNTIL_NO_BOUND,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new BankIssuerError(
      "chain_failed",
      `IssueCredential tx failed: ${message}`,
    );
  }

  // Step 3 — persist the row only after a successful chain tx
  const nowUnix = (deps.nowUnix ?? defaultNowUnix)();
  const winner = await deps.store.putIfAbsent({
    kind,
    bindingKey,
    agentCardPubkey: subjectAgentCardPubkey,
    credentialPda: chainResult.credentialPda,
    txSignature: chainResult.txSignature,
    claimUri,
    issuedAtUnix: nowUnix,
    revoked: false,
  });

  if (winner.agentCardPubkey !== subjectAgentCardPubkey) {
    throw new BankIssuerError(
      "binding_conflict",
      `${kind} was bound to a different AgentCard during issuance`,
      `bound_card=${winner.agentCardPubkey}`,
    );
  }

  if (winner.credentialPda !== chainResult.credentialPda) {
    // Same card raced with itself; the earlier row is authoritative.
    return {
      status: "idempotent",
      credentialPda: winner.credentialPda,
      txSignature: winner.txSignature,
      claimUri: winner.claimUri,
      bindingKey,
    };
  }

  return {
    status: "issued",
    credentialPda: chainResult.credentialPda,
    txSignature: chainResult.txSignature,
    claimUri,
    claimHashHex,
    bindingKey,
  };
}

// ---------------------------------------------------------------------------
// Public entry points
// ---------------------------------------------------------------------------

/**
 * Issue an `account.checking.v1` credential.
 *
 * Idempotent on `(checkingAccountPda, subjectAgentCardPubkey)` repeats.
 * Throws `BankIssuerError("binding_conflict")` if the same PDA was
 * previously bound to a different AgentCard.
 */
export async function issueCheckingCredential(
  deps: BankIssuerDeps,
  req: IssueCheckingInput,
): Promise<BankIssueResponse> {
  if (req.subjectAgentCardPubkey.length === 0) {
    throw new BankIssuerError(
      "invalid_request",
      "subjectAgentCardPubkey is empty",
      "empty_card",
    );
  }
  if (req.checkingAccountPda.length === 0) {
    throw new BankIssuerError(
      "invalid_request",
      "checkingAccountPda is empty",
      "empty_binding_key",
    );
  }

  const kind: BankCredentialKind = "account.checking";
  const bindingKey = req.checkingAccountPda;

  // Step 1 — idempotency pre-check
  const existing = await deps.store.get(kind, bindingKey);
  if (existing !== undefined) {
    if (existing.agentCardPubkey !== req.subjectAgentCardPubkey) {
      throw new BankIssuerError(
        "binding_conflict",
        "checking account already bound to a different AgentCard",
        `bound_card=${existing.agentCardPubkey}`,
      );
    }
    return {
      status: "idempotent",
      credentialPda: existing.credentialPda,
      txSignature: existing.txSignature,
      claimUri: existing.claimUri,
      bindingKey,
    };
  }

  const nowUnix = (deps.nowUnix ?? defaultNowUnix)();
  const vc = buildAccountCheckingVc({
    subjectAgentCardPubkey: req.subjectAgentCardPubkey,
    issuerAuthorityPubkey: deps.issuerAuthorityPubkey,
    checkingAccountPda: req.checkingAccountPda,
    holder: req.holder,
    openedSlot: req.openedSlot,
    currency: req.currency,
    openingBalance: req.openingBalance,
    issuanceDate: new Date(nowUnix * 1000).toISOString(),
  });

  return issueCredential(deps, kind, bindingKey, req.subjectAgentCardPubkey, vc);
}

/**
 * Issue an `account.savings.v1` credential.
 *
 * Idempotent on `(savingsAccountPda, subjectAgentCardPubkey)` repeats.
 */
export async function issueSavingsCredential(
  deps: BankIssuerDeps,
  req: IssueSavingsInput,
): Promise<BankIssueResponse> {
  if (req.subjectAgentCardPubkey.length === 0) {
    throw new BankIssuerError(
      "invalid_request",
      "subjectAgentCardPubkey is empty",
      "empty_card",
    );
  }
  if (req.savingsAccountPda.length === 0) {
    throw new BankIssuerError(
      "invalid_request",
      "savingsAccountPda is empty",
      "empty_binding_key",
    );
  }

  const kind: BankCredentialKind = "account.savings";
  const bindingKey = req.savingsAccountPda;

  // Step 1 — idempotency pre-check
  const existing = await deps.store.get(kind, bindingKey);
  if (existing !== undefined) {
    if (existing.agentCardPubkey !== req.subjectAgentCardPubkey) {
      throw new BankIssuerError(
        "binding_conflict",
        "savings account already bound to a different AgentCard",
        `bound_card=${existing.agentCardPubkey}`,
      );
    }
    return {
      status: "idempotent",
      credentialPda: existing.credentialPda,
      txSignature: existing.txSignature,
      claimUri: existing.claimUri,
      bindingKey,
    };
  }

  const nowUnix = (deps.nowUnix ?? defaultNowUnix)();
  const vc = buildAccountSavingsVc({
    subjectAgentCardPubkey: req.subjectAgentCardPubkey,
    issuerAuthorityPubkey: deps.issuerAuthorityPubkey,
    savingsAccountPda: req.savingsAccountPda,
    holder: req.holder,
    openedSlot: req.openedSlot,
    currency: req.currency,
    minBalance: req.minBalance,
    ...(req.apyBps !== undefined ? { apyBps: req.apyBps } : {}),
    ...(req.tier !== undefined ? { tier: req.tier } : {}),
    issuanceDate: new Date(nowUnix * 1000).toISOString(),
  });

  return issueCredential(deps, kind, bindingKey, req.subjectAgentCardPubkey, vc);
}

/**
 * Issue a `card.debit.v1` credential.
 *
 * Idempotent on `(cardIdHash, subjectAgentCardPubkey)` repeats.
 */
export async function issueCardCredential(
  deps: BankIssuerDeps,
  req: IssueCardInput,
): Promise<BankIssueResponse> {
  if (req.subjectAgentCardPubkey.length === 0) {
    throw new BankIssuerError(
      "invalid_request",
      "subjectAgentCardPubkey is empty",
      "empty_card",
    );
  }
  if (req.cardIdHash.length === 0) {
    throw new BankIssuerError(
      "invalid_request",
      "cardIdHash is empty",
      "empty_binding_key",
    );
  }

  const kind: BankCredentialKind = "card.debit";
  const bindingKey = req.cardIdHash;

  // Step 1 — idempotency pre-check
  const existing = await deps.store.get(kind, bindingKey);
  if (existing !== undefined) {
    if (existing.agentCardPubkey !== req.subjectAgentCardPubkey) {
      throw new BankIssuerError(
        "binding_conflict",
        "card already bound to a different AgentCard",
        `bound_card=${existing.agentCardPubkey}`,
      );
    }
    return {
      status: "idempotent",
      credentialPda: existing.credentialPda,
      txSignature: existing.txSignature,
      claimUri: existing.claimUri,
      bindingKey,
    };
  }

  const nowUnix = (deps.nowUnix ?? defaultNowUnix)();
  const vc = buildCardDebitVc({
    subjectAgentCardPubkey: req.subjectAgentCardPubkey,
    issuerAuthorityPubkey: deps.issuerAuthorityPubkey,
    cardIdHash: req.cardIdHash,
    holder: req.holder,
    linkedAccountPda: req.linkedAccountPda,
    jurisdiction: req.jurisdiction,
    issuedSlot: req.issuedSlot,
    spendingLimitPerDay: req.spendingLimitPerDay,
    ...(req.expiresSlot !== undefined ? { expiresSlot: req.expiresSlot } : {}),
    ...(req.spendingLimitPerTx !== undefined ? { spendingLimitPerTx: req.spendingLimitPerTx } : {}),
    ...(req.merchantCategoryBlocklist !== undefined ? { merchantCategoryBlocklist: req.merchantCategoryBlocklist } : {}),
    ...(req.networkBrand !== undefined ? { networkBrand: req.networkBrand } : {}),
    ...(req.tier !== undefined ? { tier: req.tier } : {}),
    issuanceDate: new Date(nowUnix * 1000).toISOString(),
  });

  return issueCredential(deps, kind, bindingKey, req.subjectAgentCardPubkey, vc);
}

/**
 * Revoke a previously-issued bank credential by `(kind, bindingKey)`.
 *
 * Idempotent: a second call returns `status: "already_revoked"` without
 * re-submitting a chain tx. Throws `BankIssuerError("not_found")` if
 * no credential has been issued for the given `(kind, bindingKey)`.
 */
export async function revokeBankCredential(
  deps: BankIssuerDeps,
  req: BankRevokeRequest,
): Promise<BankRevokeResponse> {
  const { kind, bindingKey } = req;

  if (bindingKey.length === 0) {
    throw new BankIssuerError(
      "invalid_request",
      "bindingKey is empty",
      "empty_binding_key",
    );
  }

  const row = await deps.store.get(kind, bindingKey);
  if (row === undefined) {
    throw new BankIssuerError(
      "not_found",
      `no credential issued for kind=${kind} bindingKey=${bindingKey}`,
      bindingKey,
    );
  }

  if (row.revoked) {
    return {
      status: "already_revoked",
      credentialPda: row.credentialPda,
      revokeTxSignature: row.revokeTxSignature ?? "",
      bindingKey,
    };
  }

  let revokeResult;
  try {
    revokeResult = await deps.revoker.revokeCredential({
      credentialPda: row.credentialPda,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new BankIssuerError(
      "chain_failed",
      `RevokeCredential tx failed: ${message}`,
    );
  }

  const nowUnix = (deps.nowUnix ?? defaultNowUnix)();
  await deps.store.markRevoked({
    kind,
    bindingKey,
    revokedAtUnix: nowUnix,
    revokeTxSignature: revokeResult.txSignature,
  });

  return {
    status: "revoked",
    credentialPda: row.credentialPda,
    revokeTxSignature: revokeResult.txSignature,
    bindingKey,
  };
}

// ---------------------------------------------------------------------------
// InMemoryBankIssuerStore
// ---------------------------------------------------------------------------

/**
 * Reference in-memory store for dev/tests.
 *
 * Store key: `${kind}\u0000${bindingKey}` — the null-byte separator
 * prevents collisions between kinds whose binding keys share a prefix
 * (same pattern as `skill-cert.ts`).
 *
 * Production wires a durable store (Postgres/SQLite) — that adapter
 * is a separate follow-up task.
 */
export class InMemoryBankIssuerStore implements BankIssuerStore {
  private readonly rows = new Map<string, BankIssuerRow>();

  private key(kind: BankCredentialKind, bindingKey: string): string {
    return `${kind}\u0000${bindingKey}`;
  }

  public async get(
    kind: BankCredentialKind,
    bindingKey: string,
  ): Promise<BankIssuerRow | undefined> {
    return this.rows.get(this.key(kind, bindingKey));
  }

  public async putIfAbsent(row: BankIssuerRow): Promise<BankIssuerRow> {
    const k = this.key(row.kind, row.bindingKey);
    const existing = this.rows.get(k);
    if (existing !== undefined) return existing;
    this.rows.set(k, row);
    return row;
  }

  public async markRevoked(input: {
    readonly kind: BankCredentialKind;
    readonly bindingKey: string;
    readonly revokedAtUnix: number;
    readonly revokeTxSignature: string;
  }): Promise<BankIssuerRow> {
    const k = this.key(input.kind, input.bindingKey);
    const existing = this.rows.get(k);
    if (existing === undefined) {
      throw new Error(
        `markRevoked: unknown kind=${input.kind} bindingKey=${input.bindingKey}`,
      );
    }
    if (existing.revoked) return existing;
    const updated: BankIssuerRow = {
      ...existing,
      revoked: true,
      revokedAtUnix: input.revokedAtUnix,
      revokeTxSignature: input.revokeTxSignature,
    };
    this.rows.set(k, updated);
    return updated;
  }
}
