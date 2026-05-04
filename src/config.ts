// `@eto/mcp` — runtime configuration loader.
//
// Loads issuer-specific config blocks from the process environment.
// At present only the Civic block (T-1.4.1.3, FN-039) is wired up;
// the Worldcoin block will land alongside under a separate task.
//
// Env vars:
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

export const ISSUER_URL = process.env.ISSUER_URL || "https://eto-mcp.fly.dev";

export const config = {
  port: parseInt(process.env.PORT || "3000"),
  etoRpcUrl: process.env.ETO_RPC_URL || "http://localhost:8899",
  etoWsUrl: process.env.ETO_WS_URL || "",
  network: (process.env.NETWORK || "testnet") as "mainnet" | "testnet" | "devnet",
  logLevel: (process.env.LOG_LEVEL || "info") as "debug" | "info" | "warn" | "error",
  corsOrigins: process.env.CORS_ORIGINS || "*",

  chain: {
    id: 17743, // 0x454F
    idHex: "0x454f",
    nativeDecimals: 9,
    nativeSymbol: "ETO",
  },

  rpc: {
    cacheBalanceTtlMs: 2000,
    cacheBlockHeightTtlMs: 1000,
    cacheStatsTtlMs: 5000,
    cacheAccountTtlMs: 5000,
  },

  tx: {
    blockhashRefreshMs: 20_000,
    blockhashValidityMs: 60_000,
    defaultTimeoutMs: 30_000,
    maxRetries: 3,
    confirmationPollMs: 400,
    /**
     * FN-197: maximum number of consecutive non-"not found" errors that
     * `TransactionSubmitter.pollConfirmation` tolerates before bubbling
     * the error to the outer retry classifier. Override via env
     * `ETO_TX_MAX_POLL_ERRORS` (positive integer).
     */
    maxPollErrors: (() => {
      const v = parseInt(process.env.ETO_TX_MAX_POLL_ERRORS ?? "", 10);
      return Number.isFinite(v) && v > 0 ? v : 3;
    })(),
  },

  auth: {
    sessionTtlSeconds: 300,
    refreshTtlSeconds: 86400,
    devBypass: process.env.AUTH_DEV_BYPASS === "true" || process.env.NODE_ENV !== "production",
  },

  rateLimits: {
    readPerMinute: 100,
    writePerMinute: 20,
    deployPerMinute: 5,
  },

  subscriptions: {
    pollIntervalMs: 2000,
    maxPerUser: 50,
    notificationBufferSize: 100,
  },
} as const;

export const PROGRAM_IDS = {
  system: new Uint8Array(32).fill(0),
  evm: (() => { const b = new Uint8Array(32).fill(0xFF); b[31] = 0xEE; return b; })(),
  wasm: (() => { const b = new Uint8Array(32).fill(0xFF); b[31] = 0x03; return b; })(),
  move: (() => { const b = new Uint8Array(32).fill(0xFF); b[31] = 0x02; return b; })(),
  zkVerify: (() => { const b = new Uint8Array(32).fill(0xFF); b[31] = 0x04; return b; })(),
  zkBn254: (() => { const b = new Uint8Array(32).fill(0xFF); b[31] = 0x05; return b; })(),
  universalToken: (() => { const b = new Uint8Array(32).fill(0xFF); b[31] = 0x06; return b; })(),
  token: Uint8Array.from([
    6, 221, 246, 225, 215, 101, 161, 147, 217, 203, 225, 70, 206, 235, 121, 172,
    28, 180, 133, 237, 95, 91, 55, 145, 58, 140, 245, 133, 126, 255, 0, 169,
  ]),
  ata: Uint8Array.from([
    140, 151, 37, 143, 78, 36, 137, 241, 187, 61, 16, 41, 20, 142, 13, 131,
    11, 90, 19, 153, 218, 255, 16, 132, 4, 142, 123, 216, 219, 233, 248, 89,
  ]),
  stake: (() => {
    const b = new Uint8Array(32).fill(0);
    b[0] = 0x06; b[1] = 0xa1; b[2] = 0xd8; b[3] = 0x17;
    b[4] = 0x91; b[5] = 0x37; b[6] = 0x54; b[7] = 0x2a;
    return b;
  })(),
  vote: (() => {
    const b = new Uint8Array(32).fill(0);
    b[0] = 0x07; b[1] = 0x61; b[2] = 0x48; b[3] = 0x17;
    return b;
  })(),
  agent: (() => {
    const b = new Uint8Array(32);
    b[0] = 0xA6; b[1] = 0xE7; b[2] = 0x01; b[30] = 0xAE; b[31] = 0x01;
    return b;
  })(),
  mcp: (() => {
    const b = new Uint8Array(32);
    b[0] = 0xBC; b[1] = 0xD0; b[2] = 0x01; b[30] = 0xBC; b[31] = 0x01;
    return b;
  })(),
  a2a: (() => {
    const b = new Uint8Array(32);
    b[0] = 0xA2; b[1] = 0xA0; b[2] = 0x01; b[30] = 0xA2; b[31] = 0x01;
    return b;
  })(),
  swarm: (() => {
    const b = new Uint8Array(32);
    b[0] = 0x5A; b[1] = 0xAF; b[2] = 0x01; b[30] = 0x5A; b[31] = 0x01;
    return b;
  })(),
} as const;

export interface AppConfig {
  readonly civic: CivicConfig;
  readonly becknBridge: BecknBridgeConfig;
}

