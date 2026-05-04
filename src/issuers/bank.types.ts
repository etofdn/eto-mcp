/**
 * Public types for the bank real-issuer service (`bank.ts`, FN-097).
 *
 * # Case-conversion convention
 *
 * TypeScript input types (`IssueCheckingInput`, `IssueSavingsInput`,
 * `IssueCardInput`) use **camelCase** field names following TypeScript
 * idioms. The emitted VC `credentialSubject` object uses **snake_case**
 * keys that match the schema-of-record (handler body for checking;
 * JSON Schema for savings / card). The conversion is explicit and
 * one-directional — no runtime reflection, no library. Every build* VC
 * factory function in `bank.ts` performs the camelCase → snake_case
 * mapping inline so the mapping is co-located with the VC shape.
 *
 * # Production vs. stub boundaries
 *
 * `BankIssuerDeps.chain` and `.revoker` are prod chain clients when
 * wired at gateway boot; in tests they are `vi.fn()` fakes. The
 * `InMemoryBankIssuerStore` is the only bundled store — prod wiring
 * to Postgres/SQLite is a separate follow-up task.
 *
 * @module bank.types
 */

// Re-export shared interface contracts from bank-mock.types so production
// wiring can share a single chain client instance across all issuers.
export type {
  IssueCredentialClient,
  RevokeCredentialClient,
  VcPinner,
  SlotClock,
} from "./bank-mock.types.js";

// ---------------------------------------------------------------------------
// Kind + schema label map
// ---------------------------------------------------------------------------

/**
 * The three credential families the bank real-issuer handles.
 * Used as the first component of every store key.
 */
export type BankCredentialKind =
  | "account.checking"
  | "account.savings"
  | "card.debit";

/**
 * Pre-image strings whose SHA-256 hashes become on-chain schema IDs.
 * Convention: `sha256(utf8("eto.beckn.schema.<label>.v1"))`.
 * `as const` ensures the map is immutable and type-safe.
 */
export const BANK_ISSUER_SCHEMA_LABELS: Readonly<
  Record<BankCredentialKind, string>
> = Object.freeze({
  "account.checking": "eto.beckn.schema.account.checking.v1",
  "account.savings": "eto.beckn.schema.account.savings.v1",
  "card.debit": "eto.beckn.schema.card.debit.v1",
} as const);

// ---------------------------------------------------------------------------
// Per-kind input interfaces (camelCase fields on the TypeScript side)
// ---------------------------------------------------------------------------

/**
 * Input for issuing an `account.checking.v1` credential.
 *
 * Schema-of-record: `open-checking.ts` → `OpenCheckingResult.credential.body`
 * (`account_pda`, `holder`, `opened_slot`, `currency: 'eUSD'`, `opening_balance`).
 * The binding key is `checkingAccountPda`.
 */
export interface IssueCheckingInput {
  /** Subject's AgentCard pubkey (hex64). */
  readonly subjectAgentCardPubkey: string;
  /**
   * On-chain CheckingAccount PDA (hex64).
   * Natural binding key: at most one credential per PDA.
   */
  readonly checkingAccountPda: string;
  /** Pubkey of the AgentCard that owns the account (hex64). */
  readonly holder: string;
  /** Slot at which the account was opened. */
  readonly openedSlot: number;
  /** Always `'eUSD'` in v0. */
  readonly currency: "eUSD";
  /** Opening balance in atomic eUSD units (≥0). */
  readonly openingBalance: number;
}

/**
 * Input for issuing an `account.savings.v1` credential.
 *
 * Schema-of-record: `spec/banking/credentials/account-savings.json`
 * (JSON Schema draft 2020-12). Required: `account_pda`, `holder`,
 * `opened_slot`, `currency: 'eUSD'`, `min_balance`.
 * Optional: `apy_bps` (0–10 000), `tier`.
 * The binding key is `savingsAccountPda`.
 */
