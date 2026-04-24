import { randomBytes } from "crypto";
import { homedir } from "os";
import { join } from "path";
import type { Response } from "express";
import type { OAuthServerProvider, AuthorizationParams } from "@modelcontextprotocol/sdk/server/auth/provider.js";
import type { OAuthRegisteredClientsStore } from "@modelcontextprotocol/sdk/server/auth/clients.js";
import type { OAuthClientInformationFull, OAuthTokenRevocationRequest, OAuthTokens } from "@modelcontextprotocol/sdk/shared/auth.js";
import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import { createSession, verifySession, revokeJti, signOauthState } from "./session.js";
import { config } from "../config.js";
import { atomicWriteJson, loadJsonArray } from "./persisted-store.js";

const STORE_DIR = process.env.ETO_WALLET_DIR || join(homedir(), ".eto", "wallets");
const CLIENTS_PATH = join(STORE_DIR, "oauth_clients.json");
const PENDING_CODES_PATH = join(STORE_DIR, "oauth_pending_codes.json");
const REFRESH_TOKENS_PATH = join(STORE_DIR, "refresh_tokens.json");
const RETIRED_REFRESH_PATH = join(STORE_DIR, "retired_refresh_tokens.json");

interface PendingCode {
  address: string;
  code_challenge: string;
  client_id: string;
  redirect_uri: string;
  scope: string[];
  exp: number;
}

type RefreshEntry = { address: string; client_id: string; scope: string[]; family_id: string };
type RetiredEntry = { family_id: string; retired_at: number };

const clientsMap = new Map<string, OAuthClientInformationFull>();
const pendingCodes = new Map<string, PendingCode>();
const refreshTokens = new Map<string, RefreshEntry>();
// Retired refresh tokens from rotation. Re-presentation of one of these means
// an attacker either got the retired token first or the legitimate holder is
// replaying — either way, RFC 6749bis / OAuth 2.0 BCP §4.13.2 says revoke the
// whole family. Entries are pruned at load once retired_at + refreshTtl passes.
const retiredRefresh = new Map<string, RetiredEntry>();

// Load persisted state on module init. Fly.io machines restart on deploy and
// may restart on idle with auto_stop_machines="stop"; without persistence the
// in-memory maps are wiped and clients see "unknown client" / "expired code"
// mid-flow.
(function loadAll() {
  const now = Math.floor(Date.now() / 1000);
  for (const [k, v] of loadJsonArray<[string, OAuthClientInformationFull]>(CLIENTS_PATH)) {
    clientsMap.set(k, v);
  }
  for (const [k, v] of loadJsonArray<[string, PendingCode]>(PENDING_CODES_PATH)) {
    if (v.exp > now) pendingCodes.set(k, v);
  }
  for (const [k, v] of loadJsonArray<[string, RefreshEntry]>(REFRESH_TOKENS_PATH)) {
    // Backfill family_id for tokens persisted by older binaries. Each such
    // token gets its own singleton family so reuse detection still works
    // for any token issued after rotation lands.
    refreshTokens.set(k, { ...v, family_id: v.family_id ?? randomBytes(16).toString("hex") });
  }
  const retirementCutoff = now - config.auth.refreshTtlSeconds;
  for (const [k, v] of loadJsonArray<[string, RetiredEntry]>(RETIRED_REFRESH_PATH)) {
    if (v.retired_at > retirementCutoff) retiredRefresh.set(k, v);
  }
  const loaded = clientsMap.size + pendingCodes.size + refreshTokens.size;
  if (loaded > 0) {
    console.error(
      `[eto-mcp] Loaded OAuth state: ${clientsMap.size} clients, ${pendingCodes.size} pending codes, ${refreshTokens.size} refresh tokens, ${retiredRefresh.size} retired`,
    );
  }
})();

function persistClients() { atomicWriteJson(CLIENTS_PATH, [...clientsMap.entries()]); }
function persistPendingCodes() { atomicWriteJson(PENDING_CODES_PATH, [...pendingCodes.entries()]); }
function persistRefreshTokens() { atomicWriteJson(REFRESH_TOKENS_PATH, [...refreshTokens.entries()]); }
function persistRetiredRefresh() { atomicWriteJson(RETIRED_REFRESH_PATH, [...retiredRefresh.entries()]); }

