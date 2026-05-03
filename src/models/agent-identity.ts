/**
 * Agent Identity Model — `human × model × environment × session`.
 *
 * Reference TypeScript shape for the spec at
 * [`docs/agent-identity-model.md`](../../docs/agent-identity-model.md).
 *
 * **Status (FN-058):** spec-only. This module is exported but is NOT wired
 * into any MCP tool, request handler, or transport. FN-059 is the first task
 * that will consume `AgentIdentity` in a handler. Do not import from
 * `src/tools/session.ts` here — the builder takes a structurally typed input
 * (a `session_info`-shaped payload) to keep this module decoupled from any
 * concrete tool implementation.
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
 * - `"verified"` — provider-signed JWS verified against published JWKS.
 *   ONLY this state is safe for capability gating.
 * - `"self_declared"` — the agent advertised a model claim but no signature
 *   was verified. Telemetry-only; never gate capabilities on this.
 * - `"absent"` — no claim was made (or verification failed). Do not branch
 *   on model identity at all.
 */
export type AttestationStatus = "verified" | "self_declared" | "absent";

/** A claim about which AI model produced the agent's actions. See spec §2.2. */
export type ModelAttestation =
  | {
      attestation_status: "verified";
      provider: string;
      model_id: string;
      /** JWS `kid` from the verified attestation. */
      kid: string;
      /** Issuance timestamp (seconds since epoch) of the verified JWS. */
      issued_at: number;
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
}

/**
 * Build an {@link AgentIdentity} from a `session_info`-shaped payload, with
 * no provider integration. The result always has
 * `model_attestation.attestation_status` of `"self_declared"` (when
 * `declared_model` is present) or `"absent"`.
 *
 * Pure function — no I/O, no global state.
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
  const model_attestation: ModelAttestation = input.declared_model
    ? {
        attestation_status: "self_declared",
        provider: input.declared_model.provider,
        model_id: input.declared_model.model_id,
      }
    : { attestation_status: "absent" };

  const session_scope: SessionScope = {
    scope: input.scope,
    expires_at_iso: input.token_expires_at ?? null,
    capabilities: [...(input.capabilities ?? [])],
    ...(input.jti !== undefined ? { jti: input.jti } : {}),
  };

  return { human_authority, model_attestation, environment, session_scope };
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
