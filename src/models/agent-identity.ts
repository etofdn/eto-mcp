/**
 * Agent Identity Model — `human × model × environment × session`.
 *
 * Reference TypeScript shape for the spec at
 * [`docs/agent-identity-model.md`](../../docs/agent-identity-model.md).
 *
 * **Status (FN-095):** foundational module providing AgentIdentity types and
 * `buildInterimAgentIdentity` constructor. This module is intentionally
 * decoupled from any MCP tool implementation — it accepts a structurally typed
 * input (a `session_info`-shaped payload) rather than importing from
 * `src/tools/session.ts`.
 *
 * Field-level JSDoc references the section numbers in
 * `docs/agent-identity-model.md` (e.g. `§2.1`).
 */

import type { SvmAddress, EvmAddress } from "./index.js";

// ---------------------------------------------------------------------------
// §2.1 — human_authority
// ---------------------------------------------------------------------------

/**
 * Which auth backend issued the human attestation behind this identity.
 *
 * Matches the realistic set of strategies in `src/gateway/session.ts`
 * (`AuthStrategy`) plus two synthetic kinds:
 *
 * - `"stdio"` — the stdio entrypoint runs in the literal `"__stdio__"` scope
 *   without any human attestation. Local-trust only.
 * - `"unknown"` — fallback when no `auth_strategy` is present and the scope
 *   is not one of the known synthetic scopes.
 *
 * See spec §2.1.
 */
export type HumanAuthorityKind =
  | "thirdweb" // siwe / inapp_email / inapp_oauth — real human-attested
  | "dev"      // dev-bypass; never inherits authority
  | "stdio"    // __stdio__ scope; local trust only
  | "unknown";

/**
 * The human (or human-controlled service account) that consented to this
 * agent acting on their behalf. See spec §2.1.
 */
export interface HumanAuthority {
  /** Persistence-key form of the human identity. Today: `SessionPayload.sub`,
   *  `"__stdio__"`, or `"__dev__"`. See spec §2.1. */
  sub: string;
  /** Coarse classification of the auth backend; see {@link HumanAuthorityKind}. */
  kind: HumanAuthorityKind;
  /** Raw `auth_strategy` from the session token, when present. Mirrors
   *  `SessionPayload.auth_strategy` from `src/gateway/session.ts`. */
  auth_strategy?: "siwe" | "inapp_email" | "inapp_oauth" | "dev";
}

// ---------------------------------------------------------------------------
// §2.2 — model_attestation
// ---------------------------------------------------------------------------

/**
 * Discriminator for {@link ModelAttestation}. See spec §2.2 and §4.
 *
 * - `"verified"` — a JWS attesting `(provider, model_id)` was verified.
 *   The verified arm is itself sub-discriminated by
 *   {@link AttestationSource} (`source: "session_signed" | "provider_oidc"`).
 *   Capability gating MUST consult `provider_verified` (not just
 *   `attestation_status`) — `session_signed` is gateway-witnessed but
 *   NOT provider-attested.
 * - `"self_declared"` — the agent advertised a model claim but no signature
 *   was verified. Telemetry-only; never gate capabilities on this.
 * - `"absent"` — no claim was made (or verification failed). Do not branch
 *   on model identity at all.
 */
export type AttestationStatus = "verified" | "self_declared" | "absent";

/**
 * Sub-discriminator for the {@link ModelAttestation} `verified` arm.
 *
 * - `"session_signed"` — the gateway minted a session-attestation JWS at
 *   auth time binding the caller-declared `(provider, model_id)` to the
 *   session token's `(sub, jti, iat, exp)`. The provider itself did NOT
 *   sign anything; `provider_verified` is therefore always `false`.
 *   Stronger than `self_declared` (the gateway witnessed the binding) but
 *   weaker than `provider_oidc`. See `docs/model-attestation.md` §5.2 and
 *   `docs/agent-identity-model.md` §2.2.
 * - `"provider_oidc"` — a provider-signed JWS (e.g. via the provider's
 *   OIDC JWKS) was verified. `provider_verified` is always `true`.
 *   Capability gating MAY rely on this; see spec §3.2.
 */