export interface IssueSavingsInput {
  /** Subject's AgentCard pubkey (hex64). */
  readonly subjectAgentCardPubkey: string;
  /**
   * On-chain SavingsAccount PDA (hex64).
   * Natural binding key: at most one credential per PDA.
   */
  readonly savingsAccountPda: string;
  /** Pubkey of the AgentCard that owns the account (hex64). */
  readonly holder: string;
  /** Slot at which the account was opened. */
  readonly openedSlot: number;
  /** Always `'eUSD'` in v0. */
  readonly currency: "eUSD";
  /** Minimum balance in atomic eUSD units (≥0). */
  readonly minBalance: number;
  /** Annual percentage yield in basis points (0–10 000). Optional. */
  readonly apyBps?: number;
  /** Account tier. Optional. */
  readonly tier?: "standard" | "premium" | "private";
}

/**
 * Input for issuing a `card.debit.v1` credential.
 *
 * Schema-of-record: `spec/banking/credentials/card-debit.json`
 * (JSON Schema draft 2020-12). Required: `holder`, `linked_account_pda`,
 * `jurisdiction`, `card_id_hash`, `issued_slot`, `spending_limit_per_day`.
 * Optional: `expires_slot`, `spending_limit_per_tx`,
 * `merchant_category_blocklist`, `network_brand`, `tier`.
 *
 * Note: `card_id_hash` is the **salted SHA-256 of the card PAN**, NOT
 * a last-4 suffix. It must be opaque to prevent PAN reconstruction.
 * The binding key is `cardIdHash`.
 *
 * Jurisdiction is lowercase ISO 3166-1 alpha-2 (e.g. `"us"`, `"gb"`).
 * v0 stores jurisdiction as a `credentialSubject` field; a future
 * jurisdiction-suffixed schema split is intentionally deferred.
 */
export interface IssueCardInput {
  /** Subject's AgentCard pubkey (hex64). */
  readonly subjectAgentCardPubkey: string;
  /**
   * Salted SHA-256 of card PAN (hex64).
   * Natural binding key: at most one credential per card hash.
   */
  readonly cardIdHash: string;
  /** Pubkey of the AgentCard holding the card (hex64). */
  readonly holder: string;
  /** Pubkey of the CheckingAccount PDA this card debits (hex64). */
  readonly linkedAccountPda: string;
  /** Lowercase ISO 3166-1 alpha-2 (e.g. `"us"`). */
  readonly jurisdiction: string;
  /** Slot at which the card is considered issued. */
  readonly issuedSlot: number;
  /** Max debit per 24h in atomic eUSD units (≥0). */
  readonly spendingLimitPerDay: number;
  /** Slot at which the credential expires. 0 = no expiry. Optional. */
  readonly expiresSlot?: number;
  /** Max debit per single tx in atomic eUSD units. Optional. */
  readonly spendingLimitPerTx?: number;
  /** MCC codes blocked for this card (4-digit strings). Optional. */
  readonly merchantCategoryBlocklist?: string[];
  /** Card network. Optional. */
  readonly networkBrand?: "visa" | "mastercard" | "amex" | "internal";
  /** Card tier. Optional. */
  readonly tier?: "standard" | "premium" | "metal";
}

// ---------------------------------------------------------------------------
// Shared response shapes
// ---------------------------------------------------------------------------

/**
 * Returned by every `issue*Credential` function.
 * Mirrors `BankMockIssueResponse` with a generic `bindingKey` field
 * instead of the mock-specific `checkingAccountId`.
 */
export type BankIssueResponse =
  | {
      readonly status: "issued";
      readonly credentialPda: string;
      readonly txSignature: string;
      readonly claimUri: string;
      readonly claimHashHex: string;
      readonly bindingKey: string;
    }
  | {
      readonly status: "idempotent";
      readonly credentialPda: string;
      readonly txSignature: string;
      readonly claimUri: string;
      readonly bindingKey: string;
    };

/** Request to revoke a previously-issued bank credential. */
export interface BankRevokeRequest {
  readonly kind: BankCredentialKind;
  readonly bindingKey: string;
}

