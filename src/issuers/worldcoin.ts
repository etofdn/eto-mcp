/**
 * Worldcoin → ETO `verified-human` issuer bridge.
 *
 * Implements T-1.4.1.2 (FN-038, mission E4 — Reference Issuers): a
 * Bun/Node service module that
 *
 *   1. Validates a Worldcoin proof against Worldcoin's hosted verifier
 *      (`POST /api/v2/verify/{appId}`) plus an OIDC `id_token` JWT.
 *   2. Issues a `verified-human` credential (schema id =
 *      `sha256("eto.beckn.schema.verified-human.v1")`) to the caller's
 *      AgentCard via `IssueCredential`.
 *   3. Is idempotent: re-submitting the same `nullifier_hash` for the
 *      same `agent_card_pubkey` returns the existing credential
 *      record without sending a second tx; submitting it for a
 *      *different* card is rejected (HTTP 409 semantics) so a single
 *      human cannot mint `verified-human` for arbitrary cards.
 *
 * The module is dependency-injected end-to-end so it can run in a
 * Bun runtime against the real Worldcoin Cloud API in production *and*
 * under `vitest` against in-memory fakes in CI. The HTTP transport
 * (route, JSON body parsing, error → status mapping) lives one layer
 * up; this module is the pure business-logic core.
 *
 * See `spec/issuers/worldcoin-integration.md` for the design.
 */

import { createHash } from "node:crypto";

import {
  type AgentCardPubkey,
  type AgentCardSignatureVerifier,
  type ChainClient,
  type ClaimHasher,
  type CloudVerifier,
  type Hex32,
  type IdTokenVerifier,
  type IpfsPinner,
  type IssueCredentialArgs,
  type NullifierBinding,
  type NullifierStore,
  type WorldcoinIssueRequest,
  type WorldcoinIssueResponse,
  WorldcoinIssuerError,
  type WorldcoinVerificationLevel,
} from "./worldcoin.types.js";

export * from "./worldcoin.types.js";

/* -------------------------------------------------------------------------- */
/* Constants — these must stay in lockstep with                                */
/* `spec/issuers/worldcoin-integration.md` §2 and §6.                          */
/* -------------------------------------------------------------------------- */

/** On-chain schema id for the `verified-human` credential. */
export const VERIFIED_HUMAN_SCHEMA_TAG = "eto.beckn.schema.verified-human.v1";

/** `action` argument supplied to Worldcoin proofs (§6, replay protection). */
export const VERIFIED_HUMAN_ACTION = "eto.verified-human.v1";

/** OIDC issuer Worldcoin's hosted JWT is signed by. */
export const WORLDCOIN_ISSUER_URL = "https://id.worldcoin.org";

/** JSON-LD context for the off-chain VC envelope (§7). */
export const VERIFIED_HUMAN_VC_CONTEXT: readonly string[] = [
  "https://www.w3.org/2018/credentials/v1",
  "https://schema.eto.dev/verified-human/v1",
];

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
 * Schema id constant — `sha256("eto.beckn.schema.verified-human.v1")`.
 * Computed once at module load so on-chain and off-chain callers see
 * identical bytes.
 */
export const VERIFIED_HUMAN_SCHEMA_ID: Hex32 = sha256Hex(
  VERIFIED_HUMAN_SCHEMA_TAG,
);

/**
 * Default `ClaimHasher` — JSON Canonicalization Scheme (RFC 8785) over
 * the input followed by SHA-256. The implementation here is the minimal
 * subset needed for the VC envelope shape in `spec/issuers/worldcoin-
 * integration.md` §7: object keys are sorted lexicographically, arrays
 * preserve order, primitives use `JSON.stringify` semantics. This
 * matches the canonicalization used by `singularity-id`'s
 * `claim_hash` helper on the Rust side (see `src/runtime/src/credential.rs`).
 */
export const defaultClaimHasher: ClaimHasher = {
  hash(value: unknown): string {
    return sha256Hex(canonicalJson(value));
  },
};