export type AttestationSource = "session_signed" | "provider_oidc";

/**
 * A claim about which AI model produced the agent's actions. See spec §2.2.
 *
 * Type-narrowing pattern:
 * ```ts
 * if (m.attestation_status === "verified") {
 *   //                       ^? "session_signed" | "provider_oidc"
 *   if (m.source === "provider_oidc") {
 *     // m.provider_verified is `true`
 *   } else {
 *     // m.source is "session_signed"; m.provider_verified is `false`
 *   }
 * }
 * ```
 */
export type ModelAttestation =
  | {
      attestation_status: "verified";
      /** Sub-discriminator — see {@link AttestationSource}. */
      source: "session_signed";
      /** Always `false` for `session_signed` — the gateway, not the provider, signed. */
      provider_verified: false;
      provider: string;
      model_id: string;
      /** JWS `kid` from the verified attestation. */
      kid: string;
      /** Issuance timestamp (seconds since epoch) of the verified JWS. */
      issued_at: number;
      /** The compact-form JWS string (RFC 7515) that produced this verified result. */
      jws: string;
    }
  | {
      attestation_status: "verified";
      source: "provider_oidc";
      /** Always `true` for `provider_oidc` — the provider's signing key signed. */
      provider_verified: true;
      provider: string;
      model_id: string;
      kid: string;
      issued_at: number;
      jws: string;
    }
  | {
      attestation_status: "self_declared";
      provider: string;
      model_id: string;
    }
  | {
      attestation_status: "absent";
    };

// ---------------------------------------------------------------------------
// §2.3 — environment
// ---------------------------------------------------------------------------

/** Execution surface the agent is running on. See spec §2.3. */
export type ExecutionSurface = "stdio" | "sse" | "dev";

/**
 * Cryptographic anchor — the wallet whose private keys actually sign actions.
 * Matches the active-wallet shape returned by `session_info`. See spec §2.3.
 */
export interface WalletAnchor {
  id: string;
  /** Base58 Ed25519 public key. Null if the signer could not be loaded. */
  svm: SvmAddress | null;
  /** 0x-hex secp256k1 address. Null if the signer could not be loaded. */
  evm: EvmAddress | null;
  label?: string | null;
}

/** Where the agent is executing + its cryptographic anchor. See spec §2.3. */
export interface Environment {
  surface: ExecutionSurface;
  /** Stable per-process identifier; today: the server's `last_restart_iso`. */
  server_instance: string;
  /** The active wallet whose keys sign actions. */
  wallet_anchor: WalletAnchor;
}

// ---------------------------------------------------------------------------
// §2.4 — session_scope
// ---------------------------------------------------------------------------

/** The bounded MCP session window. See spec §2.4. */
export interface SessionScope {
  /** Persistence-key form of the scope; mirrors `currentScope()`. */
  scope: string;
  /** Session token id (`SessionPayload.jti`) when known. */
  jti?: string;
  /** ISO-8601 expiry; null when no token is bound (e.g. stdio). */
  expires_at_iso: string | null;
  /** Capabilities granted on the session token; see `CAPABILITY_SCOPES`. */
  capabilities: string[];
}

// ---------------------------------------------------------------------------
// §6 — top-level shape
// ---------------------------------------------------------------------------

/**
 * The canonical agent identity tuple. See spec §1 and §6.
 *
 * Consumers MUST evaluate all four axes independently; see §3 for the
 * authority-inheritance rule and §5 for the trust degradation that applies
 * when `model_attestation.attestation_status !== "verified"`.
 */
export interface AgentIdentity {
  /** §2.1 — who authorized this agent. */
  human_authority: HumanAuthority;
  /** §2.2 — which AI model is steering it. */
  model_attestation: ModelAttestation;
  /** §2.3 — where it's running and the cryptographic anchor. */
  environment: Environment;
  /** §2.4 — bounded MCP session window. */
  session_scope: SessionScope;
}

