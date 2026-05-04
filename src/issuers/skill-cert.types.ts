/**
 * Type definitions for the skill-certification issuer
 * (T-1.4.2.2 / FN-041, mission E4 — Reference Issuers).
 *
 * The skill-cert issuer mints `skill.<name>` credentials (e.g.
 * `skill.solidity-audit`) to a fixed whitelist of AgentCard subjects —
 * concretely the five reference BPPs that ship with the ETO devnet.
 * It is a deliberately minimal "operational" issuer: no ZK proofs, no
 * external IdP, just a curated allowlist that says "this BPP is
 * authorised to advertise this skill". The `code:audit:solidity` BPP
 * relies on the resulting credential at Beckn `init` time to assert
 * its capability.
 */

/** Lowercase 32-byte hex digest, no `0x` prefix. */
export type Hex32 = string;

/** Base58 / base64 AgentCard pubkey (opaque to this module). */
export type AgentCardPubkey = string;

/**
 * Skill identifier — short kebab-case slug. The on-chain schema id is
 * `sha256("eto.beckn.schema.skill-cert." + skill + ".v1")`, so each
 * skill has its own credential schema and the verifier can pre-compute
 * the schema bytes it expects.
 */
export type SkillId = string;

/** Wire-level request body accepted by `POST /issuers/skill-cert/issue`. */
export interface SkillCertIssueRequest {
  /** Skill slug, e.g. `"solidity-audit"`. */
  readonly skill: SkillId;
  /** Subject AgentCard pubkey the credential will be issued to. */
  readonly subjectAgentCard: AgentCardPubkey;
  /**
   * Caller-binding signature: Ed25519 signature by `subjectAgentCard`
   * over `sha256("eto:skill-cert:v1" || skill || subjectAgentCard ||
   * issuanceNonce)`. Encoded as base64. Without this, an attacker who
   * learns a whitelisted `(skill, subject)` tuple can front-run the
   * legitimate owner. See FN-058 / convention mirror in
   * `src/issuers/civic.ts:169-185`.
   */
  readonly agentCardSignature: string;
  /**
   * Caller-supplied freshness nonce mixed into the signature preimage.
   * Must be a non-empty string. Re-using a nonce on a fresh
   * (skill, subject) pair is permitted (the binding store still serves
   * the idempotent path); the nonce exists to bind a *specific*
   * issuance attempt and let a wallet replace its signed payload
   * without rotating its keypair.
   */
  readonly issuanceNonce: string;
}

/** Wire-level response body for a successful issuance. */
export interface SkillCertIssueResponse {
  /** PDA address of the on-chain `Credential` record. */
  readonly credentialPda: string;
  /** Tx signature of the `IssueCredential` call (`""` on idempotent re-hit). */
  readonly txSignature: string;
  /** `ipfs://<cid>` URI of the off-chain claim envelope. */
  readonly claimUri: string;
  /** `sha256(JCS(claim_json))` — on-chain binding. */
  readonly claimHash: Hex32;
  /** `sha256("eto.beckn.schema.skill-cert." + skill + ".v1")`. */
  readonly schema: Hex32;
  /** True if the request hit the dedupe cache (no new tx submitted). */
  readonly idempotent: boolean;
}

/** Persistent record kept by the dedupe store, keyed by `(subject, skill)`. */
export interface SkillBinding {
  readonly skill: SkillId;
  readonly subjectAgentCard: AgentCardPubkey;
  readonly credentialPda: string;
  readonly txSignature: string;
  readonly claimUri: string;
  readonly claimHash: Hex32;
  readonly issuedAtMs: number;
}

/**
 * Pluggable persistence for `(subject, skill) → binding`. The reference
 * impl in this module is in-memory (`InMemorySkillBindingStore`);
 * production deploys swap in Redis / Postgres with a unique constraint.
 */
export interface SkillBindingStore {
  get(
    skill: SkillId,
    subjectAgentCard: AgentCardPubkey,
  ): Promise<SkillBinding | undefined>;
  /**
   * Insert a fresh binding. MUST be atomic w.r.t. concurrent calls. On
   * key collision, implementations should throw; the issuer recovers
   * by re-`get`ing the canonical record so all callers converge.
   */
  put(binding: SkillBinding): Promise<void>;
}

/** Submits an `IssueCredential` tx and returns the resulting PDA. */
export interface IssueCredentialArgs {
  readonly schema: Hex32;
  readonly subjectAgentCard: AgentCardPubkey;
  readonly claimHash: Hex32;
  readonly claimUri: string;
  /** `0` = no upper bound; the spec default for skill creds. */
  readonly validUntilSlot: bigint;
}

export interface IssueCredentialResult {
  readonly credentialPda: string;
  readonly txSignature: string;
}

export interface ChainClient {
  issueCredential(args: IssueCredentialArgs): Promise<IssueCredentialResult>;
}

/** Pins a JSON document to IPFS and returns the resulting `ipfs://<cid>`. */
export interface IpfsPinner {
  pinJson(value: unknown): Promise<string>;
}

/** Computes `sha256(JCS(value))`, returning lowercase hex (no `0x`). */
export interface ClaimHasher {
  hash(value: unknown): string;
}

/**
 * Whitelist source: the set of AgentCard subjects authorised for each
 * skill. The bridge consults this on every issue request — it is *not*
 * cached so operators can reload allowlists without restarting.
 */
export interface SkillWhitelist {
  /** Returns `true` iff `subject` may be issued `skill`. */
  isAllowed(skill: SkillId, subject: AgentCardPubkey): boolean | Promise<boolean>;
}

/**
 * Verifier for the caller-binding signature on a skill-cert request.
 * Returns `true` iff `signature` is a valid Ed25519 signature by
 * `subjectAgentCard` over the canonical preimage
 * `sha256("eto:skill-cert:v1" || skill || subjectAgentCard || issuanceNonce)`.
 *
 * Implementations MUST resolve `false` (not throw) on cryptographic /
 * decoding failure so the issuer can map the outcome to a single typed
 * `INVALID_AGENT_CARD_SIGNATURE` error.
 *
 * Mirrors `AgentCardSignatureVerifier` in `civic.types.ts` and
 * `worldcoin.types.ts` — see FN-058 fix and the
 * "Issuer caller-binding convention" project memory entry.
 */
export interface AgentCardSignatureVerifier {
  verify(input: {
    readonly skill: SkillId;
    readonly subjectAgentCard: AgentCardPubkey;
    readonly issuanceNonce: string;
    readonly signature: string; // base64
  }): Promise<boolean>;
}

/**
 * Strongly-typed errors surfaced to the HTTP handler so it can map to
 * status codes without string-matching.
 */
export type SkillCertIssuerErrorCode =
  | "INVALID_SKILL"
  | "INVALID_SUBJECT"
  | "INVALID_AGENT_CARD_SIGNATURE"
  | "NOT_WHITELISTED"
  | "CHAIN_TX_FAILED";

export class SkillCertIssuerError extends Error {
  public readonly code: SkillCertIssuerErrorCode;
  /** HTTP status hint. */
  public readonly status: number;

  public constructor(
    code: SkillCertIssuerErrorCode,
    message: string,
    status: number,
  ) {
    super(message);
    this.name = "SkillCertIssuerError";
    this.code = code;
    this.status = status;
  }
}
