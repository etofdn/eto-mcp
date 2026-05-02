/**
 * Issue Card BPP handler — v0 stub (FN-125 / T-3.12.1.2).
 *
 * Issues a `card.debit-test` credential (`card.debit.<jurisdiction>.v1`)
 * against an existing CheckingAccount PDA. The flow:
 *
 *   1. Validates request fields (pubkeys, jurisdiction, limits).
 *   2. Re-checks holder credentials via `REQUIRED_SCHEMAS` gate
 *      (verified-human + kyc.us-test — same gate as account-open).
 *   3. Confirms the linked CheckingAccount exists and is owned by subject
 *      (STUBBED true in v0).
 *   4. Derives a deterministic `card_pda` from (subject, linked_account_pda,
 *      issued_slot) using SHA-256.
 *   5. Derives `card_id_hash` from `card_pda` with an explicit stub salt.
 *      NO real PAN, BIN, or network token material is generated in v0.
 *   6. Side-effects (order matters):
 *      a. `recordCard` — write to local ledger (catch → `ledger_failed`).
 *      b. `issueCardCredential` — submit on-chain credential instruction
 *         (catch → `issue_failed`).
 *
 * NOTE on atomicity: step 6a/6b are NOT wrapped in a distributed
 * transaction. If step 6b fails after 6a succeeds, the ledger record
 * is orphaned. A v1 GC sweeper that reconciles orphaned ledger entries
 * against the on-chain credential set is a follow-up task.
 *
 * Credential body conforms to `spec/banking/credentials/card-debit.json`
 * (`$id: https://spec.eto.network/banking/credentials/card-debit.v1.json`,
 * `additionalProperties: false`). Jurisdiction locked to `"us"` by default.
 */

import { createHash } from "node:crypto";

import {
  issueCardCredential as issueCardCredentialReal,
  type BankIssuerDeps,
  type IssueCardInput,
  BankIssuerError,
} from "../../../../src/issuers/bank.js";
import { defaultBankLedger } from "../credential-ledger.js";

// ---------------------------------------------------------------------------
// Schema gate
// ---------------------------------------------------------------------------

/**
 * Schema pre-image strings (NOT hashes) checked against the on-chain
 * credential set before issuance. Mirrors the account-open policy —
 * issuing a debit card requires a KYC'd verified human.
 */
export const REQUIRED_SCHEMAS: readonly [string, string] = Object.freeze([
  "eto.beckn.schema.verified-human.v1",
  "eto.beckn.schema.kyc.us-test.v1",
] as const);

// ---------------------------------------------------------------------------
// Request / Result types
// ---------------------------------------------------------------------------

export interface IssueCardRequest {
  /** Pubkey of the agent/account holder (hex64). */
  subject: string;
  /** Pubkey of the bank issuer (hex64). */
  bank_issuer: string;
  /** PDA of the CheckingAccount to link (hex64). */
  linked_account_pda: string;
  /** Slot at which the card is considered issued. */
  issued_slot: number;
  /** ISO 3166-1 alpha-2, lowercase. Default: "us". */
  jurisdiction?: string;
  /** Max debit per 24h in atomic eUSD units. Default: 5_000_000_000. */
  spending_limit_per_day_atomic?: number;
  /** Max debit per single transaction. Default: 500_000_000. */
  spending_limit_per_tx_atomic?: number;
  /** Slot at which the credential expires. 0 = no expiry. Default: 0. */
  expires_slot?: number;
  /**
   * MCC codes blocked for this card (4-digit strings). Optional —
   * absent = no merchant category restrictions. Added in FN-103.
   */
  merchant_category_blocklist?: string[];
}

/** Credential body that satisfies `card-debit.json` (jurisdiction = "us"). */
export interface CardDebitCredentialBody {
  holder: string;
  linked_account_pda: string;
  jurisdiction: string;
  card_id_hash: string;
  issued_slot: number;
  expires_slot: number;
  spending_limit_per_day: number;
  spending_limit_per_tx: number;
  network_brand: "internal";
  tier: "standard";
  /**
   * MCC codes blocked for this card (4-digit strings). Optional;
   * absent = no merchant category restrictions. Added in FN-103.
   */
  merchant_category_blocklist?: string[];
}

export interface IssueCardCredential {
  schema: `card.debit.${string}.v1`;
  subject: string;
  issuer: string;
  body: CardDebitCredentialBody;
}

