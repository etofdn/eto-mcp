// `bank.fiat-ramp-test` mock issuer — public types.
//
// In v0 the bank is mocked end-to-end: there is no real BPP, no real
// core-banking system, and no KYC vendor. The only thing this issuer
// needs to attest is that the bridge has accepted a "checking
// account opened" event for some mock checking-account-id. We bind
// the resulting `bank.fiat-ramp-test` credential to that
// checking-account-id so the issuance is auditable, idempotent, and
// — most importantly — *revocable* by checking-account-id.

/**
 * Submits an `IssueCredential` instruction to the Singularity-ID
 * program. Production wires this to `@eto/wallet-sdk`; tests stub it.
 *
 * Mirrors the shape used by the Civic / Worldcoin issuers so all
 * three adapters can share a single chain client at gateway boot.
 */
export interface IssueCredentialClient {
  issueCredential(input: {
    readonly subjectAgentCardPubkey: string;
    readonly schemaIdHex: string;
    readonly claimUri: string;
    readonly claimHashHex: string;
    readonly validFromSlot: bigint;
    readonly validUntilSlot: bigint;
  }): Promise<{
    readonly credentialPda: string;
    readonly txSignature: string;
  }>;
}

/**
 * Submits a `RevokeCredential` instruction. Separate interface from
 * `IssueCredentialClient` because revocation is authority-scoped and
 * may be wired to a different signer in production (e.g. an admin
 * console rather than the issuance bridge).
 */
export interface RevokeCredentialClient {
  revokeCredential(input: {
    readonly credentialPda: string;
  }): Promise<{
    readonly txSignature: string;
  }>;
}

/**
 * Off-chain VC pinning — production uses an IPFS pinning service;
 * tests use an in-memory pinner.
 */
export interface VcPinner {
  pin(jcsCanonicalJson: string): Promise<{ readonly uri: string }>;
}

/** Returns the current chain slot. Injected so tests are deterministic. */
export interface SlotClock {
  currentSlot(): Promise<bigint>;
}

/**
 * Persistent dedupe + revocation row, keyed by checking-account-id.
 *
 * The store is the bridge's source-of-truth for which credential PDA
 * was minted for which mock checking account: an idempotent re-issue
 * returns the existing row, and a revoke call looks the row up by
 * `checkingAccountId` to discover the PDA to flip on-chain.
 */
export interface BankMockRow {
  readonly checkingAccountId: string;
  readonly agentCardPubkey: string;
  readonly credentialPda: string;
  readonly txSignature: string;
  readonly claimUri: string;
  readonly issuedAtUnix: number;
  readonly revoked: boolean;
  readonly revokedAtUnix?: number;
  readonly revokeTxSignature?: string;
}

export interface BankMockStore {
  get(checkingAccountId: string): Promise<BankMockRow | undefined>;
  /**
   * Atomic put-if-absent. Returns the row that ultimately occupies
   * the `checkingAccountId` slot — `row` if we won the race, or a
   * pre-existing row if someone else won.
   */
  putIfAbsent(row: BankMockRow): Promise<BankMockRow>;
  /**
   * Mark an existing row as revoked. Idempotent: calling twice with
   * the same checking-account-id is a no-op on the second call.
   * Throws if the row does not exist.
   */
  markRevoked(input: {
    readonly checkingAccountId: string;
    readonly revokedAtUnix: number;
    readonly revokeTxSignature: string;
  }): Promise<BankMockRow>;
}

export interface BankMockIssuerDeps {
  readonly store: BankMockStore;
  readonly chain: IssueCredentialClient;
  readonly revoker: RevokeCredentialClient;
  readonly pinner: VcPinner;
  readonly clock: SlotClock;
  /** Issuer authority pubkey (base58); recorded inside the off-chain VC. */
  readonly issuerAuthorityPubkey: string;
  /** Wall-clock for VC `issuanceDate` and store row timestamps. */
  readonly nowUnix?: () => number;
}

export interface BankMockIssueRequest {
  /** Mock bank's stable id for the newly-opened checking account. */
  readonly checkingAccountId: string;
  /** Subject's AgentCard pubkey (base58). */
  readonly agentCardPubkey: string;
}

export type BankMockIssueResponse =
  | {
      readonly status: "issued";
      readonly credentialPda: string;
      readonly txSignature: string;
      readonly claimUri: string;
      readonly claimHashHex: string;
      readonly checkingAccountId: string;
    }
  | {
      readonly status: "idempotent";
      readonly credentialPda: string;
      readonly txSignature: string;
      readonly claimUri: string;
      readonly checkingAccountId: string;
    };

export interface BankMockRevokeRequest {
  readonly checkingAccountId: string;
}

export type BankMockRevokeResponse =
  | {
      readonly status: "revoked";
      readonly credentialPda: string;
      readonly revokeTxSignature: string;
      readonly checkingAccountId: string;
    }
  | {
      readonly status: "already_revoked";
      readonly credentialPda: string;
      readonly revokeTxSignature: string;
      readonly checkingAccountId: string;
    };

/**
 * Bridge-level errors the gateway maps to HTTP statuses.
 *
 * - `binding_conflict` → 409 (checking-account already bound to a
 *   different AgentCard).
 * - `not_found`        → 404 (revoke called for an unknown id).
 * - `chain_failed`     → 502 (chain tx failed; no store mutation).
 * - `invalid_request`  → 400 (malformed input).
 */
export type BankMockIssueErrorKind =
  | "binding_conflict"
  | "not_found"
  | "chain_failed"
  | "invalid_request";

export class BankMockIssueError extends Error {
  public override readonly name = "BankMockIssueError";
  public readonly kind: BankMockIssueErrorKind;
  public readonly detail?: string;

  public constructor(
    kind: BankMockIssueErrorKind,
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
