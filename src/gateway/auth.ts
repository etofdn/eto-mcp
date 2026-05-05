import { AsyncLocalStorage } from "node:async_hooks";
import { config } from "../config.js";
import { verifySession, hasCapability, CAPABILITY_SCOPES, type Capability, type SessionPayload } from "./session.js";
import { McpError } from "../errors/index.js";
import { mintSessionAttestation } from "./session-attestation.js";

export interface AuthContext {
  session: SessionPayload;
  userId: string;
  walletId: string;
  /**
   * FN-049: compact-JWS session attestation signed by the server's Ed25519 key.
   * Null for stdio (__stdio__), dev-bypass, and any session where minting fails.
   * Non-null for siwe / inapp_email / inapp_oauth sessions.
   */
  session_attestation_jws: string | null;
}

// Ambient bearer token for the current request. The SSE server extracts the
// Authorization header in POST /message and wraps the handler chain in
// runWithAuth(bearer, fn). The MCP SDK's tool-handler dispatch doesn't pass the
// original HTTP headers through, so authenticate() falls back to this ALS when
// called with no explicit header (e.g. from instrumentServer's wrapper).
interface AuthAmbient {
  bearer?: string;
}
const authStore = new AsyncLocalStorage<AuthAmbient>();

export function runWithAuth<T>(bearer: string | undefined, fn: () => T): T {
  // Conditionally include bearer to satisfy exactOptionalPropertyTypes.
  return authStore.run(
    bearer !== undefined ? { bearer } : {},
    fn,
  );
}

function getAmbientBearer(): string | undefined {
  return authStore.getStore()?.bearer;
}

// Dev bypass session for testnet/dev mode
const DEV_SESSION: SessionPayload = {
  sub: "dev-user",
  iss: "eto-mcp",
  aud: "eto-agent",
  exp: Math.floor(Date.now() / 1000) + 86400 * 365, // 1 year
  iat: Math.floor(Date.now() / 1000),
  jti: "dev-session",
  caps: Object.keys(CAPABILITY_SCOPES),
  wallet_id: "dev-wallet",
  network: "testnet",
  auth_strategy: "dev",
};

/**
 * Authenticate a request. In dev mode, bypasses auth entirely.
 * In production, verifies the PASETO/HMAC session token.
 *
 * FN-049: For non-stdio, non-dev sessions (siwe / inapp_email / inapp_oauth),
 * mints a compact-JWS session attestation signed by the server's Ed25519 key.
 * The JWS is returned on `AuthContext.session_attestation_jws`. Failures in
 * minting never hard-fail auth — the field is null instead.
 */
export function authenticate(authHeader?: string): AuthContext {
  // Dev bypass — no attestation for dev sessions.
  if (config.auth.devBypass) {
    return {
      session: DEV_SESSION,
      userId: DEV_SESSION.sub,
      walletId: DEV_SESSION.wallet_id,
      session_attestation_jws: null,
    };
  }

  // Fall back to the ambient bearer stashed by runWithAuth when no explicit
  // header is threaded through (MCP tool-handler dispatch can't see req.headers).
  const headerOrAmbient = authHeader ?? getAmbientBearer();

  if (!headerOrAmbient) {
    throw new McpError(
      "AUTH_001", "auth", "Authentication required",
      "No authorization header provided. Include a Bearer token.",
      [{ action: "authenticate", description: "Obtain a session token via the auth endpoint" }],
      false
    );
  }

  const token = headerOrAmbient.replace(/^Bearer\s+/i, "");
  const session = verifySession(token);

  if (!session) {
    throw new McpError(
      "AUTH_001", "auth", "Session expired or invalid",
      "Your session token is expired or invalid. Re-authenticate to continue.",
      [{ action: "re_authenticate", description: "Call the auth endpoint again" }],
      false
    );
  }

  // FN-049: Mint a session attestation JWS for non-dev, non-stdio strategies.
  // The auth_strategy field distinguishes real human-attested sessions
  // (siwe / inapp_email / inapp_oauth) from dev bypass (already short-circuited
  // above). stdio sessions don't reach this code path (they don't carry tokens).
  let session_attestation_jws: string | null = null;
  const strategy = session.auth_strategy;
  if (
    strategy === "siwe" ||
    strategy === "inapp_email" ||
    strategy === "inapp_oauth"
  ) {
    try {
      session_attestation_jws = mintSessionAttestation({
        sub: session.sub,
        jti: session.jti,
        exp: session.exp,
      });
    } catch {
      // Never hard-fail auth due to attestation minting failure.
      session_attestation_jws = null;
    }
  }

  return {
    session,
    userId: session.sub,
    walletId: session.wallet_id,
    session_attestation_jws,
  };
}

/**
 * Check that the session has the required capability.
 */
export function requireCapability(session: SessionPayload, cap: Capability): void {
  if (!hasCapability(session, cap)) {
    throw new McpError(
      "AUTH_002", "auth", "Insufficient capabilities",
      `Your session doesn't have the '${cap}' capability. You have: ${session.caps.join(", ")}.`,
      [{ action: "request_capabilities", description: "Create a new session with the required capabilities" }],
      false
    );
  }
}
