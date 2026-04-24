import { sha256 } from "@noble/hashes/sha256";
import { hmac } from "@noble/hashes/hmac";
import { timingSafeEqual } from "crypto";
import { homedir } from "os";
import { join } from "path";
import { atomicWriteJson, loadJsonArray } from "./persisted-store.js";

/**
 * Session management using HMAC-SHA256 signed JSON tokens.
 *
 * Token format: base64url(json_payload).hex(hmac_sha256(payload))
 * NOT a standard JWT - no `alg` header, no JWS envelope. If this needs to be
 * consumed by a third-party JWT verifier later, migrate to PASETO v4 or JWS.
 *
 * Signing key is sourced from SESSION_SIGNING_KEY, falling back to the
 * historical PASETO_SIGNING_KEY env var for backwards compatibility.
 */

export type AuthStrategy = "siwe" | "inapp_email" | "inapp_oauth" | "dev";

export interface SessionPayload {
  sub: string;           // user ID
  iss: "eto-mcp";
  aud: "eto-agent";
  exp: number;           // expiry timestamp (seconds)
  iat: number;           // issued at
  jti: string;           // unique token ID
  caps: string[];        // capabilities
  wallet_id: string;     // active wallet
  network: "mainnet" | "testnet" | "devnet";
  agent_id?: string;
  auth_strategy?: AuthStrategy;
  client_id?: string;    // OAuth client ID (set when issued via OAuth 2.1 flow)
}

export const CAPABILITY_SCOPES = {
  "wallet:read": "View wallet addresses and balances",
  "wallet:create": "Create new wallets and derive addresses",
  "account:read": "Query account information",
  "token:read": "View token balances and metadata",
  "token:write": "Create, mint, burn, transfer tokens",
  "block:read": "Query block and transaction data",
  "chain:read": "View chain stats and health",
  "validator:read": "View validator and epoch info",
  "contract:read": "Read contract state (view calls)",
  "transfer:write": "Send native token transfers",
  "deploy:write": "Deploy smart contracts",
  "contract:write": "Execute contract transactions",
  "stake:write": "Create and manage stake accounts",
  "vote:write": "Submit votes",
  "agent:write": "Create and manage on-chain agents",
  "agent:read": "View agent information",
  "crossvm:write": "Execute cross-VM calls",
  "batch:write": "Execute batch operations",
  "zk:write": "Submit ZK proofs",
  "a2a:read": "View A2A channels and messages",
  "a2a:write": "Create channels and send A2A messages",
  "mcp_program:read": "View registered MCP services",
  "mcp_program:write": "Register and invoke MCP services",
  "swarm:read": "View swarm state and proposals",
  "swarm:write": "Create swarms, propose, and vote",
  "subscription:write": "Manage event subscriptions",
  "security:admin": "Manage FROST key shares and step-up auth",
  "session:admin": "Manage sessions and API keys",
  "policy:admin": "Configure spending limits and policies",
  "webhook:admin": "Manage event subscriptions",
} as const;

export type Capability = keyof typeof CAPABILITY_SCOPES;

const ALL_CAPS = Object.keys(CAPABILITY_SCOPES) as Capability[];

// Signing key: must be set in production.
// Accepts either SESSION_SIGNING_KEY (preferred) or PASETO_SIGNING_KEY
// (legacy name - this implementation is HMAC-SHA256, not PASETO).
const signingKey = (() => {
  const envKey = process.env.SESSION_SIGNING_KEY ?? process.env.PASETO_SIGNING_KEY;
  if (process.env.NODE_ENV === "production") {
    if (!envKey || envKey.length < 32) {
      console.error(
        "FATAL: SESSION_SIGNING_KEY (or legacy PASETO_SIGNING_KEY) must be set to at least 32 characters in production",
      );
      process.exit(1);
    }
  }
  if (envKey) return new TextEncoder().encode(envKey);
  // Dev mode: deterministic key
  return sha256(new TextEncoder().encode("eto-mcp-dev-signing-key-DO-NOT-USE-IN-PROD"));
})();

