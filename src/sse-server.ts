import express from "express";
import { readFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import { mcpAuthRouter } from "@modelcontextprotocol/sdk/server/auth/router.js";
import { createServer } from "./server.js";
import { config, ISSUER_URL } from "./config.js";
import { blockhashCache } from "./write/blockhash-cache.js";
import { wsManager } from "./read/ws-manager.js";
import { log, dumpStats } from "./utils/logger.js";
import { authRouter } from "./gateway/auth-routes.js";
import { runWithAuth } from "./gateway/auth.js";
import { sessionStore } from "./signing/session-context.js";
import { oauthProvider, issueAuthCode } from "./gateway/oauth-provider.js";
import { verifyPayload } from "./gateway/thirdweb.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const LLMS_TXT = readFileSync(join(__dirname, "../public/llms.txt"), "utf8");

const PORT = parseInt(process.env.PORT || "8080", 10);
const RESOURCE_METADATA_URL = `${ISSUER_URL}/.well-known/oauth-protected-resource`;

const app = express();

// Trust Fly.io / Cloudflare proxy so express-rate-limit can read X-Forwarded-For correctly.
// Without this, the MCP SDK's rate limiter throws ERR_ERL_UNEXPECTED_X_FORWARDED_FOR and crashes.
app.set("trust proxy", 1);

// CORS — must be first so OPTIONS preflight works for all routes including oauth endpoints
app.use((req, res, next) => {
  res.header("Access-Control-Allow-Origin", "*");
  res.header("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
  res.header("Access-Control-Allow-Headers", "Content-Type, Authorization, MCP-Protocol-Version");
  if (req.method === "OPTIONS") {
    res.sendStatus(204);
    return;
  }
  next();
});

// OAuth 2.1 authorization server — serves /.well-known/*, /register, /authorize, /token, /revoke
// Must be installed at the application root per MCP SDK requirements.
app.use(mcpAuthRouter({
  provider: oauthProvider,
  issuerUrl: new URL(ISSUER_URL),
  scopesSupported: ["mcp:tools"],
  resourceName: "Singularity MCP Server",
}));

// Static assets (login.js bundle, etc.)
app.use(express.static(join(__dirname, "../public")));

// Auth UI — thirdweb ConnectButton → SIWE → bearer token (standalone + OAuth mode)
app.get("/login", (_req, res) => {
  res.sendFile(join(__dirname, "../public/login.html"));
});

// OAuth callback — login.tsx POSTs here after SIWE sign-in in OAuth mode
// Body: { payload: LoginPayload, signature: string, oauth_state: string (base64url JSON) }
app.post("/oauth-callback", express.json(), async (req, res) => {
  const { payload, signature, oauth_state } = req.body ?? {};
  if (!payload || !signature || !oauth_state) {
    res.status(400).json({ error: "Missing payload, signature, or oauth_state" });
    return;
  }

  let params: {
    client_id: string;
    redirect_uri: string;
    code_challenge: string;
    scope?: string[];
    state?: string;
  };
  try {
    params = JSON.parse(Buffer.from(oauth_state, "base64url").toString());
  } catch {
    res.status(400).json({ error: "Invalid oauth_state" });
    return;
  }

  const result = await verifyPayload({ payload, signature }).catch(() => ({ valid: false as const, error: "verify failed" }));
  if (!result.valid) {
    const redirectErr = new URL(params.redirect_uri);
    redirectErr.searchParams.set("error", "access_denied");
    if (params.state) redirectErr.searchParams.set("state", params.state);
    res.redirect(redirectErr.toString());
    return;
  }

  const address = (result as any).payload?.address ?? payload.address;
  const code = issueAuthCode(address, {
    codeChallenge: params.code_challenge,
    client_id: params.client_id,
    redirectUri: params.redirect_uri,
    scopes: params.scope,
    state: params.state,
  });

  const redirectUrl = new URL(params.redirect_uri);
  redirectUrl.searchParams.set("code", code);
  if (params.state) redirectUrl.searchParams.set("state", params.state);
  res.redirect(redirectUrl.toString());
});

// llms.txt — agent-readable description of this server
app.get("/", (_req, res) => {
  res.type("text/plain").send(LLMS_TXT);
});

app.get("/llms.txt", (_req, res) => {
  res.type("text/plain").send(LLMS_TXT);
});

// Health check for Fly.io
app.get("/health", (_req, res) => {
  res.json({ status: "ok", version: "1.0.0", tools: 81, network: config.network });
});

// Auth endpoints: /auth/login, /auth/verify, /auth/me.
app.use("/auth", authRouter);

// Track active transports for cleanup
const transports = new Map<string, SSEServerTransport>();

// SSE endpoint — client connects here to establish SSE stream
app.get("/sse", async (req, res) => {
  log("info", "sse", "New SSE connection", { ip: req.ip });

  const transport = new SSEServerTransport("/message", res);
  const sessionId = transport.sessionId;
  transports.set(sessionId, transport);

  res.on("close", () => {
    transports.delete(sessionId);
    log("info", "sse", "SSE connection closed", { sessionId });
  });

  const server = await createServer();
  await server.connect(transport);

  log("info", "sse", "MCP server connected via SSE", { sessionId });
});

// Message endpoint — client sends JSON-RPC messages here
app.post("/message", async (req, res) => {
  const sessionId = req.query.sessionId as string;

  const authHeader = req.header("authorization") ?? "";
  const bearerMatch = authHeader.match(/^Bearer\s+(.+)$/i);
  const bearer = bearerMatch?.[1]?.trim();
  if (!bearer && !config.auth.devBypass) {
    res.set("WWW-Authenticate", `Bearer realm="mcp", resource_metadata="${RESOURCE_METADATA_URL}"`);
    res.status(401).json({
      code: "AUTH_001",
      category: "auth",
      message: "Authentication required",
      explanation: "No Bearer token. Add this MCP server to your client and complete the OAuth flow.",
    });
    return;
  }

  const transport = transports.get(sessionId);
  if (!transport) {
    res.status(400).json({ error: "Invalid or expired session. Connect to /sse first." });
    return;
  }

  await runWithAuth(bearer, () =>
    sessionStore.run({ sessionId, scope: "__pending__" }, () =>
      transport.handlePostMessage(req, res),
    ),
  );
});

// Start
async function startSseServer(): Promise<void> {
  blockhashCache.startRefresh();

  wsManager.connect().then(ok => {
    if (ok) log("info", "sse", "WebSocket connected for subscriptions");
    else log("info", "sse", "WebSocket unavailable, using polling");
  });

  app.listen(PORT, "0.0.0.0", () => {
    log("info", "sse", `SSE server listening on port ${PORT}`, { network: config.network });
    console.error(`[eto-mcp] SSE server started on :${PORT} (network=${config.network})`);
  });

  process.on("SIGINT", () => { dumpStats(); process.exit(0); });
  process.on("SIGTERM", () => { dumpStats(); process.exit(0); });
}

startSseServer().catch((err) => {
  console.error("[eto-mcp] Fatal SSE server error:", err);
  process.exit(1);
});