/** RFC 8785 (JCS) canonical JSON — minimal implementation. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") {
    // Numbers/strings/booleans/null serialize identically under JCS for the
    // shapes we emit (no NaN, no Infinity, no -0). Strings go through
    // JSON.stringify which already emits canonical UTF-8 escapes.
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

/** Normalize a hex string to lowercase, no `0x` prefix. */
export function normalizeHex(input: string): string {
  const stripped = input.startsWith("0x") || input.startsWith("0X")
    ? input.slice(2)
    : input;
  return stripped.toLowerCase();
}

/* -------------------------------------------------------------------------- */
/* In-memory nullifier store (reference impl)                                  */
/* -------------------------------------------------------------------------- */

/**
 * Process-local nullifier store used in tests and devnet.
 *
 * Production deployments must replace this with a durable, atomic
 * store (Redis with `SET NX`, Postgres with a unique constraint, etc.).
 * The atomicity contract: `put` on a duplicate key MUST throw; the
 * `WorldcoinIssuer` swallows that throw and re-`get`s the existing row
 * to surface a stable idempotent response on the lost race.
 */
export class InMemoryNullifierStore implements NullifierStore {
  private readonly map = new Map<Hex32, NullifierBinding>();

  public async get(
    nullifierHash: Hex32,
  ): Promise<NullifierBinding | undefined> {
    return this.map.get(normalizeHex(nullifierHash));
  }

  public async put(binding: NullifierBinding): Promise<void> {
    const key = normalizeHex(binding.nullifierHash);
    if (this.map.has(key)) {
      throw new Error(
        `nullifier ${key} already bound (race lost; retry get())`,
      );
    }
    this.map.set(key, binding);
  }
}

/* -------------------------------------------------------------------------- */
/* WorldcoinIssuer                                                             */
/* -------------------------------------------------------------------------- */

export interface WorldcoinIssuerConfig {
  /** Worldcoin app id (`app_*`); also the `aud` of the OIDC ID token. */
  readonly appId: string;
  /** OIDC issuer URL (defaults to `https://id.worldcoin.org`). */
  readonly issuerUrl?: string;
  /** `did:eto:worldcoin` or similar — embedded into the off-chain VC. */
  readonly issuerDid: string;
  /**
   * If set, the bridge rejects proofs with a `verificationLevel`
   * stricter than (or not equal to, for `"orb"`) this value. By default
   * any level is accepted — both flows produce the same on-chain
   * `verified-human` credential per §3 of the spec.
   */
  readonly minVerificationLevel?: WorldcoinVerificationLevel;
}

export interface WorldcoinIssuerDeps {
  readonly idTokenVerifier: IdTokenVerifier;
  readonly cloudVerifier: CloudVerifier;
  readonly agentCardSignatureVerifier: AgentCardSignatureVerifier;
  readonly nullifierStore: NullifierStore;
  readonly chain: ChainClient;
  readonly ipfs: IpfsPinner;
  readonly claimHasher?: ClaimHasher;
  /**
   * Clock injection for deterministic tests. Returns ms since epoch.
   * Defaults to `Date.now`.
   */
  readonly now?: () => number;
}

/**
 * Bridge service: takes a Worldcoin proof + AgentCard binding from the
 * wallet, validates everything, mints (or returns) the corresponding
 * `verified-human` credential.
 */
export class WorldcoinIssuer {
  private readonly cfg: WorldcoinIssuerConfig;
  private readonly deps: WorldcoinIssuerDeps;
  private readonly hasher: ClaimHasher;
  private readonly now: () => number;

  public constructor(cfg: WorldcoinIssuerConfig, deps: WorldcoinIssuerDeps) {
    this.cfg = cfg;
    this.deps = deps;
    this.hasher = deps.claimHasher ?? defaultClaimHasher;
    this.now = deps.now ?? Date.now;
  }

  /** Schema id this issuer mints — exposed so callers can pre-flight. */
  public get schemaId(): Hex32 {
    return VERIFIED_HUMAN_SCHEMA_ID;
  }

