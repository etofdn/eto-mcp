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
// `civic.enabled` is derived: true iff both `CIVIC_GATEKEEPER_NETWORK`
// and `CIVIC_ISSUER_KEYPAIR_PATH` are non-empty.

import type { CivicConfig } from "./issuers/civic.types.js";
import bs58 from "bs58";

export interface AppConfig {
  readonly civic: CivicConfig;
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
  return { civic: loadCivicConfig(env) };
}
