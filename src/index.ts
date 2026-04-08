import { startStdioServer } from "./server.js";

startStdioServer().catch((err) => {
  console.error("[eto-mcp] Fatal error:", err);
  process.exit(1);
});