// ---------------------------------------------------------------------------
// §5 — interim builder
// ---------------------------------------------------------------------------

/**
 * Structurally typed input mirroring the `session_info` MCP tool's response
 * shape. We accept it as a plain shape (not by importing from
 * `src/tools/session.ts`) so this module stays decoupled from the tool layer.
 *
 * See spec §5.
 */
export interface InterimAgentIdentityInput {
  /** From `currentScope()`; required. */
  scope: string;
  /** Active wallet id; from `getActiveWalletId()`. */
  active_wallet_id: string | null;
  /** Wallet list as returned by `session_info`. */
  wallets: ReadonlyArray<{
    id: string;
    label?: string | null;
    svm: SvmAddress | null;
    evm: EvmAddress | null;
  }>;
  /** From `SessionPayload.auth_strategy`. */
  auth_strategy?: "siwe" | "inapp_email" | "inapp_oauth" | "dev" | null;
  /** ISO string from `session_info.token_expires_at`. */
  token_expires_at?: string | null;
  /** ISO string from `session_info.last_restart_iso`. */
  last_restart_iso: string;
  /** Optional: caller-declared model. Becomes a `self_declared` attestation. */
  declared_model?: { provider: string; model_id: string };
  /** Optional: capabilities from `SessionPayload.caps`. Defaults to `[]`. */
  capabilities?: ReadonlyArray<string>;
  /** Optional: `SessionPayload.jti` when available. */
  jti?: string;
  /**
   * Optional: a session-attestation JWS that has ALREADY been verified by
   * the caller (e.g. FN-049's mint path on the same gateway, or FN-052's
   * counterparty verifier). The builder treats this as opaque — it does
   * NOT decode, verify, or fetch any JWKS. If supplied,
   * `verified_session_jws_claims` MUST also be supplied; otherwise the
   * builder ignores both and falls through to `self_declared` / `absent`.
   *
   * Trust boundary: the agent-identity module is intentionally decoupled
   * from `src/gateway/**` and `src/signing/**`; verification happens in
   * those layers and the result is passed in here as opaque data.
   *
   * See `docs/model-attestation.md` §5.2 for the canonical payload shape.
   */
  verified_session_jws?: string;

  /**
   * Optional: pre-validated claims extracted from `verified_session_jws`.
   * Mirrors a subset of FN-049's `SessionAttestationPayload` — duplicated
   * here (rather than imported) to keep this module decoupled from
   * `src/gateway/session-attestation.ts`.
   *
   * When both fields are present AND the scope is not a dev/stdio sentinel,
   * the builder emits a `ModelAttestation` with `attestation_status:
   * "verified"`, `source: "session_signed"`, `provider_verified: false`.
   */
  verified_session_jws_claims?: {
    /** Mirrors FN-049 `provider_declared`. 1..64 chars. */
    provider: string;
    /** Mirrors FN-049 `model_id_declared`. 1..128 chars. */
    model_id: string;
    /** JWS header `kid`. Non-empty string. */
    kid: string;
    /** Mirrors `payload.iat` (unix seconds). Finite integer. */
    issued_at: number;
  };
}

/**
 * Build an {@link AgentIdentity} from a `session_info`-shaped payload.
 *
 * Model-attestation resolution precedence:
 *
 * 1. **Negative gates.** If `scope === "__stdio__"`, `scope === "__dev__"`,
 *    or `auth_strategy === "dev"`, the builder NEVER emits a `verified` arm
 *    — dev/stdio sessions cannot meaningfully attest a model identity
 *    (cf. FN-049 mint-path negative gates). Falls through to
 *    `self_declared` (if `declared_model`) or `absent`.
 * 2. **Verified arm.** Else if BOTH `verified_session_jws` AND
 *    `verified_session_jws_claims` are supplied, emits
 *    `attestation_status: "verified"`, `source: "session_signed"`,
 *    `provider_verified: false`. The JWS is treated as opaque, already
 *    validated by the caller.
 * 3. **Self-declared arm.** Else if `declared_model` is supplied, emits
 *    `self_declared`.
 * 4. **Absent.** Otherwise emits `absent`.
 *
 * The builder NEVER emits `source: "provider_oidc"` from any input shape.
 * That arm is type-only at this stage; a future task (downstream of FN-052)
 * will add a `verified_provider_oidc_jws` builder path.
 *
 * Pure function — no I/O, no global state, no `Date.now()`.
 *
 * @throws {Error} if `scope` is missing or empty (see spec §5: there is no
 * meaningful identity without a session-scope persistence key).
 */
