/**
 * Type definitions for the Worldcoin → ETO `verified-human` issuer bridge.
 *
 * See `spec/issuers/worldcoin-integration.md` for the design spec this
 * file implements (T-1.4.1.1 / T-1.4.1.2, mission E4).
 */

/** 32-byte value, hex-encoded with `0x` prefix or as plain lowercase hex. */
export type Hex32 = string;

/** Base58 / base64-encoded Ed25519 public key (opaque to this module). */
export type AgentCardPubkey = string;

/** World ID verification level returned by the Cloud verifier. */
export type WorldcoinVerificationLevel = "orb" | "device";

/**
 * Wire-level request body accepted by `POST /issuers/worldcoin/issue`.
 * The wallet UI forwards the IDKit response payload + an Ed25519
 * signature binding the proof to the caller's AgentCard.
 */
export interface WorldcoinIssueRequest {
  /** Worldcoin OIDC ID token (JWT signed by Worldcoin's JWKS). */
  readonly idToken: string;
  /** ZK proof produced by IDKit (opaque base64). */
  readonly proof: string;
  /** Worldcoin merkle root the proof was generated against. */
  readonly merkleRoot: Hex32;
  /** Per-(action, identity) nullifier — uniqueness key. */
  readonly nullifierHash: Hex32;
  /** Reported verification level (orb | device). */
  readonly verificationLevel: WorldcoinVerificationLevel;
  /** Subject AgentCard pubkey the credential will be issued to. */
  readonly agentCardPubkey: AgentCardPubkey;
  /**
   * Wallet's Ed25519 signature over `nullifier_hash || agent_card_pubkey`,
   * proving the wallet — not just any caller — initiated this issuance.
   */
  readonly agentCardSignature: string;
}

/** Wire-level response body for a successful issuance. */
export interface WorldcoinIssueResponse {
  /** PDA address of the on-chain `Credential` record. */
  readonly credentialPda: string;
  /** Signature of the `IssueCredential` tx (`""` on idempotent re-hit). */
  readonly txSignature: string;
  /** `ipfs://<cid>` URI of the off-chain VC envelope. */
  readonly claimUri: string;
  /** `sha256(JCS(claim_json))` — on-chain binding. */
  readonly claimHash: Hex32;
  /** True if this request hit the dedupe cache (no new tx submitted). */
  readonly idempotent: boolean;
}

/**
 * Verified facts extracted from a Worldcoin OIDC ID token.
 * Implementations MUST verify the JWT signature against Worldcoin's JWKS
 * and the `aud`/`iss`/`exp` claims before returning.
 */
export interface VerifiedIdToken {
  /** OIDC subject (Worldcoin opaque user id). */
  readonly sub: string;
  /** Audience — must equal the configured `WORLDCOIN_APP_ID`. */
  readonly aud: string;
  /** Issuer — must equal `https://id.worldcoin.org`. */
  readonly iss: string;
  /** Expiry, seconds since epoch. */
  readonly exp: number;
}

/**
 * Successful response from `POST /api/v2/verify/{appId}`.
 * Failure is signaled by throwing `WorldcoinIssuerError` with a 4xx
 * `code` so callers don't have to type-narrow on `success: false`.
 */
export interface CloudVerifyResult {
  readonly success: true;
  readonly verificationLevel: WorldcoinVerificationLevel;
  readonly nullifierHash: Hex32;
  readonly action: string;
}

/**
 * Persistent record kept by the dedupe store. Bound by `nullifier_hash`,
 * so a re-submission with the same nullifier+card returns this record
 * untouched and a re-submission with a different card is a 409.
 */
export interface NullifierBinding {
  readonly nullifierHash: Hex32;
  readonly agentCardPubkey: AgentCardPubkey;
  readonly credentialPda: string;
  readonly txSignature: string;
  readonly claimUri: string;
  readonly claimHash: Hex32;
  readonly issuedAtMs: number;
}

/**
 * Pluggable persistence for nullifier→binding records. The reference
 * implementation in this module is in-memory (`InMemoryNullifierStore`);
 * production deploys swap in Redis/Postgres.
 */
