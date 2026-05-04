/**
 * Skill-certification issuer (T-1.4.2.2 / FN-041, mission E4).
 *
 * Mints `skill.<name>` credentials to a fixed whitelist of AgentCard
 * subjects via the on-chain `IssueCredential` instruction. The flagship
 * caller is the `code:audit:solidity` reference BPP, which relies on a
 * `skill.solidity-audit` credential at Beckn `init` time to assert its
 * capability against the network's required-credentials list (see
 * `programs::beckn::instructions::init`, FN-020 / FN-022).
 *
 * Design notes
 * ------------
 *  - **Whitelist-based.** No proofs, no IdP — the operator curates the
 *    five reference BPPs and the bridge enforces the allowlist. A
 *    request for a `(skill, subject)` pair that's not on the list is
 *    rejected with `NOT_WHITELISTED` (HTTP 403). This is intentional:
 *    the issuer's threat model is "nobody else issues this skill",
 *    not "nobody else can prove this skill".
 *
 *  - **One credential per `(subject, skill)`.** The bridge keeps a
 *    `SkillBindingStore` keyed on `(skill, subject)` and short-circuits
 *    on a cache hit, returning the existing PDA / tx signature with
 *    `idempotent: true`. Concurrent retries that lose the race fall
 *    back to the canonical row in the store. This matches the
 *    semantics of the on-chain `Credential` PDA, which is itself
 *    derived from `["cred", subject, issuer, schema]` (singularity-id,
 *    FN-007 / FN-022) — re-issuing the same triple would either
 *    collide on the PDA or revoke the previous claim, neither of which
 *    is desirable for a skill attestation.
 *
 *  - **Per-skill schema.** Each skill gets its own credential schema id
 *    `sha256("eto.beckn.schema.skill-cert." + skill + ".v1")`, so the
 *    Beckn verifier can match on schema bytes alone and skill creds
 *    don't pollute each other's required-credentials slot.
 *
 *  - **Dependency-injected.** Identical pattern to
 *    `issuers/worldcoin.ts`: a `ChainClient`, an `IpfsPinner`, an
 *    optional `ClaimHasher`, an injected clock, and a pluggable
 *    `SkillBindingStore` / `SkillWhitelist`. The HTTP gateway lives
 *    one layer up; this module is the pure business-logic core.
 *
 *  - **No external network calls inside the bridge itself.** The IPFS
 *    pin and the chain submission are the only side effects, and both
 *    are injected. That keeps the unit tests deterministic and lets
 *    devnet point at an `InMemoryChainClient` if desired.
 */

import { createHash } from "node:crypto";

import { computeClaimCommitments } from "./claim-commitments.js";
import {
  type AgentCardPubkey,
  type ChainClient,
  type ClaimHasher,
  type Hex32,
  type IpfsPinner,
  type IssueCredentialArgs,
  type SkillBinding,
  type SkillBindingStore,
  type SkillCertIssueRequest,
  type SkillCertIssueResponse,
  SkillCertIssuerError,
  type SkillId,
  type SkillWhitelist,
} from "./skill-cert.types.js";

export * from "./skill-cert.types.js";

/* -------------------------------------------------------------------------- */
/* Constants                                                                   */
/* -------------------------------------------------------------------------- */

/** Schema-id namespace prefix. The full tag is `${PREFIX}${skill}.v1`. */
export const SKILL_CERT_SCHEMA_PREFIX = "eto.beckn.schema.skill-cert.";

/** Schema-id namespace suffix (version pin). */
export const SKILL_CERT_SCHEMA_SUFFIX = ".v1";

/** JSON-LD context for the off-chain claim envelope. */
export const SKILL_CERT_VC_CONTEXT: readonly string[] = [
  "https://www.w3.org/2018/credentials/v1",
  "https://schema.eto.dev/skill-cert/v1",
];

/** Slug pattern: lowercase letters, digits, single hyphens. */
const SKILL_SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/* -------------------------------------------------------------------------- */
/* Hashing utilities                                                           */
/* -------------------------------------------------------------------------- */

/** Lowercase 32-byte hex digest of `sha256(input)`, no `0x` prefix. */
export function sha256Hex(input: string | Uint8Array): string {
  return createHash("sha256")
    .update(typeof input === "string" ? Buffer.from(input, "utf8") : input)
    .digest("hex");
}

/**
 * Default `ClaimHasher` — JCS (RFC 8785) over the input followed by
 * SHA-256. Matches the canonicalization used by `singularity-id`'s
 * Rust-side `claim_hash` helper and by the worldcoin issuer in this
 * package.
 */
export const defaultClaimHasher: ClaimHasher = {
  hash(value: unknown): string {
    return sha256Hex(canonicalJson(value));
  },
};

/** RFC 8785 (JCS) canonical JSON — minimal implementation. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
  }
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  const body = keys
    .map((k) => `${JSON.stringify(k)}:${canonicalJson(obj[k])}`)
    .join(",");
  return `{${body}}`;
}

/**
 * Compute the on-chain schema id for a skill slug.
 * `sha256("eto.beckn.schema.skill-cert." + skill + ".v1")`, lowercase
 * hex, no prefix. Computed on demand (cheap; one syscall).
 */
