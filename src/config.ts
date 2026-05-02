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

export interface AppConfig {
  readonly civic: CivicConfig;
}

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
