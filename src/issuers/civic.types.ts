// Civic issuer — public types.
//
// See `spec/issuers/civic-integration.md` for the design rationale and
// `eto-mcp/src/issuers/civic.ts` for the `CivicIssuer` implementation.
//
// These types are intentionally re-declared (rather than cross-imported
// from a Worldcoin module) so the two reference issuers stay
// independently versionable. A future refactor may collapse the shared
// shapes — `NullifierStore`, `ChainClient`, `IssueCredentialArgs`,
// `IpfsPinner`, `ClaimHasher`, `AgentCardSignatureVerifier` — into a
// shared module; until then duplication is preferred.

// ---------------------------------------------------------------------
// Request / response shapes
// ---------------------------------------------------------------------

/**
 * Civic issuance request.
 *
 * - `gatewayToken` is the base58 pubkey of the Civic Pass *gateway-token
 *   account* on Solana (owned by the subject wallet on the configured
 *   gatekeeper network).
 * - `agentCardPubkey` is the base58 Ed25519 public key of the
 *   `AgentCardState` the credential will be issued to.
 * - `agentCardSignature` is a base64-encoded 64-byte Ed25519 signature
 *   by `agentCardPubkey` over `sha256(nullifierBytes || agentCardPubkeyBytes)`,
 *   where `nullifierBytes` is the 32-byte raw decoding of the Civic
 *   nullifier hex.
 * - `expectedGatekeeperNetwork` (optional) overrides the
 *   config-bound gatekeeper network for tests / multi-network deploys.
 */
export interface CivicIssueRequest {
  readonly gatewayToken: string;
  readonly agentCardPubkey: string;
  readonly agentCardSignature: string;
  readonly expectedGatekeeperNetwork?: string;
}

export interface CivicIssueResponse {
  readonly credentialPda: string;
  readonly txSignature: string;
  readonly claimUri: string;
  readonly claimHash: string;
  readonly idempotent: boolean;
}

// ---------------------------------------------------------------------
// Gateway-token verification surface
// ---------------------------------------------------------------------

export type CivicGatewayTokenState =
  | "Active"
  | "Revoked"
  | "Frozen"
  | "Expired";

export interface CivicVerifyResult {
  readonly tokenAddress: string;
  readonly owner: string;
  readonly gatekeeperNetwork: string;
  readonly state: "Active";
  readonly expiresAt?: number;
  readonly civicPassLevel?: "uniqueness" | "kyc" | "captcha" | string;
}

/**
 * Pluggable on-chain gateway-token verifier. Throws `CivicIssuerError`
 * with one of the `GATEWAY_TOKEN_*` codes (or `UPSTREAM_OUTAGE`) on
 * failure; resolves with a `CivicVerifyResult` whose `state === "Active"`
 * on success.
 *
 * The production implementation will hit Solana RPC and decode the
 * gateway-protocol account layout. This task ships only the interface
 * and a `StubCivicVerifier` for tests; the real implementation is a
 * follow-up task.
 */
export interface CivicVerifier {
  verifyGatewayToken(input: {
    readonly gatewayToken: string;
    readonly expectedGatekeeperNetwork: string;
    readonly expectedOwner: string;
  }): Promise<CivicVerifyResult>;
}

// ---------------------------------------------------------------------
// Dedupe store
// ---------------------------------------------------------------------

export interface NullifierBinding {
  readonly nullifier: string;
  readonly agentCardPubkey: string;
  readonly credentialPda: string;
  readonly txSignature: string;
  readonly claimUri: string;
  readonly claimHash: string;
}

export interface NullifierStore {
  get(nullifier: string): Promise<NullifierBinding | undefined>;
  put(binding: NullifierBinding): Promise<void>;
}

// ---------------------------------------------------------------------
// Chain client
// ---------------------------------------------------------------------

export interface IssueCredentialArgs {
  readonly subjectAgentCard: string;
  readonly schema: string;
  readonly claimUri: string;
  readonly claimHash: string;
  readonly validFromSlot: bigint;
  readonly validUntilSlot: bigint;
  /** Bridge-scoped idempotency key, e.g. `civic:${civicNullifier}`. */
  readonly idempotencyKey?: string;
}

export interface IssueCredentialResult {
  readonly credentialPda: string;
  readonly txSignature: string;
}

