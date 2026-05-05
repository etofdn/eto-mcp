// `@eto/mcp` — runtime configuration loader.
//
// Loads issuer-specific config blocks from the process environment.
// At present only the Civic block (T-1.4.1.3, FN-039) is wired up;
// the Worldcoin block will land alongside under a separate task.
//
// Env vars:
//   ETO_AUTH_DEV_BYPASS=true   enable dev-bypass (explicit opt-in only; never NODE_ENV-derived)
//   CIVIC_GATEKEEPER_NETWORK   base58 Civic gatekeeper-network pubkey
//   CIVIC_ISSUER_KEYPAIR_PATH  filesystem path to the issuer keypair
//   CIVIC_NETWORK_ID           32-byte hex `IssuerNetwork` id
//
// Beckn bridge env vars:
//   BECKN_BPP_BACKEND_URL              base URL of the backend BPP (enables inbound BPP role)
//   BECKN_BPP_FORWARD_TIMEOUT_MS       abort timeout for backend POST (default: 5000)
//   BECKN_BAP_CALLBACK_TIMEOUT_MS      abort timeout for on_confirm callback (default: 5000)
//   BECKN_BAP_CALLBACK_ALLOWED_HOSTS   comma-separated allowlist of BAP hostnames; empty → deny all
//   BECKN_BPP_ID                       BPP identifier echoed in on_confirm context
//   BECKN_BPP_URI                      BPP URI echoed in on_confirm context
//
// `civic.enabled` is derived: true iff both `CIVIC_GATEKEEPER_NETWORK`
// and `CIVIC_ISSUER_KEYPAIR_PATH` are non-empty.
// `becknBridge.enabled` is derived: true iff `BECKN_BPP_BACKEND_URL` is non-empty.

import type { CivicConfig } from "./issuers/civic.types.js";
import bs58 from "bs58";

// ---------- Beckn bridge config ----------

/**
 * Configuration for the inbound BPP role of the Beckn HTTP bridge (FN-090).
 *
 * `enabled` is derived from whether `bppBackendUrl` is non-empty.
 * When `enabled` is false, `/confirm` returns 503.
 *
 * `bapCallbackAllowedHosts` is the allowlist of hostnames the gateway will
 * POST `on_confirm` to. An empty list means deny-all (safe default in
 * production). Pass `["*"]` as an explicit wildcard for tests only.
 */
export interface BecknBridgeConfig {
  /** Whether the inbound BPP role is active. Derived from `bppBackendUrl`. */
  readonly enabled: boolean;
  /** Base URL of the upstream BPP service this gateway forwards `/confirm` to. */
  readonly bppBackendUrl: string;
  /** Milliseconds before the backend forward call times out. Default: 5000. */
  readonly forwardTimeoutMs: number;
  /** Milliseconds before the on_confirm BAP callback times out. Default: 5000. */
  readonly bapCallbackTimeoutMs: number;
  /**
   * Allowlist of hostnames the gateway may POST `on_confirm` to.
   * Empty array → deny all callbacks.
   * `["*"]` → wildcard (for tests only; do not set in production).
   */
  readonly bapCallbackAllowedHosts: string[];
  /** BPP identifier echoed in on_confirm context. Falls back to inbound bpp_id if unset. */
  readonly bppId: string;
  /** BPP URI echoed in on_confirm context. Falls back to inbound bpp_uri if unset. */
  readonly bppUri: string;
}

export function loadBecknBridgeConfig(
  env: NodeJS.ProcessEnv = process.env,
): BecknBridgeConfig {
  const bppBackendUrl = (env.BECKN_BPP_BACKEND_URL ?? "").trim();
  const forwardTimeoutMs = parseInt(env.BECKN_BPP_FORWARD_TIMEOUT_MS ?? "5000", 10);
  const bapCallbackTimeoutMs = parseInt(env.BECKN_BAP_CALLBACK_TIMEOUT_MS ?? "5000", 10);
  const allowedHostsRaw = (env.BECKN_BAP_CALLBACK_ALLOWED_HOSTS ?? "").trim();
  const bapCallbackAllowedHosts = allowedHostsRaw.length > 0
    ? allowedHostsRaw.split(",").map((h) => h.trim()).filter(Boolean)
    : [];
  const bppId = (env.BECKN_BPP_ID ?? "").trim();
  const bppUri = (env.BECKN_BPP_URI ?? "").trim();
  return {
    enabled: bppBackendUrl.length > 0,
    bppBackendUrl,
    forwardTimeoutMs: Number.isFinite(forwardTimeoutMs) && forwardTimeoutMs > 0 ? forwardTimeoutMs : 5000,
    bapCallbackTimeoutMs: Number.isFinite(bapCallbackTimeoutMs) && bapCallbackTimeoutMs > 0 ? bapCallbackTimeoutMs : 5000,
    bapCallbackAllowedHosts,
    bppId,
    bppUri,
  };
}

