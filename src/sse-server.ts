import express from "express";
import { readFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import { createServer } from "./server.js";
import { config } from "./config.js";
import { blockhashCache } from "./write/blockhash-cache.js";
import { wsManager } from "./read/ws-manager.js";
import { log, dumpStats } from "./utils/logger.js";
import { authRouter } from "./gateway/auth-routes.js";
import { runWithAuth } from "./gateway/auth.js";
import { sessionStore } from "./signing/session-context.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const LLMS_TXT = readFileSync(join(__dirname, "../public/llms.txt"), "utf8");

const PORT = parseInt(process.env.PORT || "8080", 10);

const app = express();

// CORS for cross-origin MCP clients
app.use((req, res, next) => {
  res.header("Access-Control-Allow-Origin", "*");
  res.header("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.header("Access-Control-Allow-Headers", "Content-Type, Authorization");
  if (req.method === "OPTIONS") {
    res.sendStatus(204);
    return;
  }
  next();
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

// Auth endpoints: /auth/login, /auth/verify, /auth/me. Mounted under /auth so
// the router's body-parser never intercepts /message, which must reach the
// MCP SDK with its raw stream intact.
app.use("/auth", authRouter);

// Track active transports for cleanup
const transports = new Map<string, SSEServerTransport>();

// SSE endpoint — client connects here to establish SSE stream
app.get("/sse", async (req, res) => {
  log("info", "sse", "New SSE connection", { ip: req.ip });

  const transport = new SSEServerTransport("/message", res);
  const sessionId = transport.sessionId;
  transports.set(sessionId, transport);

  // Clean up on disconnect
  res.on("close", () => {
    transports.delete(sessionId);
    log("info", "sse", "SSE connection closed", { sessionId });
  });

  const server = await createServer();
  await server.connect(transport);

  log("info", "sse", "MCP server connected via SSE", { sessionId });
});

// Message endpoint — client sends JSON-RPC messages here
// Note: SSEServerTransport.handlePostMessage reads the body itself via raw-body,
// so express.json() middleware is NOT used here.
//
// Auth flow: the bearer token (if any) is stashed in an AsyncLocalStorage via
// runWithAuth(). The MCP tool-handler wrapper in tools/index.ts reads that ALS,
// runs authenticate() + requireCapability() + rateLimiter.check(), and then
// calls runInScope(session.sub, ...) to land the handler in the right
// persistence bucket. We seed a placeholder scope ("__pending__") here so
// anything that peeks at currentScope() before the scope is resolved gets a
// clearly named fallback instead of __default__.
app.post("/message", async (req, res) => {
  const sessionId = req.query.sessionId as string;

  // Auth gate runs first: callers with no Bearer get 401, not 400, when auth
  // is enforced. This keeps unauthenticated probes from learning about session
  // state.
  const bearer = req.header("authorization")?.replace(/^Bearer\s+/i, "");
  if (!bearer && !config.auth.devBypass) {
    res.status(401).json({
      code: "AUTH_001",
      category: "auth",
      message: "Authentication required",
      explanation: "No Bearer token. Call POST /auth/login → sign → POST /auth/verify.",
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