export function buildInterimAgentIdentity(
  input: InterimAgentIdentityInput,
): AgentIdentity {
  if (!input.scope || typeof input.scope !== "string") {
    throw new Error(
      "buildInterimAgentIdentity: missing required `session_scope` source — `scope` must be a non-empty string (see docs/agent-identity-model.md §5).",
    );
  }

  const human_authority = resolveHumanAuthority(input);
  const environment = resolveEnvironment(input);
  const model_attestation = resolveModelAttestation(input);


  const session_scope: SessionScope = {
    scope: input.scope,
    expires_at_iso: input.token_expires_at ?? null,
    capabilities: [...(input.capabilities ?? [])],
    ...(input.jti !== undefined ? { jti: input.jti } : {}),
  };

  return { human_authority, model_attestation, environment, session_scope };
}

function resolveModelAttestation(
  input: InterimAgentIdentityInput,
): ModelAttestation {
  // Negative gates: dev/stdio sessions cannot meaningfully attest a model.
  // Mirrors FN-049's mint-path gates so a verified arm is never emitted in
  // these scopes even if the caller supplied a JWS.
  const isDevOrStdio =
    input.scope === "__stdio__" ||
    input.scope === "__dev__" ||
    input.auth_strategy === "dev";

  if (
    !isDevOrStdio &&
    input.verified_session_jws &&
    input.verified_session_jws_claims
  ) {
    const claims = input.verified_session_jws_claims;
    return {
      attestation_status: "verified",
      source: "session_signed",
      provider_verified: false,
      provider: claims.provider,
      model_id: claims.model_id,
      kid: claims.kid,
      issued_at: claims.issued_at,
      jws: input.verified_session_jws,
    };
  }

  // asymmetric input — defensively ignore both; fall through to
  // self_declared / absent rather than throwing.

  if (input.declared_model) {
    return {
      attestation_status: "self_declared",
      provider: input.declared_model.provider,
      model_id: input.declared_model.model_id,
    };
  }

  return { attestation_status: "absent" };
}

function resolveHumanAuthority(input: InterimAgentIdentityInput): HumanAuthority {
  const strategy = input.auth_strategy ?? undefined;
  let kind: HumanAuthorityKind;
  if (input.scope === "__stdio__") kind = "stdio";
  else if (input.scope === "__dev__" || strategy === "dev") kind = "dev";
  else if (
    strategy === "siwe" ||
    strategy === "inapp_email" ||
    strategy === "inapp_oauth"
  )
    kind = "thirdweb";
  else kind = "unknown";

  return {
    sub: input.scope,
    kind,
    ...(strategy !== undefined ? { auth_strategy: strategy } : {}),
  };
}

function resolveEnvironment(input: InterimAgentIdentityInput): Environment {
  let surface: ExecutionSurface;
  if (input.scope === "__stdio__") surface = "stdio";
  else if (input.scope === "__dev__" || input.auth_strategy === "dev") surface = "dev";
  else surface = "sse";

  const active = input.wallets.find((w) => w.id === input.active_wallet_id) ??
    input.wallets[0];

  const wallet_anchor: WalletAnchor = active
    ? {
        id: active.id,
        svm: active.svm,
        evm: active.evm,
        label: active.label ?? null,
      }
    : { id: "", svm: null, evm: null, label: null };

  return {
    surface,
    server_instance: input.last_restart_iso,
    wallet_anchor,
  };
}