// ---------------------------------------------------------------------------
// OAuth issuer URL
// ---------------------------------------------------------------------------

export const ISSUER_URL: string =
  (process.env["ISSUER_URL"] ?? "").replace(/\/$/, "") ||
  `http://localhost:${process.env["PORT"] ?? "3000"}`;

// ---------------------------------------------------------------------------
// On-chain program IDs (base58-decoded to Uint8Array)
// ---------------------------------------------------------------------------

function programId(envKey: string, devDefault: string): Uint8Array {
  const val = process.env[envKey] ?? devDefault;
  try {
    return bs58.decode(val);
  } catch {
    // If the value isn't valid base58, return zeros (will fail on-chain but
    // won't crash the server at startup in test environments).
    return new Uint8Array(32);
  }
}

export const PROGRAM_IDS = {
  /** ETO MCP core program */
  mcp: programId("ETO_PROGRAM_MCP", "EToMCPProgram111111111111111111111111111111"),
  /** ETO Agent registry program */
  agent: programId("ETO_PROGRAM_AGENT", "EToAgentProgram111111111111111111111111111"),
  /** ETO Swarm coordination program */
  swarm: programId("ETO_PROGRAM_SWARM", "EToSwarmProgram111111111111111111111111111"),
  /** ETO A2A messaging program */
  a2a: programId("ETO_PROGRAM_A2A", "EToA2AProgram1111111111111111111111111111"),
  /** ZK verifier — BN254 */
  zkBn254: programId("ETO_PROGRAM_ZK_BN254", "EToZkBn254Program111111111111111111111111"),
  /** ZK verifier — generic */
  zkVerify: programId("ETO_PROGRAM_ZK_VERIFY", "EToZkVerifyProgram11111111111111111111111"),
} as const;

export interface AppConfig {
  readonly civic: CivicConfig;
  readonly becknBridge: BecknBridgeConfig;
}

export function loadCivicConfig(
  env: NodeJS.ProcessEnv = process.env,
): CivicConfig {
  const gatekeeperNetwork = (env.CIVIC_GATEKEEPER_NETWORK ?? "").trim();
  const issuerKeypairPath = (env.CIVIC_ISSUER_KEYPAIR_PATH ?? "").trim();
  const networkId = (env.CIVIC_NETWORK_ID ?? "").trim();
  return {
    gatekeeperNetwork,
    issuerKeypairPath,
    networkId,
    enabled: gatekeeperNetwork.length > 0 && issuerKeypairPath.length > 0,
  };
}

// ---------------------------------------------------------------------------
// FN-048 — MCP server signing / JWKS publication config
// ---------------------------------------------------------------------------
//
// Env vars:
//   MCP_SERVER_SIGNING_KEY_PATH  filesystem path to a 32-byte Ed25519 seed
//                                (raw / hex / base64). REQUIRED in production
//                                so JWS issued by this server keep verifying
//                                across restarts. In non-production an
//                                ephemeral key is generated.
//   MCP_JWKS_OVERLAP_SECONDS     overlap window during which the previous key
//                                is also served at /.well-known/jwks.json.
//                                Default: 300. Bounded [60, 86400].
//
// Loading is additive — these surface alongside existing config entries
// without touching the duplicate-export situation tracked under FN-062 / FN-066.

export interface McpServerSigningConfig {
  readonly keyPath: string;
  readonly jwksOverlapSeconds: number;
}

export function loadMcpServerSigningConfig(
  env: NodeJS.ProcessEnv = process.env,
): McpServerSigningConfig {
  const keyPath = (env.MCP_SERVER_SIGNING_KEY_PATH ?? "").trim();
  const raw = env.MCP_JWKS_OVERLAP_SECONDS;
  const parsed = typeof raw === "string" && raw.length > 0 ? parseInt(raw, 10) : NaN;
  const jwksOverlapSeconds =
    Number.isFinite(parsed) && parsed >= 60 && parsed <= 86400 ? parsed : 300;
  return { keyPath, jwksOverlapSeconds };
}

export function loadAppConfig(
  env: NodeJS.ProcessEnv = process.env,
): AppConfig {
  return {
    civic: loadCivicConfig(env),
    becknBridge: loadBecknBridgeConfig(env),
  };
}

