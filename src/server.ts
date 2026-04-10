import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { config } from "./config.js";
import { registerAllTools } from "./tools/index.js";
import { blockhashCache } from "./write/blockhash-cache.js";
import { wsManager } from "./read/ws-manager.js";
import { log, dumpStats } from "./utils/logger.js";

function validateProductionConfig(): void {
  if (process.env.NODE_ENV !== "production") return;

  const errors: string[] = [];

  if (!process.env.PASETO_SIGNING_KEY) {
    errors.push("PASETO_SIGNING_KEY must be set in production");
  }

  if (config.auth.devBypass) {
    errors.push("AUTH_DEV_BYPASS must not be enabled in production");
  }

  if (config.etoRpcUrl.includes("localhost") || config.etoRpcUrl.includes("127.0.0.1")) {
    errors.push("ETO_RPC_URL must not point to localhost in production");
  }

  if (errors.length > 0) {
    console.error("[eto-mcp] Production configuration errors:");
    errors.forEach(e => console.error(`  - ${e}`));
    process.exit(1);
  }
}

export async function createServer(): Promise<McpServer> {
  validateProductionConfig();

  const server = new McpServer({
    name: "eto-mcp",
    version: "1.0.0",
  });

  registerAllTools(server);

  return server;
}

export async function startStdioServer(): Promise<void> {
  validateProductionConfig();

  const server = await createServer();
  const transport = new StdioServerTransport();

  blockhashCache.startRefresh();

  wsManager.connect().then(ok => {
    if (ok) log("info", "server", "WebSocket connected for real-time subscriptions");
    else log("info", "server", "WebSocket unavailable, using polling fallback");
  });

  // Dump perf stats on exit
  process.on("SIGINT", () => { dumpStats(); process.exit(0); });
  process.on("SIGTERM", () => { dumpStats(); process.exit(0); });

  await server.connect(transport);

  log("info", "server", `Started on stdio`, { network: config.network, rpc: config.etoRpcUrl });
  console.error(`[eto-mcp] Server started (network=${config.network}, rpc=${config.etoRpcUrl}) — logs at /tmp/eto-mcp-logs/`);
}
