import { createThirdwebClient, type ThirdwebClient } from "thirdweb";
import { createAuth } from "thirdweb/auth";
import type {
  GenerateLoginPayloadParams,
  VerifyLoginPayloadParams,
  VerifyLoginPayloadResult,
  LoginPayload,
} from "thirdweb/auth";

// thirdweb = identity-only. We use SIWE verification for SSE callers, but
// signing stays local / FROST — this module never touches private key material.
// inapp_* strategies (email, oauth) still produce a SIWE-style signed payload
// from the client; we just record which strategy the client declared.

export type AuthStrategy = "siwe" | "inapp_email" | "inapp_oauth";

let cachedClient: ThirdwebClient | null = null;
let cachedAuth: ReturnType<typeof createAuth> | null = null;

function getClient(): ThirdwebClient {
  if (cachedClient) return cachedClient;
  const clientId = process.env.THIRDWEB_CLIENT_ID;
  const secretKey = process.env.THIRDWEB_SECRET_KEY;
  if (!clientId || !secretKey) {
    throw new Error(
      "thirdweb is not configured: set THIRDWEB_CLIENT_ID and THIRDWEB_SECRET_KEY " +
      "(or enable AUTH_DEV_BYPASS=true for local development)."
    );
  }
  cachedClient = createThirdwebClient({ clientId, secretKey });
  return cachedClient;
}

function getAuth(): ReturnType<typeof createAuth> {
  if (cachedAuth) return cachedAuth;
  const domain = process.env.AUTH_DOMAIN ?? "eto-mcp";
  cachedAuth = createAuth({ domain, client: getClient() });
  return cachedAuth;
}

export function generatePayload(params: GenerateLoginPayloadParams): Promise<LoginPayload> {
  return getAuth().generatePayload(params);
}

export function verifyPayload(params: VerifyLoginPayloadParams): Promise<VerifyLoginPayloadResult> {
  return getAuth().verifyPayload(params);
}

export type { LoginPayload, VerifyLoginPayloadResult };