export interface IssueCardResult {
  card_pda: string;
  credential: IssueCardCredential;
  fulfillment_uri: string;
}

// ---------------------------------------------------------------------------
// Deps interface
// ---------------------------------------------------------------------------

export interface IssueCardDeps {
  /**
   * Gate check: verify the subject holds all `schemas`. Returns true if
   * all required on-chain credentials are active and un-revoked.
   * STUBBED true in v0.
   */
  verifyHolderCredentials(
    subject: string,
    schemas: readonly string[],
  ): Promise<boolean>;

  /**
   * Confirm the CheckingAccount PDA exists in the mock ledger and is
   * owned by `holder`. STUBBED true in v0.
   */
  verifyLinkedAccount(
    linked_account_pda: string,
    holder: string,
  ): Promise<boolean>;

  /**
   * Submit on-chain `IssueCredential` instruction for the card credential.
   * Returns the transaction signature and the resulting credential PDA.
   */
  issueCardCredential(cred: IssueCardCredential): Promise<{
    tx_signature: string;
    credential_pda: string;
  }>;

  /**
   * Record the issued card in the local off-chain ledger. Called BEFORE
   * `issueCardCredential` so the ledger entry exists before the on-chain
   * instruction lands.
   */
  recordCard(pda: string, card: CardDebitCredentialBody): Promise<void>;

  /**
   * FN-191: orphan-ledger reconciliation hook. Called from the
   * `issue_failed` path AFTER `recordCard` succeeded but the on-chain
   * `issueCardCredential` threw. Mirrors the `flagReconciliation` hook
   * in `offramp.ts` so ops can take corrective action and the eventual
   * GC sweeper can find the orphan via this signal instead of
   * scanning the entire ledger.
   *
   * Implementations MUST be idempotent — the runtime may invoke this
   * more than once for the same `card_pda` (retry storms, replays).
   */
  flagReconciliation(
    card_pda: string,
    holder: string,
    body: CardDebitCredentialBody,
  ): Promise<void>;
}

// ---------------------------------------------------------------------------
// Error class
// ---------------------------------------------------------------------------

export type IssueCardRejectedReason =
  | "invalid_pubkey"
  | "invalid_jurisdiction"
  | "invalid_limit"
  | "credentials_missing"
  | "account_not_found"
  | "issue_failed"
  | "ledger_failed";