// ---------------------------------------------------------------------------
// Runtime config singleton (single source of truth — FN-081)
// ---------------------------------------------------------------------------
//
// Consolidates three previously-divergent `config` blocks into one. All
// consumers (auth.ts, server.ts, sse-server.ts, submitter.ts, …) import
// from this single export.
//
// devBypass env var: ETO_AUTH_DEV_BYPASS=true  (FN-108: canonical name)
//   - Must be set explicitly; never enabled by NODE_ENV alone.
//   - The legacy AUTH_DEV_BYPASS name is no longer read anywhere.
//   - In production, this MUST NOT be set (server.ts validates this).

function validateNetwork(v: string | undefined): "mainnet" | "testnet" | "devnet" {
  if (v === "mainnet" || v === "testnet" || v === "devnet") return v;
  return "testnet";
}

export interface RuntimeConfig {
  readonly etoRpcUrl: string;
  readonly etoWsUrl: string;
  readonly network: "mainnet" | "testnet" | "devnet";
  readonly auth: {
    /**
     * Bypass auth checks in dev/testnet mode.
     * Controlled exclusively by ETO_AUTH_DEV_BYPASS=true.
     * Never enabled by NODE_ENV alone; never defaults to true.
     */
    readonly devBypass: boolean;
    /** Session token TTL in seconds (default: 300). */
    readonly sessionTtlSeconds: number;
    /** Session refresh window in seconds (default: 86400). */
    readonly refreshTtlSeconds: number;
  };
  readonly chain: {
    readonly id: number;
  };
  readonly civic: CivicConfig;
  readonly rateLimits: {
    readonly readPerMinute: number;
    readonly writePerMinute: number;
    readonly deployPerMinute: number;
  };
  readonly tx: {
    readonly defaultTimeoutMs: number;
    readonly maxRetries: number;
    readonly confirmationPollMs: number;
    /**
     * FN-197: max consecutive non-"not found" RPC failures tolerated by
     * `pollConfirmation` before bubbling. Env: `ETO_TX_MAX_POLL_ERRORS`.
     */
    readonly maxPollErrors: number;
  };
}

function readEnvIntFrom(env: NodeJS.ProcessEnv, key: string, fallback: number): number {
  const v = env[key];
  const n = v !== undefined ? parseInt(v, 10) : NaN;
  return Number.isFinite(n) ? n : fallback;
}

/**
 * Load the runtime config from a given environment (defaults to `process.env`).
 *
 * Exported for tests so they can assert env-var contracts (notably FN-081
 * `ETO_AUTH_DEV_BYPASS` semantics) without re-evaluating the module.
 */
export function loadRuntimeConfig(
  env: NodeJS.ProcessEnv = process.env,
): RuntimeConfig {
  const etoRpcUrl =
    env["ETO_RPC_URL"] ??
    env["SOLANA_RPC_URL"] ??
    "http://127.0.0.1:8899";

  const etoWsUrl =
    env["ETO_WS_URL"] ??
    env["SOLANA_WS_URL"] ??
    etoRpcUrl.replace(/^https?:\/\//, "ws://").replace(/^http:\/\//, "ws://");

  return {
    etoRpcUrl,
    etoWsUrl,
    network: validateNetwork(env["ETO_NETWORK"]),
    auth: {
      // FN-081: single env var, explicit opt-in only, never NODE_ENV-derived.
      // The string "true" is the only accepted truthy value; anything else
      // (including "1", "yes", or NODE_ENV=development|test|production) keeps
      // devBypass=false.
      devBypass: env["ETO_AUTH_DEV_BYPASS"] === "true",
      sessionTtlSeconds: readEnvIntFrom(env, "ETO_SESSION_TTL_SECONDS", 300),
      refreshTtlSeconds: readEnvIntFrom(env, "ETO_REFRESH_TTL_SECONDS", 86400),
    },
    chain: {
      id: readEnvIntFrom(env, "ETO_EVM_CHAIN_ID", 9001),
    },
    civic: loadCivicConfig(env),
    rateLimits: {
      readPerMinute: readEnvIntFrom(env, "ETO_RATE_READ_PER_MIN", 100),
      writePerMinute: readEnvIntFrom(env, "ETO_RATE_WRITE_PER_MIN", 20),
      deployPerMinute: readEnvIntFrom(env, "ETO_RATE_DEPLOY_PER_MIN", 5),
    },
    tx: {
      defaultTimeoutMs: readEnvIntFrom(env, "ETO_TX_TIMEOUT_MS", 30_000),
      maxRetries: readEnvIntFrom(env, "ETO_TX_MAX_RETRIES", 3),
      confirmationPollMs: readEnvIntFrom(env, "ETO_TX_POLL_MS", 400),
      maxPollErrors: readEnvIntFrom(env, "ETO_TX_MAX_POLL_ERRORS", 3),
    },
  };
}

/** Singleton runtime config — loaded once from env at startup. */
export const config: RuntimeConfig = loadRuntimeConfig();
