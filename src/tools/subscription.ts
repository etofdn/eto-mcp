import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { rpc } from "../read/rpc-client.js";
import { wsManager } from "../read/ws-manager.js";

// ---------------------------------------------------------------------------
// In-memory subscription store
// ---------------------------------------------------------------------------

interface Subscription {
  type: string;
  filter: any;
  intervalId: ReturnType<typeof setInterval> | null;
  notifications: any[];
  wsId: string | null;
}

const subscriptions = new Map<string, Subscription>();

export function registerSubscriptionTools(server: McpServer): void {
  server.tool(
    "subscribe_account",
    "Creates a polling subscription that monitors an on-chain account for state changes. Every 2 seconds the account is fetched and compared against its previous state; any detected changes (balance, data, owner) are buffered as notifications. Returns a subscription_id that can be used with unsubscribe to stop monitoring. Use the events parameter to narrow which change types trigger notifications — defaults to 'any' for all changes.",
    {
      address: z.string().describe("Account address (base58 SVM or 0x EVM) to monitor"),
      events: z.array(z.enum(["balance_change", "data_change", "owner_change", "any"]))
        .default(["any"]).optional()
        .describe("Change types to monitor: balance_change, data_change, owner_change, or any"),
    },
    async ({ address, events }) => {
      try {
        const subscriptionId = crypto.randomUUID();
        const useWs = wsManager.isConnected();

        let intervalId: ReturnType<typeof setInterval> | null = null;
        let wsId: string | null = null;

        if (useWs) {
          wsId = wsManager.subscribe("account", { address }, (notification) => {
            const sub = subscriptions.get(subscriptionId);
            if (!sub) return;
            sub.notifications.push(notification);
            if (sub.notifications.length > 100) {
              sub.notifications.splice(0, sub.notifications.length - 100);
            }
          });
        } else {
          let lastState: any = null;
          intervalId = setInterval(async () => {
            try {
              const account = await rpc.getAccountInfo(address);
              const current = {
                lamports: account?.lamports,
                data: account?.data,
                owner: account?.owner,
              };

              if (lastState === null) {
                lastState = current;
                return;
              }

              const sub = subscriptions.get(subscriptionId);
              if (!sub) return;

              const watchAll = !events || events.includes("any");

              if ((watchAll || events!.includes("balance_change")) && current.lamports !== lastState.lamports) {
                sub.notifications.push({
                  type: "balance_change",
                  address,
                  previous: lastState.lamports,
                  current: current.lamports,
                  timestamp: Date.now(),
                });
              }

              if ((watchAll || events!.includes("data_change")) && current.data !== lastState.data) {
                sub.notifications.push({
                  type: "data_change",
                  address,
                  timestamp: Date.now(),
                });
              }

              if ((watchAll || events!.includes("owner_change")) && current.owner !== lastState.owner) {
                sub.notifications.push({
                  type: "owner_change",
                  address,
                  previous: lastState.owner,
                  current: current.owner,
                  timestamp: Date.now(),
                });
              }

              // Cap buffer at 100 notifications
              if (sub.notifications.length > 100) {
                sub.notifications.splice(0, sub.notifications.length - 100);
              }

              lastState = current;
            } catch {
              // ignore polling errors
            }
          }, 2000);
        }

        subscriptions.set(subscriptionId, {
          type: "account",
          filter: { address, events },
          intervalId,
          wsId,
          notifications: [],
        });

        const transport = useWs
          ? "Connected via WebSocket"
          : "Using polling fallback (2s interval)";

        const lines = [
          "Account subscription created.",
          `Subscription ID: ${subscriptionId}`,
          `Address:         ${address}`,
          `Events:          ${(events ?? ["any"]).join(", ")}`,
          `Transport:       ${transport}`,
          "",
          "Use unsubscribe to stop monitoring.",
        ];
        return { content: [{ type: "text" as const, text: lines.join("\n") }] };
      } catch (err: any) {
        return {
          content: [{ type: "text" as const, text: `Error: ${err?.message ?? String(err)}` }],
          isError: true,
        };
      }
    }
  );

  server.tool(
    "subscribe_logs",
    "Creates a polling subscription that monitors the ETO network for transaction logs matching specified filters. Logs can be filtered by account address (to capture logs emitted by a specific program or account), topic strings, and VM type (svm, evm, wasm, or all). New matching log entries are buffered as notifications accessible until unsubscribed. Returns a subscription_id.",
    {
      filter: z.object({
        address: z.string().optional().describe("Program or account address whose logs to monitor"),
        topics: z.array(z.string()).optional().describe("Log message substrings to match"),
        vm: z.enum(["all", "svm", "evm", "wasm"]).default("all").optional()
          .describe("VM type to filter logs by: all, svm, evm, or wasm"),
      }).describe("Log filter specification"),
    },
    async ({ filter }) => {
      try {
        const subscriptionId = crypto.randomUUID();
        const useWs = wsManager.isConnected();

        let intervalId: ReturnType<typeof setInterval> | null = null;
        let wsId: string | null = null;

        if (useWs) {
          wsId = wsManager.subscribe("logs", filter, (notification) => {
            const sub = subscriptions.get(subscriptionId);
            if (!sub) return;
            sub.notifications.push(notification);
            if (sub.notifications.length > 100) {
              sub.notifications.splice(0, sub.notifications.length - 100);
            }
          });
        } else {
          let lastBlockHeight: number | null = null;
          intervalId = setInterval(async () => {
            try {
              const sub = subscriptions.get(subscriptionId);
              if (!sub) return;

              const currentHeight = await rpc.getBlockHeight();
              if (lastBlockHeight === null) {
                lastBlockHeight = currentHeight;
                return;
              }

              if (currentHeight <= lastBlockHeight) return;

              // Scan new blocks for matching logs
              for (let h = lastBlockHeight + 1; h <= currentHeight; h++) {
                try {
                  const block = await rpc.etoGetBlock(h);
                  if (!block?.transactions) continue;

                  for (const tx of block.transactions) {
                    const txLogs: string[] = tx.meta?.logMessages ?? tx.logs ?? [];
                    const txVm: string = tx.vm ?? tx.vmType ?? "svm";

                    // VM filter
                    if (filter.vm && filter.vm !== "all" && txVm !== filter.vm) continue;

                    // Address filter
                    if (filter.address) {
                      const accounts: string[] = tx.message?.accountKeys ?? tx.accounts ?? [];
                      if (!accounts.includes(filter.address)) continue;
                    }

                    // Topic filter
                    const matchingLogs = filter.topics && filter.topics.length > 0
                      ? txLogs.filter((l) => filter.topics!.some((t) => l.includes(t)))
                      : txLogs;

                    if (matchingLogs.length > 0) {
                      sub.notifications.push({
                        type: "log",
                        blockHeight: h,
                        txHash: tx.signature ?? tx.hash ?? "N/A",
                        vm: txVm,
                        logs: matchingLogs,
                        timestamp: Date.now(),
                      });
                    }
                  }
                } catch {
                  // skip inaccessible blocks
                }
              }

              // Cap buffer
              if (sub.notifications.length > 100) {
                sub.notifications.splice(0, sub.notifications.length - 100);
              }

              lastBlockHeight = currentHeight;
            } catch {
              // ignore polling errors
            }
          }, 2000);
        }

        subscriptions.set(subscriptionId, {
          type: "logs",
          filter,
          intervalId,
          wsId,
          notifications: [],
        });

        const transport = useWs
          ? "Connected via WebSocket"
          : "Using polling fallback (2s interval)";

        const lines = [
          "Log subscription created.",
          `Subscription ID: ${subscriptionId}`,
          `VM:              ${filter.vm ?? "all"}`,
          `Transport:       ${transport}`,
        ];
        if (filter.address) lines.push(`Address filter:  ${filter.address}`);
        if (filter.topics?.length) lines.push(`Topic filters:   ${filter.topics.join(", ")}`);
        lines.push("", "Use unsubscribe to stop monitoring.");
        return { content: [{ type: "text" as const, text: lines.join("\n") }] };
      } catch (err: any) {
        return {
          content: [{ type: "text" as const, text: `Error: ${err?.message ?? String(err)}` }],
          isError: true,
        };
      }
    }
  );

  server.tool(
    "subscribe_blocks",
    "Creates a polling subscription that fires a notification each time a new block is produced on the ETO chain. Block height is polled every 2 seconds. When include_transactions is true, the notification payload includes the full transaction list for each new block. Useful for building block explorers, confirmaton trackers, or event pipelines that need to react to every new block.",
    {
      include_transactions: z.boolean().default(false).optional()
        .describe("Whether to include full transaction list in block notifications (default: false)"),
    },
    async ({ include_transactions }) => {
      try {
        const subscriptionId = crypto.randomUUID();
        const useWs = wsManager.isConnected();

        let intervalId: ReturnType<typeof setInterval> | null = null;
        let wsId: string | null = null;

        if (useWs) {
          wsId = wsManager.subscribe("blocks", { include_transactions }, (notification) => {
            const sub = subscriptions.get(subscriptionId);
            if (!sub) return;
            sub.notifications.push(notification);
            if (sub.notifications.length > 100) {
              sub.notifications.splice(0, sub.notifications.length - 100);
            }
          });
        } else {
          let lastBlockHeight: number | null = null;
          intervalId = setInterval(async () => {
            try {
              const sub = subscriptions.get(subscriptionId);
              if (!sub) return;

              const currentHeight = await rpc.getBlockHeight();
              if (lastBlockHeight === null) {
                lastBlockHeight = currentHeight;
                return;
              }

              if (currentHeight <= lastBlockHeight) return;

              for (let h = lastBlockHeight + 1; h <= currentHeight; h++) {
                try {
                  const notification: any = {
                    type: "new_block",
                    blockHeight: h,
                    timestamp: Date.now(),
                  };

                  if (include_transactions) {
                    const block = await rpc.etoGetBlock(h);
                    if (block) {
                      notification.hash = block.hash ?? block.blockhash;
                      notification.txCount = block.transactions?.length ?? 0;
                      notification.transactions = block.transactions?.map(
                        (tx: any) => tx.signature ?? tx.hash ?? tx
                      ) ?? [];
                    }
                  }

                  sub.notifications.push(notification);
                } catch {
                  // skip inaccessible blocks
                }
              }

              // Cap buffer
              if (sub.notifications.length > 100) {
                sub.notifications.splice(0, sub.notifications.length - 100);
              }

              lastBlockHeight = currentHeight;
            } catch {
              // ignore polling errors
            }
          }, 2000);
        }

        subscriptions.set(subscriptionId, {
          type: "blocks",
          filter: { include_transactions },
          intervalId,
          wsId,
          notifications: [],
        });

        const transport = useWs
          ? "Connected via WebSocket"
          : "Using polling fallback (2s interval)";

        const lines = [
          "Block subscription created.",
          `Subscription ID:      ${subscriptionId}`,
          `Include transactions: ${include_transactions ?? false}`,
          `Transport:            ${transport}`,
          "",
          "Use unsubscribe to stop monitoring.",
        ];
        return { content: [{ type: "text" as const, text: lines.join("\n") }] };
      } catch (err: any) {
        return {
          content: [{ type: "text" as const, text: `Error: ${err?.message ?? String(err)}` }],
          isError: true,
        };
      }
    }
  );

  server.tool(
    "unsubscribe",
    "Cancels an active subscription and returns any buffered notifications that were collected before cancellation. Clears the polling interval and removes the subscription from the in-memory store. Always call unsubscribe when a subscription is no longer needed to avoid accumulating background polling timers. The returned notifications include all events captured since the last check.",
    {
      subscription_id: z.string().describe("Subscription ID returned by subscribe_account, subscribe_logs, or subscribe_blocks"),
    },
    async ({ subscription_id }) => {
      try {
        const sub = subscriptions.get(subscription_id);
        if (!sub) {
          return {
            content: [{ type: "text" as const, text: `Subscription not found: ${subscription_id}` }],
          };
        }

        if (sub.intervalId !== null) clearInterval(sub.intervalId);
        if (sub.wsId !== null) wsManager.unsubscribe(sub.wsId);
        subscriptions.delete(subscription_id);

        const buffered = sub.notifications;
        const lines = [
          `Subscription ${subscription_id} cancelled.`,
          `Type:                  ${sub.type}`,
          `Buffered notifications: ${buffered.length}`,
        ];

        if (buffered.length > 0) {
          lines.push("", "Buffered notifications:");
          for (const n of buffered) {
            lines.push(`  ${JSON.stringify(n)}`);
          }
        }

        return { content: [{ type: "text" as const, text: lines.join("\n") }] };
      } catch (err: any) {
        return {
          content: [{ type: "text" as const, text: `Error: ${err?.message ?? String(err)}` }],
          isError: true,
        };
      }
    }
  );
}