export function schemaIdForSkill(skill: SkillId): Hex32 {
  return sha256Hex(SKILL_CERT_SCHEMA_PREFIX + skill + SKILL_CERT_SCHEMA_SUFFIX);
}

/* -------------------------------------------------------------------------- */
/* Reference whitelist + binding store                                         */
/* -------------------------------------------------------------------------- */

/**
 * Map-backed whitelist keyed by skill slug. Reference impl for tests
 * and devnet. Production deploys typically wire in a config-file or
 * config-service-backed implementation that supports hot-reload.
 */
export class StaticSkillWhitelist implements SkillWhitelist {
  private readonly bySkill: Map<SkillId, Set<AgentCardPubkey>>;

  public constructor(
    entries: Readonly<Record<SkillId, readonly AgentCardPubkey[]>>,
  ) {
    this.bySkill = new Map();
    for (const [skill, subjects] of Object.entries(entries)) {
      this.bySkill.set(skill, new Set(subjects));
    }
  }

  public isAllowed(skill: SkillId, subject: AgentCardPubkey): boolean {
    return this.bySkill.get(skill)?.has(subject) ?? false;
  }

  /** Mutates the in-memory whitelist; primarily for tests. */
  public add(skill: SkillId, subject: AgentCardPubkey): void {
    let set = this.bySkill.get(skill);
    if (set === undefined) {
      set = new Set();
      this.bySkill.set(skill, set);
    }
    set.add(subject);
  }
}

/**
 * Process-local `(skill, subject) → binding` store used in tests and
 * devnet. Throws on `put` collision so the issuer can recover via
 * `get` to surface a stable idempotent response on lost races.
 */
export class InMemorySkillBindingStore implements SkillBindingStore {
  private readonly map = new Map<string, SkillBinding>();

  private static key(skill: SkillId, subject: AgentCardPubkey): string {
    // `\u0000` separator avoids collisions on subjects that contain `:`.
    return `${skill}\u0000${subject}`;
  }

  public async get(
    skill: SkillId,
    subject: AgentCardPubkey,
  ): Promise<SkillBinding | undefined> {
    return this.map.get(InMemorySkillBindingStore.key(skill, subject));
  }

  public async put(binding: SkillBinding): Promise<void> {
    const k = InMemorySkillBindingStore.key(
      binding.skill,
      binding.subjectAgentCard,
    );
    if (this.map.has(k)) {
      throw new Error(
        `skill binding ${binding.skill}/${binding.subjectAgentCard} already exists (race lost; retry get())`,
      );
    }
    this.map.set(k, binding);
  }
}

/* -------------------------------------------------------------------------- */
/* SkillCertIssuer                                                             */
/* -------------------------------------------------------------------------- */

export interface SkillCertIssuerConfig {
  /** Stable issuer DID embedded in the off-chain claim envelope. */
  readonly issuerDid: string;
}

export interface SkillCertIssuerDeps {
  readonly whitelist: SkillWhitelist;
  readonly bindingStore: SkillBindingStore;
  readonly chain: ChainClient;
  readonly ipfs: IpfsPinner;
  readonly claimHasher?: ClaimHasher;
  /** Clock injection for deterministic tests. Defaults to `Date.now`. */
  readonly now?: () => number;
  /**
   * Optional CSPRNG hook for `claimCommitments` salt generation
   * (§10.3.1). Defaults to `globalThis.crypto.getRandomValues`.
   */
  readonly randomBytes?: (len: number) => Uint8Array;
}

/**
 * Bridge service: takes a `(skill, subject)` request, enforces the
 * whitelist, mints (or returns) the corresponding skill credential.
 */
export class SkillCertIssuer {
  private readonly cfg: SkillCertIssuerConfig;
  private readonly deps: SkillCertIssuerDeps;
  private readonly hasher: ClaimHasher;
  private readonly now: () => number;

  public constructor(cfg: SkillCertIssuerConfig, deps: SkillCertIssuerDeps) {
    this.cfg = cfg;
    this.deps = deps;
    this.hasher = deps.claimHasher ?? defaultClaimHasher;
    this.now = deps.now ?? Date.now;
  }

