// stdio transport runs locally and cannot present a Bearer token; force
// dev-bypass on before anything else imports config.ts. Must be the very
// first line — config.ts reads process.env at module eval time.
process.env.AUTH_DEV_BYPASS ??= "true";

import { startStdioServer } from "./server.js";
import { runInScope } from "./signing/session-context.js";

runInScope("__stdio__", () =>
  startStdioServer().catch((err) => {
    console.error("[eto-mcp] Fatal error:", err);
    process.exit(1);
  }),
);