// ---------------------------------------------------------------------------
// Gateway / MCP server config
// ---------------------------------------------------------------------------

export interface GatewayConfig {
  readonly etoRpcUrl: string;
  readonly etoWsUrl: string;
  readonly network: string;
  readonly auth: {
    readonly devBypass: boolean;
    readonly sessionSecret: string;
    readonly oauthClientId: string;
    readonly oauthClientSecret: string;
  };
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
  readonly chain: {
    readonly id: number;
  };
  readonly civic: CivicConfig;
}

function readEnvInt(key: string, fallback: number): number {
  const v = process.env[key];
  const n = v !== undefined ? parseInt(v, 10) : NaN;
  return Number.isFinite(n) ? n : fallback;
}

function loadGatewayConfig(): GatewayConfig {
  const etoRpcUrl =
    process.env["ETO_RPC_URL"] ??
    process.env["SOLANA_RPC_URL"] ??
    "http://127.0.0.1:8899";

  const etoWsUrl =
    process.env["ETO_WS_URL"] ??
    process.env["SOLANA_WS_URL"] ??
    etoRpcUrl.replace(/^https?:\/\//, "ws://").replace(/^http:\/\//, "ws://");

  const network = process.env["ETO_NETWORK"] ?? "devnet";

  const devBypass =
    process.env["ETO_AUTH_DEV_BYPASS"] === "true" ||
    process.env["NODE_ENV"] === "test";

  return {
    etoRpcUrl,
    etoWsUrl,
    network,
    auth: {
      devBypass,
      sessionSecret: process.env["ETO_SESSION_SECRET"] ?? "dev-secret-change-in-production",
      oauthClientId: process.env["ETO_OAUTH_CLIENT_ID"] ?? "",
      oauthClientSecret: process.env["ETO_OAUTH_CLIENT_SECRET"] ?? "",
    },
    rateLimits: {
      readPerMinute: readEnvInt("ETO_RATE_READ_PER_MIN", 100),
      writePerMinute: readEnvInt("ETO_RATE_WRITE_PER_MIN", 20),
      deployPerMinute: readEnvInt("ETO_RATE_DEPLOY_PER_MIN", 5),
    },
    tx: {
      defaultTimeoutMs: readEnvInt("ETO_TX_TIMEOUT_MS", 30_000),
      maxRetries: readEnvInt("ETO_TX_MAX_RETRIES", 3),
      confirmationPollMs: readEnvInt("ETO_TX_POLL_MS", 400),
      maxPollErrors: readEnvInt("ETO_TX_MAX_POLL_ERRORS", 3),
    },
    chain: {
      id: readEnvInt("ETO_EVM_CHAIN_ID", 9001),
    },
    civic: loadCivicConfig(),
  };
}

/** Singleton gateway config — loaded once from env at startup. */
export const config: GatewayConfig = loadGatewayConfig();

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

function readEnv(key: string): string {
  const v = process.env[key];
  return typeof v === "string" ? v : "";
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

export function loadAppConfig(
  env: NodeJS.ProcessEnv = process.env,
): AppConfig {
  // `readEnv` is exported via use to satisfy the unused-warning gate
  // in case future blocks use it directly.
  void readEnv;
  return {
    civic: loadCivicConfig(env),
    becknBridge: loadBecknBridgeConfig(env),
  };
}

// ---------------------------------------------------------------------------
// Runtime config singleton
// ---------------------------------------------------------------------------
//
// Used by auth.ts, auth-routes.ts, and rate-limiter.ts. Sourced from env vars
// with sensible defaults so the MCP server boots without a config file.
//
// NOTE: This object deliberately uses required-with-defaults rather than
// optional fields so that consumers get a concrete value for every field
// (avoids exactOptionalPropertyTypes false positives at call-sites).

export interface RuntimeConfig {
  readonly auth: {
    /** Bypass auth checks in dev/testnet mode (ETO_DEV_BYPASS=1). */
    readonly devBypass: boolean;
    /** Session token TTL in seconds (default: 86400). */
    readonly sessionTtlSeconds: number;
    /** Session refresh window in seconds (default: 3600). */
    readonly refreshTtlSeconds: number;
  };
  readonly network: "mainnet" | "testnet" | "devnet";
  readonly rateLimits: {
    readonly readPerMinute: number;
    readonly writePerMinute: number;
    readonly deployPerMinute: number;
  };
}

function validateNetwork(v: string | undefined): "mainnet" | "testnet" | "devnet" {
  if (v === "mainnet" || v === "testnet" || v === "devnet") return v;
  return "testnet";
}

/** Lazily-loaded runtime config singleton. */
export const config: RuntimeConfig = {
  auth: {
    devBypass: process.env["ETO_DEV_BYPASS"] === "1",
    sessionTtlSeconds: Number(process.env["ETO_SESSION_TTL_SECONDS"] ?? 86400),
    refreshTtlSeconds: Number(process.env["ETO_REFRESH_TTL_SECONDS"] ?? 3600),
  },
  network: validateNetwork(process.env["ETO_NETWORK"]),
  rateLimits: {
    readPerMinute: Number(process.env["ETO_RATE_READ_PER_MIN"] ?? 120),
    writePerMinute: Number(process.env["ETO_RATE_WRITE_PER_MIN"] ?? 30),
    deployPerMinute: Number(process.env["ETO_RATE_DEPLOY_PER_MIN"] ?? 5),
  },
};
