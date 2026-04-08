import { sha256 } from "@noble/hashes/sha256";

/**
 * Session management using signed tokens.
 * Phase 1: Simple HMAC-signed JSON tokens (PASETO v4 deferred to Phase 2).
 */

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

// Simple signing key (Phase 1: from env or random)
const signingKey = (() => {
  const envKey = process.env.PASETO_SIGNING_KEY;
  if (envKey) return new TextEncoder().encode(envKey);
  // Dev mode: deterministic key
  return sha256(new TextEncoder().encode("eto-mcp-dev-signing-key-DO-NOT-USE-IN-PROD"));
})();

function hmacSign(payload: string): string {
  const data = new TextEncoder().encode(payload);
  const combined = new Uint8Array(signingKey.length + data.length);
  combined.set(signingKey);
  combined.set(data, signingKey.length);
  const sig = sha256(combined);
  return Buffer.from(sig).toString("base64url");
}

export function createSession(opts: {
  userId: string;
  walletId: string;
  network?: "mainnet" | "testnet" | "devnet";
  capabilities?: Capability[];
  agentId?: string;
  ttlSeconds?: number;
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
    if (sig !== expectedSig) return null;

    const payload = JSON.parse(json) as SessionPayload;

    // Check expiry
    if (payload.exp < Math.floor(Date.now() / 1000)) return null;

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
  });
}