function revokeFamily(family_id: string): number {
  let n = 0;
  for (const [tok, entry] of refreshTokens) {
    if (entry.family_id === family_id) {
      refreshTokens.delete(tok);
      retiredRefresh.set(tok, { family_id, retired_at: Math.floor(Date.now() / 1000) });
      n++;
    }
  }
  if (n > 0) {
    persistRefreshTokens();
    persistRetiredRefresh();
  }
  return n;
}

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
    persistClients();
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
  persistPendingCodes();
  return code;
}

export const oauthProvider: OAuthServerProvider = {
  clientsStore,

  async authorize(client: OAuthClientInformationFull, params: AuthorizationParams, res: Response) {
    const oauthState = signOauthState({
      client_id: client.client_id,
      redirect_uri: params.redirectUri,
      code_challenge: params.codeChallenge,
      scope: params.scopes,
      state: params.state,
      // Bind the state to roughly the authorize->callback window so a stale
      // state can't be replayed after the login session it belonged to.
      iat: Math.floor(Date.now() / 1000),
    });
    res.redirect(`/login?oauth_state=${encodeURIComponent(oauthState)}`);
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
    redirectUri?: string,
    _resource?: URL
  ): Promise<OAuthTokens> {
    const pending = pendingCodes.get(code);
    if (!pending) throw new Error("Unknown or expired authorization code");
    if (pending.exp < Math.floor(Date.now() / 1000)) {
      pendingCodes.delete(code);
      persistPendingCodes();
      throw new Error("Authorization code expired");
    }
    // OAuth 2.1 §5.2: if redirect_uri was used at /authorize, the same value
    // MUST be sent at /token. The SDK forwards whatever the client sent here;
    // if it's missing the client already violated its own flow, but we still
    // enforce match when present.
    if (redirectUri !== undefined && redirectUri !== pending.redirect_uri) {
      pendingCodes.delete(code);
      persistPendingCodes();
      throw new Error("redirect_uri mismatch");
    }
    // Codes are single-use: burn on any exit (success or failure past this point).
    pendingCodes.delete(code);
    persistPendingCodes();

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
      family_id: randomBytes(16).toString("hex"),
    });
    persistRefreshTokens();

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
    // Reuse detection (OAuth 2.0 BCP §4.13.2): a retired token showing up
    // again means the token leaked — revoke the whole family rather than
    // silently accepting it.
    const retired = retiredRefresh.get(refreshToken);
    if (retired) {
      const revoked = revokeFamily(retired.family_id);
      console.error(`[eto-mcp] refresh reuse detected, family=${retired.family_id} revoked=${revoked}`);
      throw new Error("Refresh token reuse detected; token family revoked");
    }

    const stored = refreshTokens.get(refreshToken);
    if (!stored || stored.client_id !== client.client_id) {
      throw new Error("Invalid refresh token");
    }

    // Rotate: retire the old token, mint a new one in the same family.
    refreshTokens.delete(refreshToken);
    retiredRefresh.set(refreshToken, {
      family_id: stored.family_id,
      retired_at: Math.floor(Date.now() / 1000),
    });
    const newRefreshToken = randomBytes(32).toString("base64url");
    refreshTokens.set(newRefreshToken, { ...stored });
    persistRefreshTokens();
    persistRetiredRefresh();

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
      refresh_token: newRefreshToken,
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
    const entry = refreshTokens.get(request.token);
    if (entry) {
      refreshTokens.delete(request.token);
      // Retire rather than forget — if the revoked token is replayed we want
      // the reuse-detection path to tear down the whole family.
      retiredRefresh.set(request.token, {
        family_id: entry.family_id,
        retired_at: Math.floor(Date.now() / 1000),
      });
      persistRefreshTokens();
      persistRetiredRefresh();
      return;
    }
    // Not a known refresh token — try access-token path. Access tokens are
    // stateless HMAC; revocation adds the jti to a denylist checked at
    // verify time. RFC 7009 says the token type hint is advisory, so we
    // don't rely on request.token_type_hint.
    const session = verifySession(request.token);
    if (session) revokeJti(session.jti, session.exp);
  },
};