function hmacSign(data: string): string {
  const mac = hmac(sha256, signingKey, new TextEncoder().encode(data));
  return Buffer.from(mac).toString("hex");
}

// Access tokens are stateless HMAC, so revocation needs a small denylist.
// Entries are keyed by jti and expire naturally when the token would expire.
const DENYLIST_PATH = join(
  process.env.ETO_WALLET_DIR || join(homedir(), ".eto", "wallets"),
  "revoked_jtis.json",
);
const denyList = new Map<string, number>();
(function loadDenyList() {
  const now = Math.floor(Date.now() / 1000);
  for (const [jti, exp] of loadJsonArray<[string, number]>(DENYLIST_PATH)) {
    if (exp > now) denyList.set(jti, exp);
  }
})();

export function revokeJti(jti: string, exp: number): void {
  denyList.set(jti, exp);
  atomicWriteJson(DENYLIST_PATH, [...denyList.entries()]);
}

// Signed oauth_state carries /authorize params through /login to
// /oauth-callback. This prevents client-side tampering of redirect_uri,
// code_challenge, client_id, scope, and state.
export function signOauthState(payload: object): string {
  const json = JSON.stringify(payload);
  const sig = hmacSign(json);
  return `${Buffer.from(json).toString("base64url")}.${sig}`;
}

export function verifyOauthState<T = unknown>(token: string): T | null {
  try {
    const [b64, sig] = token.split(".");
    if (!b64 || !sig) return null;
    const json = Buffer.from(b64, "base64url").toString();
    const expected = Buffer.from(hmacSign(json), "hex");
    const actual = Buffer.from(sig, "hex");
    if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) return null;
    return JSON.parse(json) as T;
  } catch {
    return null;
  }
}

export function createSession(opts: {
  userId: string;
  walletId: string;
  network?: "mainnet" | "testnet" | "devnet";
  capabilities?: Capability[];
  agentId?: string;
  ttlSeconds?: number;
  authStrategy?: AuthStrategy;
  clientId?: string;
}): string {
  const now = Math.floor(Date.now() / 1000);
  const payload: SessionPayload = {
    sub: opts.userId,
    iss: "eto-mcp",
    aud: "eto-agent",
    iat: now,
    exp: now + (opts.ttlSeconds || 300),
    jti: crypto.randomUUID(),
    caps: opts.capabilities || ALL_CAPS,
    wallet_id: opts.walletId,
    network: opts.network || "testnet",
    agent_id: opts.agentId,
    auth_strategy: opts.authStrategy,
    client_id: opts.clientId,
  };
  const json = JSON.stringify(payload);
  const sig = hmacSign(json);
  return `${Buffer.from(json).toString("base64url")}.${sig}`;
}

export function verifySession(token: string): SessionPayload | null {
  try {
    const [payloadB64, sig] = token.split(".");
    if (!payloadB64 || !sig) return null;

    const json = Buffer.from(payloadB64, "base64url").toString();
    const expectedSig = hmacSign(json);
    const expectedBuf = Buffer.from(expectedSig, "hex");
    const actualBuf = Buffer.from(sig, "hex");
    if (expectedBuf.length !== actualBuf.length || !timingSafeEqual(expectedBuf, actualBuf)) return null;

    const payload = JSON.parse(json) as SessionPayload;

    // Check expiry
    if (payload.exp < Math.floor(Date.now() / 1000)) return null;

    // Check access-token denylist.
    if (denyList.has(payload.jti)) return null;

    return payload;
  } catch {
    return null;
  }
}

export function hasCapability(session: SessionPayload, cap: Capability): boolean {
  return session.caps.includes(cap);
}

/** Create a dev session with all capabilities (for testnet/dev) */
export function createDevSession(walletId: string): string {
  return createSession({
    userId: "dev-user",
    walletId,
    network: "testnet",
    capabilities: ALL_CAPS,
    ttlSeconds: 86400, // 24h for dev
    authStrategy: "dev",
  });
}
