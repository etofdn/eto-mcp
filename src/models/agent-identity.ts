/**
 * Agent identity model: human × model × environment × session_scope.
 *
 * This module is the canonical TypeScript reference for the identity shape
 * defined in {@link ../../docs/agent-identity-model.md}. It is **reference-
 * only** until FN-059 wires it into request handlers / A2A bridges; nothing
 * in production code paths imports it yet. Do not change `session_info`,
 * `SessionClaims`, or any MCP tool registration as part of consuming this
 * file — those are FN-059's job.
 *
 * Tracking issue: https://github.com/etofdn/eto-mcp/issues/11
 *
 * @see ../../docs/agent-identity-model.md §2 for field-by-field threat model.
 * @see ../../docs/agent-identity-model.md §3 for the authority-inheritance rule.
 * @see ../../docs/agent-identity-model.md §5 for the interim builder semantics.
 */

/**
 * Auth strategies recognized by `human_authority.auth_strategy`. The first
 * three correspond to verified human auth flows on the gateway. `dev` and
 * `__stdio__` are explicitly **unverified** trust modes.
 *
 * Mirrors `AuthStrategy` in `src/gateway/session.ts` plus the `__stdio__`
 * scope sentinel from `src/signing/session-context.ts`.
 *
 * @see ../../docs/agent-identity-model.md §2.1
 */
export type HumanAuthStrategy =
  | "siwe"
  | "inapp_email"
  | "inapp_oauth"
  | "dev"
  | "__stdio__";

/**
 * The verified human principal whose authority the agent borrows.
 *
 * @see ../../docs/agent-identity-model.md §2.1
 */
export interface HumanAuthority {
  /** Subject identifier (thirdweb wallet, "dev-user", or stdio principal). */
  sub: string;
  /** Auth strategy that produced this principal. */
  auth_strategy: HumanAuthStrategy;
  /**
   * `true` only for verified flows (`siwe`, `inapp_email`, `inapp_oauth`).
   * `dev` and `__stdio__` MUST be reported as `false` so authority
   * inheritance refuses to engage. See spec §3.
   */
  verified: boolean;
}

/**
 * Status of the model-provider attestation.
 *
 * - `verified` — JWS validated against provider JWKS (FN-061; not implemented).
 * - `self_declared` — caller asserted `provider`/`model`; not verified.
 * - `absent` — no model metadata supplied.
 *
 * @see ../../docs/agent-identity-model.md §2.2
 */
export type AttestationStatus = "verified" | "self_declared" | "absent";

/**
 * Which AI model / provider issued the agent's actions. Forward-looking;
 * see §4 of the spec for the verification roadmap (tracked in FN-061).
 *
 * @see ../../docs/agent-identity-model.md §2.2
 */
export interface ModelAttestation {
  attestation_status: AttestationStatus;
  /** Provider identifier, e.g. "anthropic", "openai", "google". */
  provider?: string;
  /** Model identifier with version, e.g. "claude-sonnet-4-5". */
  model?: string;
  /** Reserved for FN-061: detached JWS signature. */
  signature?: string;
  /** Reserved for FN-061: ISO-8601 issuance time. */
  signed_at?: string;
  /** Reserved for FN-061: signing key id from provider JWKS. */
  key_id?: string;
}

/**
 * Cryptographic anchor for the active wallet of an `Environment`.
 *
 * @see ../../docs/agent-identity-model.md §2.3
 */
export interface WalletAnchor {
  wallet_id: string;
  /** base58 Ed25519 pubkey, or `null` if the signer could not derive it. */
  svm: string | null;
  /** 0x-prefixed hex EVM address, or `null` if the signer could not derive it. */
  evm: string | null;
}

/**
 * Execution surface the agent runs on, anchored cryptographically by the
 * active wallet's keypair.
 *
 * @see ../../docs/agent-identity-model.md §2.3
 */
export interface Environment {
  /** Stable identifier for this MCP instance (env-derived; see Q2 in spec §7). */
  mcp_server: string;
  network: "mainnet" | "testnet" | "devnet";
  wallet_anchor: WalletAnchor;
  /** ISO-8601 from `session_info.last_restart_iso`. */
  last_restart_iso: string;
}

/**
 * Bounds the identity to a single MCP session.
 *
 * @see ../../docs/agent-identity-model.md §2.4
 */
export interface SessionScope {
  /** `currentScope()` — sub / "__stdio__" / "__dev__". */
  scope: string;
  token_expires_at: string | null;
  token_expires_in_seconds: number | null;
  /** `SessionPayload.jti` for revocation correlation. */
  jti?: string;
}

/**
 * The four-axis identity an agent presents in cross-agent (A2A) trust
 * decisions. See `docs/agent-identity-model.md` for the full spec.
 */
export interface AgentIdentity {
  human_authority: HumanAuthority;
  model_attestation: ModelAttestation;
  environment: Environment;
  session_scope: SessionScope;
}