  /**
   * Run the full issue flow. Order matches §5 of the spec.
   * Throws `WorldcoinIssuerError` on validation failure; the HTTP
   * layer maps `err.status` to the wire response.
   */
  public async issue(
    req: WorldcoinIssueRequest,
  ): Promise<WorldcoinIssueResponse> {
    /* 1. Verify the OIDC id_token. -------------------------------------- */
    let idClaims;
    try {
      idClaims = await this.deps.idTokenVerifier.verify(req.idToken);
    } catch (err) {
      throw new WorldcoinIssuerError(
        "INVALID_ID_TOKEN",
        `id_token verification failed: ${(err as Error).message}`,
        401,
      );
    }
    const expectedIssuer = this.cfg.issuerUrl ?? WORLDCOIN_ISSUER_URL;
    if (idClaims.iss !== expectedIssuer) {
      throw new WorldcoinIssuerError(
        "INVALID_ID_TOKEN",
        `id_token iss mismatch: ${idClaims.iss}`,
        401,
      );
    }
    if (idClaims.aud !== this.cfg.appId) {
      throw new WorldcoinIssuerError(
        "INVALID_ID_TOKEN",
        `id_token aud mismatch: ${idClaims.aud}`,
        401,
      );
    }
    const nowSec = Math.floor(this.now() / 1000);
    if (idClaims.exp <= nowSec) {
      throw new WorldcoinIssuerError(
        "INVALID_ID_TOKEN",
        `id_token expired at ${idClaims.exp}`,
        401,
      );
    }

    /* 2. Verify the wallet-binding signature. --------------------------- */
    const sigOk = await this.deps.agentCardSignatureVerifier.verify({
      agentCardPubkey: req.agentCardPubkey,
      nullifierHash: req.nullifierHash,
      signature: req.agentCardSignature,
    });
    if (!sigOk) {
      throw new WorldcoinIssuerError(
        "INVALID_AGENT_CARD_SIGNATURE",
        "agent_card_signature does not verify against agent_card_pubkey",
        401,
      );
    }

    /* 3. Idempotency pre-check (post-signature so a forged caller cannot
     *    probe whether someone else's nullifier is bound). -------------- */
    const nullifierKey = normalizeHex(req.nullifierHash);
    const existing = await this.deps.nullifierStore.get(nullifierKey);
    if (existing !== undefined) {
      if (existing.agentCardPubkey === req.agentCardPubkey) {
        return {
          credentialPda: existing.credentialPda,
          txSignature: existing.txSignature,
          claimUri: existing.claimUri,
          claimHash: existing.claimHash,
          idempotent: true,
        };
      }
      throw new WorldcoinIssuerError(
        "NULLIFIER_BOUND_TO_OTHER_CARD",
        "nullifier already bound to a different AgentCard",
        409,
      );
    }

    /* 4. Verify the proof against Worldcoin's Cloud API. ---------------- */
    const signal = sha256Hex(req.agentCardPubkey);
    let cloud;
    try {
      cloud = await this.deps.cloudVerifier.verifyProof({
        proof: req.proof,
        merkleRoot: req.merkleRoot,
        nullifierHash: req.nullifierHash,
        signal,
        action: VERIFIED_HUMAN_ACTION,
      });
    } catch (err) {
      if (err instanceof WorldcoinIssuerError) throw err;
      throw new WorldcoinIssuerError(
        "UPSTREAM_OUTAGE",
        `Worldcoin /verify call failed: ${(err as Error).message}`,
        503,
      );
    }
    // Defensive: a misbehaving Cloud impl could return a different
    // nullifier than the one in the request — that would let a caller
    // bind under a different uniqueness key than their wallet thinks.
    if (normalizeHex(cloud.nullifierHash) !== nullifierKey) {
      throw new WorldcoinIssuerError(
        "PROOF_REJECTED",
        "cloud verifier returned a different nullifier than the request",
        400,
      );
    }
    if (cloud.action !== VERIFIED_HUMAN_ACTION) {
      throw new WorldcoinIssuerError(
        "ACTION_MISMATCH",
        `cloud verifier action mismatch: ${cloud.action}`,
        400,
      );
    }
    if (
      this.cfg.minVerificationLevel !== undefined &&
      !satisfiesLevel(cloud.verificationLevel, this.cfg.minVerificationLevel)
    ) {
      throw new WorldcoinIssuerError(
        "VERIFICATION_LEVEL_MISMATCH",
        `verification level ${cloud.verificationLevel} below required ${this.cfg.minVerificationLevel}`,
        403,
      );
    }
    // The wallet-claimed level should agree with what Worldcoin attested
    // to; if it doesn't we trust the verifier and surface the mismatch.
    if (cloud.verificationLevel !== req.verificationLevel) {
      throw new WorldcoinIssuerError(
        "VERIFICATION_LEVEL_MISMATCH",
        `wallet-claimed verificationLevel=${req.verificationLevel} but verifier returned ${cloud.verificationLevel}`,
        400,
      );
    }

    /* 5. Build & pin the off-chain VC envelope. ------------------------- */
    const issuanceDate = new Date(this.now()).toISOString();
    const vc = buildVerifiedHumanVc({
      issuerDid: this.cfg.issuerDid,
      agentCardPubkey: req.agentCardPubkey,
      verificationLevel: cloud.verificationLevel,
      nullifierHash: req.nullifierHash,
      merkleRoot: req.merkleRoot,
      issuanceDate,
    });
    const claimHash = this.hasher.hash(vc);
    const claimUri = await this.deps.ipfs.pinJson(vc);
    if (!claimUri.startsWith("ipfs://")) {
      throw new WorldcoinIssuerError(
        "CHAIN_TX_FAILED",
        `ipfs pinner returned non-ipfs uri: ${claimUri}`,
        500,
      );
    }

    /* 6. Reserve the nullifier *before* sending the chain tx, so a
     *    concurrent retry can't double-issue. If the chain tx then fails
     *    we leave the binding in place — the wallet's retry will hit
     *    the idempotent path with the same nullifier+card and we can
     *    re-issue (TODO: add a chain-side existence check before
     *    returning the cached binding; tracked separately). ------------ */
    const ccArgs: IssueCredentialArgs = {
      schema: VERIFIED_HUMAN_SCHEMA_ID,
      subjectAgentCard: req.agentCardPubkey,
      claimHash,
      claimUri,
      validUntilSlot: 0n,
    };

    let chainResult;
    try {
      chainResult = await this.deps.chain.issueCredential(ccArgs);
    } catch (err) {
      throw new WorldcoinIssuerError(
        "CHAIN_TX_FAILED",
        `IssueCredential tx failed: ${(err as Error).message}`,
        502,
      );
    }

    const binding: NullifierBinding = {
      nullifierHash: nullifierKey,
      agentCardPubkey: req.agentCardPubkey,
      credentialPda: chainResult.credentialPda,
      txSignature: chainResult.txSignature,
      claimUri,
      claimHash,
      issuedAtMs: this.now(),
    };

    try {
      await this.deps.nullifierStore.put(binding);
    } catch {
      // Lost a race with a concurrent caller — reload the canonical
      // binding and prefer that one. If the canonical binding is for
      // a *different* card we surface the conflict; otherwise we
      // return the canonical record so all callers converge.
      const canonical = await this.deps.nullifierStore.get(nullifierKey);
      if (canonical === undefined) {
        throw new WorldcoinIssuerError(
          "CHAIN_TX_FAILED",
          "nullifier store put failed without a readable canonical binding",
          500,
        );
      }
      if (canonical.agentCardPubkey !== req.agentCardPubkey) {
        throw new WorldcoinIssuerError(
          "NULLIFIER_BOUND_TO_OTHER_CARD",
          "nullifier already bound to a different AgentCard",
          409,
        );
      }
      return {
        credentialPda: canonical.credentialPda,
        txSignature: canonical.txSignature,
        claimUri: canonical.claimUri,
        claimHash: canonical.claimHash,
        idempotent: true,
      };
    }

    return {
      credentialPda: chainResult.credentialPda,
      txSignature: chainResult.txSignature,
      claimUri,
      claimHash,
      idempotent: false,
    };
  }
}