export type BankRevokeResponse =
  | {
      readonly status: "revoked";
      readonly credentialPda: string;
      readonly revokeTxSignature: string;
      readonly bindingKey: string;
    }
  | {
      readonly status: "already_revoked";
      readonly credentialPda: string;
      readonly revokeTxSignature: string;
      readonly bindingKey: string;
    };

// ---------------------------------------------------------------------------
// Persistent store row + interface
// ---------------------------------------------------------------------------

/**
 * One row in the issuer's dedupe + revocation index.
 *
 * Store key (external, not stored in row): `${kind}\u0000${bindingKey}`.
 * The null-byte separator prevents collisions between kinds whose
 * binding keys happen to share a prefix (same pattern as skill-cert.ts).
 */
export interface BankIssuerRow {
  readonly kind: BankCredentialKind;
  readonly bindingKey: string;
  readonly agentCardPubkey: string;
  readonly credentialPda: string;
  readonly txSignature: string;
  readonly claimUri: string;
  readonly issuedAtUnix: number;
  readonly revoked: boolean;
  readonly revokedAtUnix?: number;
  readonly revokeTxSignature?: string;
}

export interface BankIssuerStore {
  get(kind: BankCredentialKind, bindingKey: string): Promise<BankIssuerRow | undefined>;
  /**
   * Atomic put-if-absent. Returns the row that ultimately occupies
   * the `(kind, bindingKey)` slot — `row` if we won the race, or a
   * pre-existing row if someone else won.
   */
  putIfAbsent(row: BankIssuerRow): Promise<BankIssuerRow>;
  /**
   * Mark an existing row as revoked. Idempotent on repeated calls.
   * Throws if the row does not exist.
   */
  markRevoked(input: {
    readonly kind: BankCredentialKind;
    readonly bindingKey: string;
    readonly revokedAtUnix: number;
    readonly revokeTxSignature: string;
  }): Promise<BankIssuerRow>;
}

// ---------------------------------------------------------------------------
// Deps interface
// ---------------------------------------------------------------------------

import type {
  IssueCredentialClient,
  RevokeCredentialClient,
  VcPinner,
  SlotClock,
} from "./bank-mock.types.js";

export interface BankIssuerDeps {
  readonly store: BankIssuerStore;
  readonly chain: IssueCredentialClient;
  readonly revoker: RevokeCredentialClient;
  readonly pinner: VcPinner;
  readonly clock: SlotClock;
  /**
   * Bank issuer authority pubkey (hex64 or base58; recorded inside the
   * off-chain VC). Accept via DI — do NOT hard-code a pubkey here.
   */
  readonly issuerAuthorityPubkey: string;
  /** Wall-clock for VC `issuanceDate` and store row timestamps. */
  readonly nowUnix?: () => number;
  /**
   * Optional CSPRNG hook for `claimCommitments` salt generation
   * (§10.3.1). Defaults to `globalThis.crypto.getRandomValues`. Tests
   * inject a deterministic generator to pin commitment outputs and
   * thereby pin `claim_hash` for KAT regression coverage.
   */
  readonly randomBytes?: (len: number) => Uint8Array;
}

// ---------------------------------------------------------------------------
// Error taxonomy
// ---------------------------------------------------------------------------

/**
 * Error kinds for BankIssuer operations.
 *
 * - `binding_conflict` → 409 (binding key already bound to a different AgentCard).
 * - `not_found`        → 404 (revoke called for an unknown binding key).
 * - `chain_failed`     → 502 (on-chain tx failed; store NOT mutated).
 * - `invalid_request`  → 400 (malformed / empty input).
 */
export type BankIssuerErrorKind =
  | "binding_conflict"
  | "not_found"
  | "chain_failed"
  | "invalid_request";

export class BankIssuerError extends Error {
  public override readonly name = "BankIssuerError";
  public readonly kind: BankIssuerErrorKind;
  public readonly detail?: string;

  public constructor(
    kind: BankIssuerErrorKind,
    message: string,
    detail?: string,
  ) {
    super(message);
    this.kind = kind;
    if (detail !== undefined) {
      this.detail = detail;
    }
  }
}