export interface NullifierStore {
  get(nullifierHash: Hex32): Promise<NullifierBinding | undefined>;
  /**
   * Insert a fresh binding. MUST be atomic w.r.t. concurrent calls —
   * the bridge relies on this to avoid double-issuance on parallel
   * wallet retries. Implementations should fail with a distinguishable
   * error (or return false) on key collision; the `WorldcoinIssuer`
   * tolerates both shapes.
   */
  put(binding: NullifierBinding): Promise<void>;
}

/**
 * Arguments accepted by the on-chain `IssueCredential` instruction, as
 * the bridge sees them. The chain client owns wire-encoding, fee-payer
 * selection, and confirmation polling.
 */
export interface IssueCredentialArgs {
  readonly schema: Hex32;
  readonly subjectAgentCard: AgentCardPubkey;
  readonly claimHash: Hex32;
  readonly claimUri: string;
  /** `0` = no upper bound (the spec default for verified-human). */
  readonly validUntilSlot: bigint;
}

export interface IssueCredentialResult {
  readonly credentialPda: string;
  readonly txSignature: string;
}

/** Submits a signed `IssueCredential` tx and returns the resulting PDA. */
export interface ChainClient {
  issueCredential(args: IssueCredentialArgs): Promise<IssueCredentialResult>;
}

/**
 * Verifies a Worldcoin OIDC `id_token`. Default implementation fetches
 * Worldcoin's JWKS and validates `iss`, `aud`, `exp`; tests inject a
 * fake.
 */
export interface IdTokenVerifier {
  verify(idToken: string): Promise<VerifiedIdToken>;
}

/**
 * Calls the Worldcoin Cloud `/api/v2/verify/{appId}` endpoint.
 * The `signal` is bound to the AgentCard pubkey by the caller so
 * Worldcoin itself attests to the wallet binding inside the proof.
 */
export interface CloudVerifier {
  verifyProof(input: {
    readonly proof: string;
    readonly merkleRoot: Hex32;
    readonly nullifierHash: Hex32;
    readonly signal: Hex32;
    readonly action: string;
  }): Promise<CloudVerifyResult>;
}

/** Verifies the wallet's Ed25519 signature over `nullifier || card_pk`. */
export interface AgentCardSignatureVerifier {
  verify(input: {
    readonly agentCardPubkey: AgentCardPubkey;
    readonly nullifierHash: Hex32;
    readonly signature: string;
  }): Promise<boolean>;
}

/** Pins a JSON document to IPFS and returns the resulting `ipfs://<cid>`. */
export interface IpfsPinner {
  pinJson(value: unknown): Promise<string>;
}

/**
 * Computes `sha256(JCS(value))`, returning lowercase hex (no `0x` prefix).
 * The default implementation lives in this module; it's exposed as an
 * interface so call sites that already canonicalize their VC envelope
 * can wire in their own.
 */
export interface ClaimHasher {
  hash(value: unknown): string;
}

/**
 * Strongly-typed errors surfaced to the HTTP handler so it can map to
 * status codes without string-matching.
 */
export type WorldcoinIssuerErrorCode =
  | "INVALID_ID_TOKEN"
  | "INVALID_AGENT_CARD_SIGNATURE"
  | "PROOF_REJECTED"
  | "VERIFICATION_LEVEL_MISMATCH"
  | "ACTION_MISMATCH"
  | "NULLIFIER_BOUND_TO_OTHER_CARD"
  | "CHAIN_TX_FAILED"
  | "UPSTREAM_OUTAGE";

export class WorldcoinIssuerError extends Error {
  public readonly code: WorldcoinIssuerErrorCode;
  /** HTTP status hint — the gateway maps this to the wire response. */
  public readonly status: number;

  public constructor(
    code: WorldcoinIssuerErrorCode,
    message: string,
    status: number,
  ) {
    super(message);
    this.name = "WorldcoinIssuerError";
    this.code = code;
    this.status = status;
  }
}