export class IssueCardRejected extends Error {
  constructor(public readonly reason: IssueCardRejectedReason) {
    super("issue-card rejected: " + reason);
  }
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

const HEX64 = /^[0-9a-fA-F]{64}$/;
const JURISDICTION_RE = /^[a-z]{2}$/;

/** Encode `n` as big-endian unsigned 64-bit (8 bytes). */
function u64BE(n: number): Buffer {
  return Buffer.from(BigInt(n).toString(16).padStart(16, "0"), "hex");
}

function sha256(...parts: Buffer[]): string {
  const h = createHash("sha256");
  for (const p of parts) h.update(p);
  return h.digest("hex");
}

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

/**
 * Issue a `card.debit.<jurisdiction>.v1` credential against an existing
 * CheckingAccount. Returns `{ card_pda, credential, fulfillment_uri }`.
 */
export async function issueCard(
  req: IssueCardRequest,
  deps: IssueCardDeps,
): Promise<IssueCardResult> {
  // --- Defaults ---
  const jurisdiction = req.jurisdiction ?? "us";
  const spending_limit_per_day = req.spending_limit_per_day_atomic ?? 5_000_000_000;
  const spending_limit_per_tx = req.spending_limit_per_tx_atomic ?? 500_000_000;
  const expires_slot = req.expires_slot ?? 0;

  // --- Validation ---
  if (!HEX64.test(req.subject)) throw new IssueCardRejected("invalid_pubkey");
  if (!HEX64.test(req.bank_issuer)) throw new IssueCardRejected("invalid_pubkey");
  if (!HEX64.test(req.linked_account_pda)) throw new IssueCardRejected("invalid_pubkey");

  if (!JURISDICTION_RE.test(jurisdiction)) throw new IssueCardRejected("invalid_jurisdiction");

  if (
    !Number.isInteger(spending_limit_per_day) ||
    spending_limit_per_day < 0
  ) throw new IssueCardRejected("invalid_limit");
  if (
    !Number.isInteger(spending_limit_per_tx) ||
    spending_limit_per_tx < 0
  ) throw new IssueCardRejected("invalid_limit");
  if (spending_limit_per_tx > spending_limit_per_day) throw new IssueCardRejected("invalid_limit");

  // --- On-chain credential gate ---
  const credentialsOk = await deps.verifyHolderCredentials(req.subject, REQUIRED_SCHEMAS);
  if (!credentialsOk) throw new IssueCardRejected("credentials_missing");

  // --- Linked account gate ---
  const accountOk = await deps.verifyLinkedAccount(req.linked_account_pda, req.subject);
  if (!accountOk) throw new IssueCardRejected("account_not_found");

  // --- PDA derivation ---
  const card_pda = sha256(
    Buffer.from("card_debit", "utf8"),
    Buffer.from(req.subject, "hex"),
    Buffer.from(req.linked_account_pda, "hex"),
    u64BE(req.issued_slot),
  );

  // --- card_id_hash — explicit stub salt; NO real PAN material ---
  const card_id_hash = sha256(
    Buffer.from("card_id_v0_stub", "utf8"),
    Buffer.from(card_pda, "hex"),
  );

  const body: CardDebitCredentialBody = {
    holder: req.subject,
    linked_account_pda: req.linked_account_pda,
    jurisdiction,
    card_id_hash,
    issued_slot: req.issued_slot,
    expires_slot,
    spending_limit_per_day,
    spending_limit_per_tx,
    network_brand: "internal",
    tier: "standard",
    ...(req.merchant_category_blocklist !== undefined &&
    req.merchant_category_blocklist.length > 0
      ? { merchant_category_blocklist: req.merchant_category_blocklist }
      : {}),
  };

  const credential: IssueCardCredential = {
    schema: `card.debit.${jurisdiction}.v1`,
    subject: req.subject,
    issuer: req.bank_issuer,
    body,
  };

  // --- Side-effects (ordered: ledger first, then chain) ---
  // NOTE: not atomically transactional. A v1 GC sweeper reconciles orphaned
  // ledger records against the on-chain credential set (follow-up task).
  try {
    await deps.recordCard(card_pda, body);
  } catch {
    throw new IssueCardRejected("ledger_failed");
  }

  try {
    await deps.issueCardCredential(credential);
  } catch {
    // FN-191: ledger entry from recordCard is now orphaned. Flag for
    // reconciliation BEFORE rethrowing so ops gets a deterministic
    // signal and the eventual GC sweeper has a stable handle.
    // flagReconciliation must not throw — if it does, swallow it: the
    // primary error (issue_failed) is what callers care about.
    try {
      await deps.flagReconciliation(card_pda, body.holder, body);
    } catch {
      // intentionally swallowed
    }
    throw new IssueCardRejected("issue_failed");
  }

  return {
    card_pda,
    credential,
    fulfillment_uri: `eto://card/${card_pda}`,
  };
}

// ---------------------------------------------------------------------------
// v0 Stubs
// ---------------------------------------------------------------------------

/** v0 stubs for local development / testing. All gates return true. */
export const stubs: IssueCardDeps = {
  verifyHolderCredentials: async (subject, schemas) => {
    console.log(
      `[STUB] verifyHolderCredentials subject=${subject.slice(0, 8)} schemas=${schemas.join(",")} → true`,
    );
    return true;
  },
  verifyLinkedAccount: async (linked_account_pda, holder) => {
    console.log(
      `[STUB] verifyLinkedAccount pda=${linked_account_pda.slice(0, 8)} holder=${holder.slice(0, 8)} → true`,
    );
    return true;
  },
  issueCardCredential: async (cred) => {
    const tx_signature = createHash("sha256")
      .update("issue_card_tx:" + cred.body.card_id_hash)
      .digest("hex");
    const credential_pda = createHash("sha256")
      .update("credential_pda:" + cred.body.card_id_hash)
      .digest("hex");
    console.log(
      `[STUB] issueCardCredential card_pda=${cred.body.card_id_hash.slice(0, 8)} → tx=${tx_signature.slice(0, 16)}`,
    );
    return { tx_signature, credential_pda };
  },
  recordCard: async (pda, card) => {
    // FN-105: persist to the shared bank credential ledger so the v1
    // GC sweeper sees this entry alongside open-checking entries.
    await defaultBankLedger.recordCard(pda, card);
    console.log(
      `[STUB] recordCard pda=${pda.slice(0, 8)} holder=${card.holder.slice(0, 8)} → ledger size=${defaultBankLedger.size()}`,
    );
  },
  flagReconciliation: async (card_pda, holder, _body) => {
    // FN-191 stub — mirrors offramp's flagReconciliation logger.
    console.warn(
      `[STUB] RECONCILE NEEDED issue-card card_pda=${card_pda.slice(0, 12)} holder=${holder.slice(0, 8)} (issue_failed post-recordCard)`,
    );
  },
};

// ---------------------------------------------------------------------------
// Production issuer adapter (FN-090)
// ---------------------------------------------------------------------------

/**
 * Adapter that wraps `BankIssuerDeps` into the handler's
 * `IssueCardDeps["issueCardCredential"]` port shape.
 *
 * Mirrors `makeProdIssueCheckingCredential` (FN-072) one-for-one:
 *
 *   - Asserts `cred.issuer === bankIssuer.issuerAuthorityPubkey`. A mismatch
 *     throws a plain `Error("issuer authority mismatch")` so callers can
 *     distinguish configuration errors from issuance errors.
 *
 *   - Maps the handler's snake_case `IssueCardCredential.body` fields onto
 *     the camelCase `IssueCardInput` accepted by `src/issuers/bank.ts`.
 *     v0 invariant: `subject IS holder` for single-owner accounts; we
 *     pass `cred.subject` for both `subjectAgentCardPubkey` and `holder`
 *     to match the open-checking adapter's behavior.
 *
 *   - `expires_slot === 0` is the handler's "no expiry" sentinel; we omit
 *     `expiresSlot` from the input rather than passing the zero, so the
 *     downstream issuer's `expiresSlot?: number` semantics aren't
 *     surprised by a literal-zero value.
 *
 *   - `BankIssuerError` propagates unchanged — `runIssueCard`'s `catch`
 *     translates it to `IssueCardRejected("issue_failed")`. Do NOT
 *     swallow, log-and-rethrow, or repackage.
 *
 * @param bankIssuer - Fully-wired `BankIssuerDeps` instance (store, chain,
 *   revoker, pinner, clock, issuerAuthorityPubkey).
 */
export function makeProdIssueCardCredential(
  bankIssuer: BankIssuerDeps,
): IssueCardDeps["issueCardCredential"] {
  return async (cred: IssueCardCredential) => {
    if (cred.issuer !== bankIssuer.issuerAuthorityPubkey) {
      throw new Error("issuer authority mismatch");
    }

    // Map handler's snake_case body → IssueCardInput camelCase.
    // handler invariant: subject IS holder for v0 (single-owner accounts).
    const req: IssueCardInput = {
      subjectAgentCardPubkey: cred.subject,             // cred.subject → subjectAgentCardPubkey
      cardIdHash: cred.body.card_id_hash,               // cred.body.card_id_hash → cardIdHash
      holder: cred.subject,                             // cred.subject → holder (invariant)
      linkedAccountPda: cred.body.linked_account_pda,   // cred.body.linked_account_pda → linkedAccountPda
      jurisdiction: cred.body.jurisdiction,             // cred.body.jurisdiction → jurisdiction
      issuedSlot: cred.body.issued_slot,                // cred.body.issued_slot → issuedSlot
      spendingLimitPerDay: cred.body.spending_limit_per_day,
      spendingLimitPerTx: cred.body.spending_limit_per_tx,
      ...(cred.body.expires_slot !== 0
        ? { expiresSlot: cred.body.expires_slot }
        : {}),
      // FN-103: thread the MCC blocklist when set on the body.
      ...(cred.body.merchant_category_blocklist !== undefined &&
      cred.body.merchant_category_blocklist.length > 0
        ? { merchantCategoryBlocklist: cred.body.merchant_category_blocklist }
        : {}),
      networkBrand: cred.body.network_brand,            // "internal" in v0
      tier: cred.body.tier,                             // "standard" in v0
    };

    // Call the real issuer. BankIssuerError propagates unchanged — the
    // handler's catch block translates it to IssueCardRejected("issue_failed").
    const response = await issueCardCredentialReal(bankIssuer, req);

    // Unwrap the response regardless of "issued" or "idempotent" status.
    return {
      tx_signature: response.txSignature,
      credential_pda: response.credentialPda,
    };
  };
}

// Suppress unused-import warning for re-exported error class — callers may
// need to `instanceof BankIssuerError` while wiring the adapter.
export { BankIssuerError };
