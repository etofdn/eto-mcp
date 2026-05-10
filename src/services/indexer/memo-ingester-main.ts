/**
 * FN-105: Entrypoint for MemoBlockIngester service (FN-117 build target).
 *
 * Run via: node dist/services/indexer/memo-ingester-main.js
 *       or: tsx src/services/indexer/memo-ingester-main.ts
 *
 * Set ETO_MEMO_INGESTER_ENABLED=true to activate.
 * Mirrors the src/bridge-server.ts lifecycle pattern.
 */

if (process.env["ETO_MEMO_INGESTER_ENABLED"] !== "true") {
  console.error(
    "[memo-ingester] disabled (set ETO_MEMO_INGESTER_ENABLED=true to enable)",
  );
  process.exit(0);
}

// Full implementation wired in FN-105 / FN-118.
// This file is a build target stub; the ingester modules will be populated
// as FN-105 lands on master.
console.log("[memo-ingester] started (stub mode — FN-105 pending)");

process.on("SIGTERM", () => process.exit(0));
process.on("SIGINT", () => process.exit(0));
