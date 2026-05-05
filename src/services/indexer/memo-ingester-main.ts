/**
 * FN-105: Entrypoint for MemoBlockIngester service.
 *
 * Run via: node dist/services/indexer/memo-ingester-main.js
 *       or: tsx src/services/indexer/memo-ingester-main.ts
 *
 * Mirrors src/bridge-server.ts lifecycle pattern.
 * Set ETO_MEMO_INGESTER_ENABLED=true to activate.
 */

import { createMemoBlockIngesterFromEnv } from "./memo-ingester.js";

if (process.env["ETO_MEMO_INGESTER_ENABLED"] !== "true") {
  console.error(
    "[memo-ingester] disabled (set ETO_MEMO_INGESTER_ENABLED=true to enable)",
  );
  process.exit(0);
}

const ingester = createMemoBlockIngesterFromEnv();
await ingester.start();
console.log("[memo-ingester] started");

let stopping = false;
async function shutdown(sig: string): Promise<void> {
  if (stopping) return;
  stopping = true;
  console.log(`[memo-ingester] received ${sig}; stopping`);
  await ingester.stop().catch((e) => console.error("[memo-ingester] stop error", e));
  process.exit(0);
}

process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));
