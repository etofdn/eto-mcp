// 1099 issuance flow — public types (T-3.13.1.3, FN-132).
//
// Re-imports injectable interfaces (`IssueCredentialClient`, `VcPinner`,
// `SlotClock`) from `bank-mock` so all bank-as-BPP issuers share a
// single set of seams and the gateway can wire them all with one
// chain-client instance.
//
// None of the types here are re-declared; they delegate to the canonical
// shapes in `bank-mock.types.ts` and the FN-130 indexer.

import type {
  IssueCredentialClient,
  VcPinner,
  SlotClock,
} from "../../../../src/issuers/bank-mock.js";
import type { AuditTrailIndexer } from "../../../../src/services/indexer/audit-trail.js";

export type { IssueCredentialClient, VcPinner, SlotClock };

// ---------------------------------------------------------------------------
// Request
// ---------------------------------------------------------------------------

/**
 * Input to `runTax1099Sketch`. All three discriminators
 * `(agentCardAuthority, jurisdiction, taxYear)` identify a unique
 * 1099 period for one holder.
 *
 * Constraints:
 *   - `agentCardAuthority`: non-empty base58 pubkey.
 *   - `taxYear`: integer ≥ 2024.
 *   - `jurisdiction`: exactly two uppercase ASCII letters (ISO-3166-1 α-2).
 *   - `currency`: three uppercase ASCII letters (ISO-4217). Defaults to `"USD"`.
 *   - `formVariant`: one of the four supported 1099 variants. Defaults to
 *     `"1099-MISC"`.
 *   - `issuerAuthorityPubkey`: base58 pubkey of the bank issuer authority;
 *     embedded in the VC `issuerAuthority` field and used as the
 *     `issuerAllowlist` filter for the audit feed.
 *   - `networkPubkey`: base58 pubkey of the Singularity-ID program's
 *     network authority; embedded in `evidence[0].network`.
 */
export type Tax1099SketchRequest = {
  readonly agentCardAuthority: string;
  readonly taxYear: number;
  readonly jurisdiction: string;
  readonly currency?: string;
  readonly formVariant?: "1099-INT" | "1099-MISC" | "1099-NEC" | "1099-K";
  readonly issuerAuthorityPubkey: string;
  readonly networkPubkey: string;
};

// ---------------------------------------------------------------------------
// Totals
// ---------------------------------------------------------------------------

/**
 * Per-year aggregated totals derived from the audit feed.
 *
 * All monetary fields carry decimal strings matching `/^\d+\.\d{2}$/`
 * (e.g. `"0.00"`) as mandated by FN-131. `transactionCount` is an
 * integer. `digestRootBase58` is the base58(sha256) of the
 * deterministically-sorted event array — used as the `evidence`
 * digest root on-chain.
 *
 * **v0 caveat:** monetary fields always return `"0.00"` until
 * FN-117 / FN-118 wire ledger amounts into the KYT event stream.
 */
export type Tax1099Totals = {
  readonly totalIncome: string;
  readonly totalFees: string;
  readonly totalInterestPaid: string;
  readonly totalWithholding: string;
  readonly transactionCount: number;
  readonly digestRootBase58: string;
};

// ---------------------------------------------------------------------------
// VC envelope
// ---------------------------------------------------------------------------

/**
 * Structural type of the JSON-LD VC matching `spec/banking/credentials/tax-1099.json`.
 * Field order follows the spec template exactly.
 *
 * The `proof.proofValue` is the literal string `"<unsigned-v0>"` in this
 * sketch — real Ed25519 signing is a follow-up task (FN-132 caveat).
 */