  /**
   * Run the full issue flow.
   * Throws `SkillCertIssuerError` on validation failure; the HTTP layer
   * maps `err.status` to the wire response.
   */
  public async issue(
    req: SkillCertIssueRequest,
  ): Promise<SkillCertIssueResponse> {
    /* 1. Validate request shape. ---------------------------------------- */
    if (typeof req.skill !== "string" || !SKILL_SLUG_RE.test(req.skill)) {
      throw new SkillCertIssuerError(
        "INVALID_SKILL",
        `skill must match ${SKILL_SLUG_RE} (got: ${JSON.stringify(req.skill)})`,
        400,
      );
    }
    if (
      typeof req.subjectAgentCard !== "string" ||
      req.subjectAgentCard.length === 0
    ) {
      throw new SkillCertIssuerError(
        "INVALID_SUBJECT",
        "subjectAgentCard must be a non-empty string",
        400,
      );
    }

    const schema = schemaIdForSkill(req.skill);

    /* 2. Idempotency pre-check. ----------------------------------------- *
     *    We check the binding store BEFORE the whitelist so a previously
     *    issued credential continues to serve even if the operator later
     *    rotates the allowlist (revocation is the chain's job, not the
     *    bridge's). This also makes the happy-path retry the cheapest
     *    code path.
     */
    const existing = await this.deps.bindingStore.get(
      req.skill,
      req.subjectAgentCard,
    );
    if (existing !== undefined) {
      return {
        credentialPda: existing.credentialPda,
        txSignature: existing.txSignature,
        claimUri: existing.claimUri,
        claimHash: existing.claimHash,
        schema,
        idempotent: true,
      };
    }

    /* 3. Whitelist enforcement. ----------------------------------------- */
    const allowed = await this.deps.whitelist.isAllowed(
      req.skill,
      req.subjectAgentCard,
    );
    if (!allowed) {
      throw new SkillCertIssuerError(
        "NOT_WHITELISTED",
        `subject ${req.subjectAgentCard} is not authorised for skill ${req.skill}`,
        403,
      );
    }

    /* 4. Build & pin the off-chain claim envelope. ---------------------- */
    const issuanceDate = new Date(this.now()).toISOString();
    const baseClaim = buildSkillCertClaim({
      issuerDid: this.cfg.issuerDid,
      skill: req.skill,
      subjectAgentCard: req.subjectAgentCard,
      issuanceDate,
    });
    // §10.3.1: per-leaf Poseidon-2 commitments over `credentialSubject`,
    // embedded BEFORE hashing so `claim_hash` binds them.
    const claimCommitments = computeClaimCommitments(
      baseClaim.credentialSubject as Record<string, unknown>,
      { randomBytes: this.deps.randomBytes },
    );
    const claim = { ...baseClaim, claimCommitments };
    const claimHash = this.hasher.hash(claim);
    const claimUri = await this.deps.ipfs.pinJson(claim);
    if (!claimUri.startsWith("ipfs://")) {
      throw new SkillCertIssuerError(
        "CHAIN_TX_FAILED",
        `ipfs pinner returned non-ipfs uri: ${claimUri}`,
        500,
      );
    }

    /* 5. Submit IssueCredential. ---------------------------------------- */
    const ccArgs: IssueCredentialArgs = {
      schema,
      subjectAgentCard: req.subjectAgentCard,
      claimHash,
      claimUri,
      validUntilSlot: 0n,
    };
    let chainResult;
    try {
      chainResult = await this.deps.chain.issueCredential(ccArgs);
    } catch (err) {
      throw new SkillCertIssuerError(
        "CHAIN_TX_FAILED",
        `IssueCredential tx failed: ${(err as Error).message}`,
        502,
      );
    }

    /* 6. Persist binding (atomic; recover on race). --------------------- */
    const binding: SkillBinding = {
      skill: req.skill,
      subjectAgentCard: req.subjectAgentCard,
      credentialPda: chainResult.credentialPda,
      txSignature: chainResult.txSignature,
      claimUri,
      claimHash,
      issuedAtMs: this.now(),
    };
    try {
      await this.deps.bindingStore.put(binding);
    } catch {
      // Lost a race with a concurrent caller; reload the canonical row
      // and prefer that one so all callers converge.
      const canonical = await this.deps.bindingStore.get(
        req.skill,
        req.subjectAgentCard,
      );
      if (canonical === undefined) {
        throw new SkillCertIssuerError(
          "CHAIN_TX_FAILED",
          "binding store lost the put and has no canonical record",
          500,
        );
      }
      return {
        credentialPda: canonical.credentialPda,
        txSignature: canonical.txSignature,
        claimUri: canonical.claimUri,
        claimHash: canonical.claimHash,
        schema,
        idempotent: true,
      };
    }

    return {
      credentialPda: chainResult.credentialPda,
      txSignature: chainResult.txSignature,
      claimUri,
      claimHash,
      schema,
      idempotent: false,
    };
  }
}

/* -------------------------------------------------------------------------- */
/* Off-chain claim envelope                                                    */
/* -------------------------------------------------------------------------- */

/**
 * Build the off-chain claim envelope pinned to IPFS.
 * Shape is intentionally minimal — the on-chain credential commits to
 * `claim_hash = sha256(JCS(envelope))`, so anything verifiers need at
 * dispute time MUST live in this object.
 */
export function buildSkillCertClaim(args: {
  readonly issuerDid: string;
  readonly skill: SkillId;
  readonly subjectAgentCard: AgentCardPubkey;
  readonly issuanceDate: string;
}): Record<string, unknown> {
  return {
    "@context": [...SKILL_CERT_VC_CONTEXT],
    type: ["VerifiableCredential", "SkillCertCredential"],
    issuer: args.issuerDid,
    issuanceDate: args.issuanceDate,
    credentialSubject: {
      id: `did:eto:agent:${args.subjectAgentCard}`,
      skill: args.skill,
    },
  };
}
