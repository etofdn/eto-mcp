/**
 * Beckn HTTP bridge server — deploy entrypoint for FN-093.
 *
 * Boots the self-contained Express app built by `createBecknApp()` on
 * PORT (default 9000). This module owns the `app.listen()` call that
 * `src/gateway/beckn.ts` intentionally omits to stay side-effect-free.
 *
 * Environment variables:
 *   PORT        — TCP port to listen on (default: 9000)
 *   NODE_ENV    — "production" silences dev-only warnings
 */
import { createBecknApp } from "./gateway/beckn.js";

const PORT = parseInt(process.env.PORT ?? "9000", 10);

const app = createBecknApp();

const server = app.listen(PORT, "0.0.0.0", () => {
  console.log(`[beckn-bridge] listening on :${PORT}`);
});

function shutdown(): void {
  console.log("[beckn-bridge] shutting down");
  server.close(() => process.exit(0));
}

process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