export type Tax1099VcEnvelope = {
  readonly "@context": [
    "https://www.w3.org/2018/credentials/v1",
    "https://schema.eto.dev/banking/tax-1099/v1",
  ];
  readonly type: ["VerifiableCredential", "Tax1099Credential"];
  readonly issuer: "did:eto:bank:eto-reference";
  readonly issuanceDate: string;
  readonly credentialSubject: {
    readonly id: string;
    readonly type: "Tax1099Statement";
    readonly taxYear: number;
    readonly jurisdiction: string;
    readonly currency: string;
    readonly formVariant: string;
    readonly totalIncome: string;
    readonly totalFees: string;
    readonly totalInterestPaid: string;
    readonly totalWithholding: string;
    readonly transactionCount: number;
    readonly periodStart: string;
    readonly periodEnd: string;
  };
  readonly evidence: [
    {
      readonly type: "EtoChainEventDigest";
      readonly network: string;
      readonly digestRoot: string;
      readonly digestAlgorithm: "sha256";
    },
  ];
  readonly issuerAuthority: string;
  readonly proof?: {
    readonly type: "Ed25519Signature2020";
    readonly verificationMethod: "did:eto:bank:eto-reference#issuer-authority";
    readonly proofValue: string;
  };
};

// ---------------------------------------------------------------------------
// Dependencies
// ---------------------------------------------------------------------------

/**
 * Injected runtime dependencies for `runTax1099Sketch`.
 *
 * `firstSlotOfYear` and `slotsPerYear` override the deterministic v0
 * stubs and allow tests to use a compact slot range. See `tax-1099-sketch.ts`
 * for the default values and their documentation.
 */
export type Tax1099SketchDeps = {
  readonly indexer: AuditTrailIndexer;
  readonly chain: IssueCredentialClient;
  readonly pinner: VcPinner;
  readonly clock: SlotClock;
  readonly nowUnix?: () => number;
  readonly slotsPerYear?: bigint;
  readonly firstSlotOfYear?: (year: number) => bigint;
};

// ---------------------------------------------------------------------------
// Response
// ---------------------------------------------------------------------------

/**
 * Successful result of `runTax1099Sketch`.
 *
 * `status: "issued"` — the credential was freshly issued on-chain.
 * `status: "idempotent"` — reserved for a future idempotency store
 *   (not implemented in v0; see TODO in `tax-1099-sketch.ts`).
 */
export type Tax1099SketchResponse = {
  readonly status: "issued" | "idempotent";
  readonly credentialPda: string;
  readonly txSignature: string;
  readonly claimUri: string;
  readonly claimHashHex: string;
  readonly schemaIdHex: string;
  readonly vc: Tax1099VcEnvelope;
  readonly totals: Tax1099Totals;
};

// ---------------------------------------------------------------------------
// Error
// ---------------------------------------------------------------------------

/**
 * Discriminated error thrown by `runTax1099Sketch`.
 *
 * | `kind`             | HTTP mapping | When                                 |
 * |--------------------|-------------|--------------------------------------|
 * | `invalid_request`  | 400         | Bad input before any I/O             |
 * | `no_activity`      | 422         | Audit feed is empty for the period   |
 * | `indexer_failed`   | 502         | `AuditTrailIndexer` threw            |
 * | `pin_failed`       | 502         | `VcPinner.pin` threw                 |
 * | `chain_failed`     | 502         | `IssueCredentialClient` threw        |
 */
export type Tax1099SketchErrorKind =
  | "invalid_request"
  | "no_activity"
  | "indexer_failed"
  | "pin_failed"
  | "chain_failed";

export class Tax1099SketchError extends Error {
  public override readonly name = "Tax1099SketchError";
  public readonly kind: Tax1099SketchErrorKind;
  public readonly reason?: string;
  public override readonly cause?: unknown;

  public constructor(opts: {
    kind: Tax1099SketchErrorKind;
    message: string;
    reason?: string;
    cause?: unknown;
  }) {
    super(opts.message);
    this.kind = opts.kind;
    if (opts.reason !== undefined) this.reason = opts.reason;
    if (opts.cause !== undefined) this.cause = opts.cause;
  }
}