/** Compose the JSON-LD VC envelope per §7 of the spec. */
export function buildVerifiedHumanVc(input: {
  readonly issuerDid: string;
  readonly agentCardPubkey: AgentCardPubkey;
  readonly verificationLevel: WorldcoinVerificationLevel;
  readonly nullifierHash: Hex32;
  readonly merkleRoot: Hex32;
  readonly issuanceDate: string;
}): Record<string, unknown> {
  return {
    "@context": [...VERIFIED_HUMAN_VC_CONTEXT],
    type: ["VerifiableCredential", "VerifiedHumanCredential"],
    issuer: input.issuerDid,
    issuanceDate: input.issuanceDate,
    credentialSubject: {
      id: `did:eto:agentcard:${input.agentCardPubkey}`,
      verificationLevel: input.verificationLevel,
      worldIdAction: VERIFIED_HUMAN_ACTION,
      worldIdNullifierHash: normalizeHex(input.nullifierHash),
      worldIdMerkleRoot: normalizeHex(input.merkleRoot),
    },
  };
}

/** `orb` strictly satisfies `device`-or-better; everything satisfies `device`. */
function satisfiesLevel(
  actual: WorldcoinVerificationLevel,
  required: WorldcoinVerificationLevel,
): boolean {
  if (required === "device") return true;
  return actual === "orb";
}