export interface ChainClient {
  issueCredential(args: IssueCredentialArgs): Promise<IssueCredentialResult>;
  /** Current slot for `validFromSlot`. Optional; defaults to 0n if absent. */
  currentSlot?(): Promise<bigint>;
}

// ---------------------------------------------------------------------
// IPFS / claim hashing / signature verification
// ---------------------------------------------------------------------

export interface IpfsPinner {
  pin(jcsCanonicalJson: string): Promise<{ readonly uri: string }>;
}

export interface ClaimHasher {
  /** Returns lowercase hex sha256 of the JCS-canonicalised input. */
  hash(vcWithoutProof: Record<string, unknown>): string;
}

export interface AgentCardSignatureVerifier {
  /**
   * Verify an Ed25519 signature by `agentCardPubkey` over
   * `sha256(nullifierBytes || agentCardPubkeyBytes)`. Resolves `true`
   * on a valid signature; resolves `false` on any cryptographic
   * failure (do NOT throw — let the caller surface the typed error).
   */
  verify(input: {
    readonly nullifier: string; // 64-char lowercase hex
    readonly agentCardPubkey: string; // base58
    readonly signature: string; // base64
  }): Promise<boolean>;
}

// ---------------------------------------------------------------------
// Verifiable Credential envelope
// ---------------------------------------------------------------------

export interface VerifiedHumanVc extends Record<string, unknown> {
  readonly "@context": ReadonlyArray<string>;
  readonly type: ReadonlyArray<string>;
  readonly issuer: string;
  readonly issuanceDate: string;
  readonly credentialSubject: {
    readonly id: string;
    readonly type: "VerifiedHuman";
  };
  readonly evidence: ReadonlyArray<Record<string, unknown>>;
}

// ---------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------

export type CivicIssuerErrorCode =
  | "INVALID_AGENT_CARD_SIGNATURE"
  | "GATEWAY_TOKEN_NOT_FOUND"
  | "GATEWAY_TOKEN_NOT_OWNED_BY_CARD"
  | "GATEWAY_TOKEN_INACTIVE"
  | "GATEWAY_TOKEN_WRONG_NETWORK"
  | "NULLIFIER_BOUND_TO_OTHER_CARD"
  | "CHAIN_TX_FAILED"
  | "UPSTREAM_OUTAGE";

export class CivicIssuerError extends Error {
  public override readonly name = "CivicIssuerError";
  public readonly code: CivicIssuerErrorCode;
  public readonly status: number;

  public constructor(
    code: CivicIssuerErrorCode,
    message: string,
    status: number,
  ) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

// ---------------------------------------------------------------------
// Config block (the `civic` slice of the eto-mcp app config)
// ---------------------------------------------------------------------

export interface CivicConfig {
  /** Base58 Civic gatekeeper-network pubkey. */
  readonly gatekeeperNetwork: string;
  /** Filesystem path to the Civic issuer-authority Solana keypair. */
  readonly issuerKeypairPath: string;
  /** 32-byte hex `IssuerNetwork` id. */
  readonly networkId: string;
  /** True iff `gatekeeperNetwork` AND `issuerKeypairPath` are non-empty. */
  readonly enabled: boolean;
}

// ---------------------------------------------------------------------
// Logger
// ---------------------------------------------------------------------

export interface IssuerLogger {
  info(record: Record<string, unknown>): void;
  warn(record: Record<string, unknown>): void;
  error(record: Record<string, unknown>): void;
}

// ---------------------------------------------------------------------
// DI surface
// ---------------------------------------------------------------------

export interface CivicIssuerDeps {
  readonly config: { readonly civic: CivicConfig };
  readonly store: NullifierStore;
  readonly chainClient: ChainClient;
  readonly civicVerifier: CivicVerifier;
  readonly signatureVerifier: AgentCardSignatureVerifier;
  readonly ipfsPinner: IpfsPinner;
  readonly claimHasher: ClaimHasher;
  readonly logger?: IssuerLogger;
  /** Issuer-authority pubkey (base58); recorded in the off-chain VC. */
  readonly issuerAuthorityPubkey: string;
  /** Wall-clock for VC `issuanceDate`. Defaults to `Date.now()`. */
  readonly nowUnix?: () => number;
  /**
   * Optional CSPRNG hook for `claimCommitments` salt generation
   * (§10.3.1). Defaults to `globalThis.crypto.getRandomValues`.
   */
  readonly randomBytes?: (len: number) => Uint8Array;
}
