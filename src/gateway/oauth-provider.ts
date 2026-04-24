import { randomBytes } from "crypto";
import { readFileSync, writeFileSync, mkdirSync } from "fs";
import { homedir } from "os";
import { join } from "path";
import type { Response } from "express";
import type { OAuthServerProvider, AuthorizationParams } from "@modelcontextprotocol/sdk/server/auth/provider.js";
import type { OAuthRegisteredClientsStore } from "@modelcontextprotocol/sdk/server/auth/clients.js";
import type { OAuthClientInformationFull, OAuthTokenRevocationRequest, OAuthTokens } from "@modelcontextprotocol/sdk/shared/auth.js";
import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import { createSession, verifySession } from "./session.js";
import { config } from "../config.js";

const WALLET_DIR = process.env.ETO_WALLET_DIR || join(homedir(), ".eto", "wallets");
const REFRESH_TOKENS_PATH = join(WALLET_DIR, "refresh_tokens.json");

interface PendingCode {
  address: string;
  code_challenge: string;
  client_id: string;
  redirect_uri: string;
  scope: string[];
  exp: number;
}

type RefreshEntry = { address: string; client_id: string; scope: string[] };

const clientsMap = new Map<string, OAuthClientInformationFull>();
const pendingCodes = new Map<string, PendingCode>();
const refreshTokens = new Map<string, RefreshEntry>();

function loadRefreshTokens(): void {
  try {
    const raw = readFileSync(REFRESH_TOKENS_PATH, "utf8");
    const entries = JSON.parse(raw) as [string, RefreshEntry][];
    for (const [token, entry] of entries) refreshTokens.set(token, entry);
    console.error(`[eto-mcp] Loaded ${entries.length} persisted refresh tokens`);
  } catch {
    // File doesn't exist yet — start empty
  }
}

function saveRefreshTokens(): void {
  try {
    mkdirSync(WALLET_DIR, { recursive: true });
    writeFileSync(REFRESH_TOKENS_PATH, JSON.stringify(Array.from(refreshTokens.entries())), { mode: 0o600 });
  } catch (e) {
    console.error("[eto-mcp] Failed to persist refresh tokens:", e);
  }
}

loadRefreshTokens();

const clientsStore: OAuthRegisteredClientsStore = {
  getClient(clientId: string) {
    return clientsMap.get(clientId);
  },
  registerClient(clientData) {
    const client_id = randomBytes(16).toString("hex");
    const client: OAuthClientInformationFull = {
      ...clientData,
      client_id,
      client_id_issued_at: Math.floor(Date.now() / 1000),
    };
    clientsMap.set(client_id, client);
    return client;
  },
};

/** Issue a short-lived auth code after a successful SIWE — called from POST /oauth-callback */
export function issueAuthCode(
  address: string,
  params: { codeChallenge: string; client_id: string; redirectUri: string; scopes?: string[]; state?: string }
): string {
  const code = randomBytes(32).toString("base64url");
  pendingCodes.set(code, {
    address,
    code_challenge: params.codeChallenge,
    client_id: params.client_id,
    redirect_uri: params.redirectUri,
    scope: params.scopes ?? ["mcp:tools"],
    exp: Math.floor(Date.now() / 1000) + 600,
  });
  return code;
}

export const oauthProvider: OAuthServerProvider = {
  clientsStore,

  async authorize(client: OAuthClientInformationFull, params: AuthorizationParams, res: Response) {
    const oauthState = Buffer.from(
      JSON.stringify({
        client_id: client.client_id,
        redirect_uri: params.redirectUri,
        code_challenge: params.codeChallenge,
        scope: params.scopes,
        state: params.state,
      })
    ).toString("base64url");
    res.redirect(`/login?oauth_state=${oauthState}`);
  },

  async challengeForAuthorizationCode(_client: OAuthClientInformationFull, code: string) {
    const pending = pendingCodes.get(code);
    if (!pending) throw new Error("Unknown authorization code");
    return pending.code_challenge;
  },

  async exchangeAuthorizationCode(
    client: OAuthClientInformationFull,
    code: string,
    _codeVerifier?: string,
    _redirectUri?: string,
    _resource?: URL
  ): Promise<OAuthTokens> {
    const pending = pendingCodes.get(code);
    if (!pending) throw new Error("Unknown or expired authorization code");
    if (pending.exp < Math.floor(Date.now() / 1000)) {
      pendingCodes.delete(code);
      throw new Error("Authorization code expired");
    }
    pendingCodes.delete(code);

    const accessToken = createSession({
      userId: pending.address,
      walletId: pending.address,
      clientId: client.client_id,
      network: config.network,
      ttlSeconds: config.auth.sessionTtlSeconds,
      authStrategy: "siwe",
    });

    const refreshToken = randomBytes(32).toString("base64url");
    refreshTokens.set(refreshToken, {
      address: pending.address,
      client_id: client.client_id,
      scope: pending.scope,
    });
    saveRefreshTokens();

    return {
      access_token: accessToken,
      token_type: "bearer",
      expires_in: config.auth.sessionTtlSeconds,
      refresh_token: refreshToken,
      scope: pending.scope.join(" "),
    };
  },

  async exchangeRefreshToken(
    client: OAuthClientInformationFull,
    refreshToken: string,
    _scopes?: string[],
    _resource?: URL
  ): Promise<OAuthTokens> {
    const stored = refreshTokens.get(refreshToken);
    if (!stored || stored.client_id !== client.client_id) {
      throw new Error("Invalid refresh token");
    }

    const accessToken = createSession({
      userId: stored.address,
      walletId: stored.address,
      clientId: client.client_id,
      network: config.network,
      ttlSeconds: config.auth.sessionTtlSeconds,
      authStrategy: "siwe",
    });

    return {
      access_token: accessToken,
      token_type: "bearer",
      expires_in: config.auth.sessionTtlSeconds,
      scope: stored.scope.join(" "),
    };
  },

  async verifyAccessToken(token: string): Promise<AuthInfo> {
    const session = verifySession(token);
    if (!session) throw new Error("Invalid or expired token");
    return {
      token,
      clientId: session.client_id ?? session.sub,
      scopes: session.caps,
      expiresAt: session.exp,
    };
  },

  async revokeToken(_client: OAuthClientInformationFull, request: OAuthTokenRevocationRequest) {
    refreshTokens.delete(request.token);
    saveRefreshTokens();
  },
};