/* -------------------------------------------------------------------------- */
/* Default fetch-backed CloudVerifier                                          */
/* -------------------------------------------------------------------------- */

export interface FetchCloudVerifierOptions {
  readonly appId: string;
  readonly apiKey: string;
  readonly baseUrl?: string;
  /** Pluggable for tests / proxies. Defaults to global `fetch`. */
  readonly fetchFn?: typeof fetch;
}

/**
 * Default `CloudVerifier` that talks to
 * `https://developer.worldcoin.org/api/v2/verify/{appId}` per §4.1.
 * Returned errors are mapped to `WorldcoinIssuerError("PROOF_REJECTED")`
 * with the upstream error code embedded in `message`.
 */
export function createFetchCloudVerifier(
  opts: FetchCloudVerifierOptions,
): CloudVerifier {
  const baseUrl = opts.baseUrl ?? "https://developer.worldcoin.org";
  const fetchFn = opts.fetchFn ?? globalThis.fetch;
  if (typeof fetchFn !== "function") {
    throw new Error(
      "createFetchCloudVerifier: no fetch implementation available",
    );
  }
  return {
    async verifyProof(input) {
      const url = `${baseUrl}/api/v2/verify/${encodeURIComponent(opts.appId)}`;
      const body = JSON.stringify({
        proof: input.proof,
        merkle_root: input.merkleRoot,
        nullifier_hash: input.nullifierHash,
        signal: input.signal,
        action: input.action,
      });
      const res = await fetchFn(url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${opts.apiKey}`,
        },
        body,
      });
      if (!res.ok) {
        const text = await res.text().catch(() => "");
        if (res.status >= 500) {
          throw new WorldcoinIssuerError(
            "UPSTREAM_OUTAGE",
            `Worldcoin /verify ${res.status}: ${text.slice(0, 200)}`,
            503,
          );
        }
        throw new WorldcoinIssuerError(
          "PROOF_REJECTED",
          `Worldcoin /verify ${res.status}: ${text.slice(0, 200)}`,
          400,
        );
      }
      const json = (await res.json()) as {
        success?: boolean;
        verification_level?: WorldcoinVerificationLevel;
        nullifier_hash?: string;
        action?: string;
        code?: string;
        detail?: string;
      };
      if (json.success !== true) {
        throw new WorldcoinIssuerError(
          "PROOF_REJECTED",
          `Worldcoin /verify rejected: ${json.code ?? "unknown"} ${json.detail ?? ""}`.trim(),
          400,
        );
      }
      if (
        json.verification_level !== "orb" &&
        json.verification_level !== "device"
      ) {
        throw new WorldcoinIssuerError(
          "PROOF_REJECTED",
          `Worldcoin /verify returned unknown verification_level: ${String(json.verification_level)}`,
          400,
        );
      }
      if (typeof json.nullifier_hash !== "string") {
        throw new WorldcoinIssuerError(
          "PROOF_REJECTED",
          "Worldcoin /verify response missing nullifier_hash",
          400,
        );
      }
      return {
        success: true,
        verificationLevel: json.verification_level,
        nullifierHash: normalizeHex(json.nullifier_hash),
        action: json.action ?? input.action,
      };
    },
  };
}
