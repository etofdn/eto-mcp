// kyc.us-test mock issuer — public types (T-1.4.2.1, FN-040).
//
// `kyc.us-test` is **not real KYC**. It exists so the demo can show
// the gating mechanism (a credential that satisfies a `schema =
// kyc.us-test` predicate on a relying-party offer) without us having
// to integrate a regulated KYC partner before the milestone. The
// ergonomics are a 30-second mock flow: the wallet UI renders a
// `name + DOB` form and posts the result to the bridge, which
// enforces a minimum form-dwell time and then issues the credential.
//
// The shape mirrors `civic.types.ts` so swapping the mock for a real
// `kyc.us` adapter later is a `*.types.ts` rename plus a real
// `KycVerifier` implementation; the wiring at the bridge stays the
// same.

/**
 * Form fields the wallet UI posts. `flowStartedAtUnix` is the wall
 * clock the form was rendered at, used to enforce the 30-second
 * dwell. The bridge does not trust the field on its own — it must
 * be inside an HMAC-signed `formToken` (see `KycTestFormTokenSigner`)
 * so a client can't roll the timer back to bypass the dwell.
 */
export interface KycTestFormSubmission {
  readonly fullName: string;
  /** ISO date (YYYY-MM-DD), Gregorian. */
  readonly dobIso: string;
  readonly flowStartedAtUnix: number;
  /**
   * HMAC tag over `${fullName}|${dobIso}|${flowStartedAtUnix}` from
   * the form-token signer. Prevents trivial replay of an old
   * `flowStartedAtUnix` without going through a real form render.
   */
  readonly formTokenHmacHex: string;
}

/**
 * Minimum dwell, in seconds, between rendering the form and accepting
 * the submission. The "30-second mock flow" requirement from FN-040.
 * Exported so tests and config can reference the same constant.
 */
export const KYC_TEST_MIN_DWELL_SECONDS = 30;

/**
 * Pluggable form-token signer. The bridge mints a token at
 * `GET /issuers/kyc-test` time and verifies it on POST. Stubbed in
 * tests; production uses `crypto.createHmac` keyed by a server
 * secret.
 */
export interface KycTestFormTokenSigner {
  sign(payload: {
    readonly fullName: string;
    readonly dobIso: string;
    readonly flowStartedAtUnix: number;
  }): string;
  verify(payload: {
    readonly fullName: string;
    readonly dobIso: string;
    readonly flowStartedAtUnix: number;
    readonly tag: string;
  }): boolean;
}

/**
 * Persistent dedupe row. Same shape as `CivicDedupeRow`. Keyed by
 * `nullifier = sha256(domain | normalizedName | dobIso)` so a user
 * can't farm credentials for one identity across many cards.
 */
export interface KycTestDedupeRow {
  readonly nullifier: string;
  readonly agentCardPubkey: string;
  readonly credentialPda: string;
  readonly txSignature: string;
  readonly claimUri: string;
  readonly issuedAtUnix: number;
}

export interface KycTestDedupeStore {
  get(nullifier: string): Promise<KycTestDedupeRow | undefined>;
  putIfAbsent(row: KycTestDedupeRow): Promise<KycTestDedupeRow>;
}

/**
 * Submits an `IssueCredential` instruction. Same contract as the
 * Civic adapter so the gateway can reuse a single chain client.
 */
export interface KycTestIssueCredentialClient {
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

export interface KycTestVcPinner {
  pin(jcsCanonicalJson: string): Promise<{ readonly uri: string }>;
}

export interface KycTestSlotClock {
  currentSlot(): Promise<bigint>;
}

export interface KycTestIssuerDeps {
  readonly tokenSigner: KycTestFormTokenSigner;
  readonly dedupe: KycTestDedupeStore;
  readonly chain: KycTestIssueCredentialClient;
  readonly pinner: KycTestVcPinner;
  readonly clock: KycTestSlotClock;
  /** Issuer authority pubkey (base58); recorded inside the off-chain VC. */
  readonly issuerAuthorityPubkey: string;
  /**
   * Override for the dwell check. Defaults to
   * `KYC_TEST_MIN_DWELL_SECONDS`. Exposed for tests; production should
   * leave the default.
   */
  readonly minDwellSeconds?: number;
  /** Wall-clock — defaults to `Date.now()/1000`. */
  readonly nowUnix?: () => number;
}

export interface KycTestIssueRequest {
  readonly submission: KycTestFormSubmission;
  readonly agentCardPubkey: string;
}

export type KycTestIssueResponse =
  | {
      readonly status: "issued";
      readonly credentialPda: string;
      readonly txSignature: string;
      readonly claimUri: string;
      readonly claimHashHex: string;
      readonly nullifier: string;
    }
  | {
      readonly status: "idempotent";
      readonly credentialPda: string;
      readonly txSignature: string;
      readonly claimUri: string;
      readonly nullifier: string;
    };

/**
 * - `replay_conflict`  → 409 (subject already bound to a different card).
 * - `invalid_form`     → 400 (missing/malformed name or DOB).
 * - `invalid_token`    → 400 (form-token HMAC mismatch).
 * - `dwell_too_short`  → 400 (submission inside the 30-second window).
 * - `dwell_in_future`  → 400 (clock skew / forged future timestamp).
 * - `chain_failed`     → 502 (IssueCredential tx failed).
 */
export type KycTestIssueErrorKind =
  | "replay_conflict"
  | "invalid_form"
  | "invalid_token"
  | "dwell_too_short"
  | "dwell_in_future"
  | "chain_failed";

export class KycTestIssueError extends Error {
  public override readonly name = "KycTestIssueError";
  public readonly kind: KycTestIssueErrorKind;
  public readonly detail?: string;

  public constructor(
    kind: KycTestIssueErrorKind,
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