/**
 * Shape of the `session_info` MCP tool response. Replicated here (rather than
 * imported from `src/tools/session.ts`) so this module remains pure and the
 * builder can be exercised from any context — request handlers, A2A bridges,
 * tests — without dragging tool-registration side effects.
 */
export interface SessionInfoLike {
  wallets: Array<{
    id: string;
    label: string | null;
    svm: string | null;
    evm: string | null;
  }>;
  active_wallet_id: string | null;
  scope: string;
  auth_strategy: string | null;
  token_expires_at: string | null;
  token_expires_in_seconds: number | null;
  last_restart_iso: string;
}

/**
 * Optional fields callers may layer on top of a {@link SessionInfoLike}
 * payload when building an interim {@link AgentIdentity}.
 */
export interface InterimIdentityExtras {
  /** Self-declared provider, e.g. "anthropic". Sets attestation_status to "self_declared". */
  provider?: string;
  /** Self-declared model, e.g. "claude-sonnet-4-5". */
  model?: string;
  /** Override for `Environment.mcp_server`. Defaults to "eto-mcp". */
  mcp_server?: string;
  /** Override for `Environment.network`. Defaults to "testnet". */
  network?: "mainnet" | "testnet" | "devnet";
  /** Subject override (e.g. when scope is "__stdio__" / "__dev__" and a richer sub is known). */
  sub?: string;
  /** Token jti for revocation correlation. */
  jti?: string;
}

const VERIFIED_STRATEGIES: ReadonlySet<HumanAuthStrategy> = new Set([
  "siwe",
  "inapp_email",
  "inapp_oauth",
]);

const KNOWN_STRATEGIES: ReadonlySet<HumanAuthStrategy> = new Set([
  "siwe",
  "inapp_email",
  "inapp_oauth",
  "dev",
  "__stdio__",
]);

function normalizeStrategy(input: string | null | undefined, scope: string): HumanAuthStrategy {
  if (input && (KNOWN_STRATEGIES as ReadonlySet<string>).has(input)) {
    return input as HumanAuthStrategy;
  }
  // Fall back from scope sentinels when the session has no explicit strategy
  // (stdio entrypoint sets scope="__stdio__" but the SessionPayload.auth_strategy
  // field is absent; dev-bypass paths likewise).
  if (scope === "__stdio__") return "__stdio__";
  return "dev";
}

/**
 * Build a structurally valid {@link AgentIdentity} from a `session_info`-
 * shaped payload, with no I/O and no provider integration.
 *
 * Invariants:
 * - `model_attestation.attestation_status` is `"self_declared"` when
 *   `extras.provider` or `extras.model` is supplied, otherwise `"absent"`.
 *   It is never `"verified"` from this builder — verification is FN-061.
 * - `human_authority.verified` is `true` only for `siwe` / `inapp_email` /
 *   `inapp_oauth` strategies.
 * - Throws if `input.scope` is missing/empty — the spec requires every
 *   identity to be bound to a session scope (§2.4).
 *
 * @see ../../docs/agent-identity-model.md §5
 */
export function buildInterimAgentIdentity(
  input: SessionInfoLike,
  extras: InterimIdentityExtras = {},
): AgentIdentity {
  if (!input.scope || typeof input.scope !== "string") {
    throw new Error(
      "buildInterimAgentIdentity: missing required field `session_scope` " +
        "(input.scope must be a non-empty string)",
    );
  }

  const strategy = normalizeStrategy(input.auth_strategy, input.scope);
  const sub = extras.sub ?? input.scope;

  const human_authority: HumanAuthority = {
    sub,
    auth_strategy: strategy,
    verified: VERIFIED_STRATEGIES.has(strategy),
  };

  const hasModelHint = extras.provider !== undefined || extras.model !== undefined;
  const model_attestation: ModelAttestation = hasModelHint
    ? {
        attestation_status: "self_declared",
        ...(extras.provider !== undefined ? { provider: extras.provider } : {}),
        ...(extras.model !== undefined ? { model: extras.model } : {}),
      }
    : { attestation_status: "absent" };

  const activeId = input.active_wallet_id;
  const activeWallet =
    (activeId && input.wallets.find((w) => w.id === activeId)) ||
    input.wallets[0] ||
    null;

  const wallet_anchor: WalletAnchor = activeWallet
    ? {
        wallet_id: activeWallet.id,
        svm: activeWallet.svm,
        evm: activeWallet.evm,
      }
    : {
        wallet_id: activeId ?? "",
        svm: null,
        evm: null,
      };

  const environment: Environment = {
    mcp_server: extras.mcp_server ?? "eto-mcp",
    network: extras.network ?? "testnet",
    wallet_anchor,
    last_restart_iso: input.last_restart_iso,
  };

  const session_scope: SessionScope = {
    scope: input.scope,
    token_expires_at: input.token_expires_at ?? null,
    token_expires_in_seconds: input.token_expires_in_seconds ?? null,
    ...(extras.jti !== undefined ? { jti: extras.jti } : {}),
  };

  return { human_authority, model_attestation, environment, session_scope };
}
