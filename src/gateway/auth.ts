import { config } from "../config.js";
import { verifySession, hasCapability, CAPABILITY_SCOPES, type Capability, type SessionPayload } from "./session.js";
import { McpError } from "../errors/index.js";

export interface AuthContext {
  session: SessionPayload;
  userId: string;
  walletId: string;
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
};

/**
 * Authenticate a request. In dev mode, bypasses auth entirely.
 * In production, verifies the PASETO/HMAC session token.
 */
export function authenticate(authHeader?: string): AuthContext {
  // Dev bypass
  if (config.auth.devBypass) {
    return {
      session: DEV_SESSION,
      userId: DEV_SESSION.sub,
      walletId: DEV_SESSION.wallet_id,
    };
  }

  if (!authHeader) {
    throw new McpError(
      "AUTH_001", "auth", "Authentication required",
      "No authorization header provided. Include a Bearer token.",
      [{ action: "authenticate", description: "Obtain a session token via the auth endpoint" }],
      false
    );
  }

  const token = authHeader.replace("Bearer ", "");
  const session = verifySession(token);

  if (!session) {
    throw new McpError(
      "AUTH_001", "auth", "Session expired or invalid",
      "Your session token is expired or invalid. Re-authenticate to continue.",
      [{ action: "re_authenticate", description: "Call the auth endpoint again" }],
      false
    );
  }

  return {
    session,
    userId: session.sub,
    walletId: session.wallet_id,
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
