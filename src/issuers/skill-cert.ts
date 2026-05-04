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

import {
  createHash,
  createPublicKey,
  verify as cryptoVerify,
} from "node:crypto";

import {
  type AgentCardPubkey,
  type AgentCardSignatureVerifier,
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

/**
 * Domain-separation tag for the caller-binding signature preimage.
 * Verifiers MUST use this exact byte sequence — changing it is a
 * breaking wire change.
 */
export const SKILL_CERT_SIG_DOMAIN = "eto:skill-cert:v1";

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
/* Caller-binding signature                                                    */
/* -------------------------------------------------------------------------- */

/**
 * Build the canonical preimage hash for a skill-cert
 * `agentCardSignature`:
 *
 *   sha256(SKILL_CERT_SIG_DOMAIN || skill || subjectAgentCard || issuanceNonce)
 *
 * Returns the 32-byte digest (NOT hex) that callers actually feed to
 * Ed25519. Field separators are intentionally omitted because each
 * field is range-validated upstream (skill slug regex, non-empty
 * subject, non-empty nonce) and Ed25519 signs the digest, not the
 * preimage — length-extension games are irrelevant.
 */
export function skillCertSignaturePreimage(args: {
  readonly skill: SkillId;
  readonly subjectAgentCard: AgentCardPubkey;
  readonly issuanceNonce: string;
}): Buffer {
  return createHash("sha256")
    .update(
      SKILL_CERT_SIG_DOMAIN +
        args.skill +
        args.subjectAgentCard +
        args.issuanceNonce,
      "utf8",
    )
    .digest();
}

/** Base58 alphabet — Solana / AgentCard pubkey decoding. */
const BASE58_ALPHABET =
  "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
const BASE58_LOOKUP: Record<string, number> = (() => {
  const m: Record<string, number> = {};
  for (let i = 0; i < BASE58_ALPHABET.length; i += 1) {
    m[BASE58_ALPHABET[i]!] = i;
  }
  return m;
})();

/** Decode a base58 string into raw bytes. Throws on invalid input. */
function base58Decode(s: string): Uint8Array {
  if (s.length === 0) return new Uint8Array(0);
  let zeros = 0;
  while (zeros < s.length && s[zeros] === "1") zeros += 1;

  const bytes: number[] = [];
  for (let i = zeros; i < s.length; i += 1) {
    const c = s[i]!;
    const v = BASE58_LOOKUP[c];
    if (v === undefined) {
      throw new Error(`base58: invalid character ${JSON.stringify(c)}`);
    }
    let carry = v;
    for (let j = 0; j < bytes.length; j += 1) {
      carry += bytes[j]! * 58;
      bytes[j] = carry & 0xff;
      carry >>= 8;
    }
    while (carry > 0) {
      bytes.push(carry & 0xff);
      carry >>= 8;
    }
  }
  const out = new Uint8Array(zeros + bytes.length);
  for (let i = 0; i < bytes.length; i += 1) {
    out[zeros + i] = bytes[bytes.length - 1 - i]!;
  }
  return out;
}

/**
 * Default `AgentCardSignatureVerifier` for skill-cert: Ed25519
 * verification of `signature` (base64) against the 32-byte preimage
 * digest, using `subjectAgentCard` (base58, 32 bytes) as the public
 * key. Returns `false` on any decoding / cryptographic failure.
 *
 * Mirrors the convention in `civic.ts:ed25519SignatureVerifier`.
 */
export const ed25519SkillCertSignatureVerifier: AgentCardSignatureVerifier = {
  async verify({ skill, subjectAgentCard, issuanceNonce, signature }) {
    try {
      const cardBytes = base58Decode(subjectAgentCard);
      if (cardBytes.length !== 32) return false;
      const sigBytes = Buffer.from(signature, "base64");
      if (sigBytes.length !== 64) return false;
      const message = skillCertSignaturePreimage({
        skill,
        subjectAgentCard,
        issuanceNonce,
      });
      // RFC 8410 Ed25519 SubjectPublicKeyInfo prefix.
      const spki = Buffer.concat([
        Buffer.from("302a300506032b6570032100", "hex"),
        Buffer.from(cardBytes),
      ]);
      const key = createPublicKey({ key: spki, format: "der", type: "spki" });
      return cryptoVerify(null, message, key, sigBytes);
    } catch {
      return false;
    }
  },
};

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
  /**
   * Verifies the caller-binding Ed25519 signature on every request
   * BEFORE the binding-store lookup, whitelist check, or chain call.
   * REQUIRED — omitting it (or wiring an always-true stub in
   * production) re-introduces FN-058. Defaults to
   * `ed25519SkillCertSignatureVerifier` when the dep is not provided.
   */
  readonly signatureVerifier?: AgentCardSignatureVerifier;
  readonly claimHasher?: ClaimHasher;
  /** Clock injection for deterministic tests. Defaults to `Date.now`. */
  readonly now?: () => number;
}

/**
 * Bridge service: takes a `(skill, subject)` request, enforces the
 * whitelist, mints (or returns) the corresponding skill credential.
 */
export class SkillCertIssuer {
  private readonly cfg: SkillCertIssuerConfig;
  private readonly deps: SkillCertIssuerDeps;
  private readonly hasher: ClaimHasher;
  private readonly signatureVerifier: AgentCardSignatureVerifier;
  private readonly now: () => number;

  public constructor(cfg: SkillCertIssuerConfig, deps: SkillCertIssuerDeps) {
    this.cfg = cfg;
    this.deps = deps;
    this.hasher = deps.claimHasher ?? defaultClaimHasher;
    this.signatureVerifier =
      deps.signatureVerifier ?? ed25519SkillCertSignatureVerifier;
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
    if (
      typeof req.agentCardSignature !== "string" ||
      req.agentCardSignature.length === 0
    ) {
      throw new SkillCertIssuerError(
        "INVALID_AGENT_CARD_SIGNATURE",
        "agentCardSignature must be a non-empty base64 string",
        401,
      );
    }
    if (
      typeof req.issuanceNonce !== "string" ||
      req.issuanceNonce.length === 0
    ) {
      throw new SkillCertIssuerError(
        "INVALID_AGENT_CARD_SIGNATURE",
        "issuanceNonce must be a non-empty string",
        401,
      );
    }

    const schema = schemaIdForSkill(req.skill);

    /* 1b. Caller-binding signature check. ------------------------------- *
     *     Runs BEFORE the idempotency lookup, whitelist gate, and chain
     *     call so an attacker who learns a whitelisted (skill, subject)
     *     tuple cannot front-run the legitimate AgentCard owner
     *     (FN-058). Mirrors `civic.ts` step 3 — see the
     *     "Issuer caller-binding convention" project memory entry.
     */
    const sigOk = await this.signatureVerifier.verify({
      skill: req.skill,
      subjectAgentCard: req.subjectAgentCard,
      issuanceNonce: req.issuanceNonce,
      signature: req.agentCardSignature,
    });
    if (!sigOk) {
      throw new SkillCertIssuerError(
        "INVALID_AGENT_CARD_SIGNATURE",
        "agentCardSignature does not validate over sha256(" +
          `${SKILL_CERT_SIG_DOMAIN} || skill || subjectAgentCard || issuanceNonce)`,
        401,
      );
    }

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
    const claim = buildSkillCertClaim({
      issuerDid: this.cfg.issuerDid,
      skill: req.skill,
      subjectAgentCard: req.subjectAgentCard,
      issuanceDate,
    });
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
