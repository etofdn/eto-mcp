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

