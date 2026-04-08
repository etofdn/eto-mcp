import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

// ---------------------------------------------------------------------------
// In-memory policy stores
// ---------------------------------------------------------------------------

interface SpendingLimit {
  limit: bigint;
  period: string;
  used: bigint;
  windowStart: number;
}

interface ToolPermission {
  mode: "allowlist" | "denylist";
  tools: string[];
}

const spendingLimits = new Map<string, SpendingLimit>();
const toolPermissions = new Map<string, ToolPermission>();
const addressWhitelists = new Map<string, string[]>();

function scopeKey(scope: string, scopeId?: string): string {
  return scopeId ? `${scope}:${scopeId}` : scope;
}

export function registerPolicyTools(server: McpServer): void {
  server.tool(
    "set_spending_limit",
    "Configures a spending limit policy for a session, agent, or wallet scope. Limits constrain how many lamports can be spent within a given time window (per_transaction, hourly, daily, weekly, monthly, or a total cap). When a limit is exceeded, write operations that exceed the remaining budget are rejected before submission. Limits are stored in-memory for this MCP server session and reset on restart.",
    {
      scope: z.enum(["session", "agent", "wallet"])
        .describe("The scope this limit applies to: session (current MCP session), agent (specific agent), or wallet (specific wallet)"),
      scope_id: z.string().optional()
        .describe("ID of the specific agent or wallet when scope is 'agent' or 'wallet'; omit for session scope"),
      limit: z.string()
        .describe("Maximum lamports that may be spent within the period (e.g. '1000000000' for 1 SOL)"),
      period: z.enum(["per_transaction", "hourly", "daily", "weekly", "monthly", "total"])
        .default("daily").optional()
        .describe("Time window for the spending limit (default: daily)"),
    },
    async ({ scope, scope_id, limit, period }) => {
      try {
        const key = scopeKey(scope, scope_id);
        const limitBigint = BigInt(limit);

        spendingLimits.set(key, {
          limit: limitBigint,
          period: period ?? "daily",
          used: 0n,
          windowStart: Date.now(),
        });

        const lamportsPerSol = 1_000_000_000n;
        const solAmount = Number(limitBigint) / Number(lamportsPerSol);

        const lines = [
          "Spending limit set.",
          `Scope:    ${scope}${scope_id ? ` (${scope_id})` : ""}`,
          `Limit:    ${limit} lamports (~${solAmount.toFixed(4)} SOL)`,
          `Period:   ${period ?? "daily"}`,
          `Key:      ${key}`,
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
    "set_tool_permissions",
    "Configures tool permission policy for a session or agent scope using an allowlist or denylist. In allowlist mode, only the listed tools may be called within the scope; all others are blocked. In denylist mode, the listed tools are explicitly forbidden and everything else is allowed. This provides fine-grained access control for automated agents operating within a session.",
    {
      scope: z.enum(["session", "agent"])
        .describe("The scope this permission policy applies to: session or agent"),
      scope_id: z.string().optional()
        .describe("ID of the specific agent when scope is 'agent'; omit for session-wide policy"),
      mode: z.enum(["allowlist", "denylist"])
        .describe("Permission mode: allowlist (only listed tools allowed) or denylist (listed tools blocked)"),
      tools: z.array(z.string())
        .describe("List of tool names for the allowlist or denylist"),
    },
    async ({ scope, scope_id, mode, tools }) => {
      try {
        const key = scopeKey(scope, scope_id);

        toolPermissions.set(key, { mode, tools });

        const lines = [
          "Tool permissions set.",
          `Scope:  ${scope}${scope_id ? ` (${scope_id})` : ""}`,
          `Mode:   ${mode}`,
          `Tools:  ${tools.join(", ")}`,
          `Key:    ${key}`,
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
    "set_address_whitelist",
    "Configures an address whitelist for a session, agent, or wallet scope. When an address whitelist is active, outgoing transfers and contract calls are only allowed to addresses in the list — attempts to send to unlisted addresses are rejected before submission. Pass an empty array to clear the whitelist and allow all addresses. Addresses can be SVM (base58) or EVM (0x-prefixed) format.",
    {
      scope: z.enum(["session", "agent", "wallet"])
        .describe("The scope this whitelist applies to"),
      scope_id: z.string().optional()
        .describe("ID of the specific agent or wallet when scope is 'agent' or 'wallet'"),
      addresses: z.array(z.string())
        .describe("List of allowed addresses (base58 SVM or 0x EVM). Pass empty array to clear."),
    },
    async ({ scope, scope_id, addresses }) => {
      try {
        const key = scopeKey(scope, scope_id);

        if (addresses.length === 0) {
          addressWhitelists.delete(key);
          return {
            content: [{ type: "text" as const, text: `Address whitelist cleared for scope: ${scope}${scope_id ? ` (${scope_id})` : ""}` }],
          };
        }

        addressWhitelists.set(key, addresses);

        const lines = [
          "Address whitelist set.",
          `Scope:     ${scope}${scope_id ? ` (${scope_id})` : ""}`,
          `Addresses: ${addresses.length} entries`,
          `Key:       ${key}`,
          "",
          ...addresses.map((a, i) => `  [${i + 1}] ${a}`),
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
    "get_policy",
    "Returns the current policy configuration for a given scope, including spending limits, tool permissions, and address whitelists. For spending limits, also shows how much of the current budget period has been consumed. Useful for auditing what constraints are active for a session, agent, or wallet before executing a batch of operations.",
    {
      scope: z.enum(["session", "agent", "wallet"])
        .describe("The scope to retrieve policy for"),
      scope_id: z.string().optional()
        .describe("ID of the specific agent or wallet; omit for session scope"),
    },
    async ({ scope, scope_id }) => {
      try {
        const key = scopeKey(scope, scope_id);
        const lines = [
          `Policy for scope: ${scope}${scope_id ? ` (${scope_id})` : ""}`,
          `Key: ${key}`,
          "",
        ];

        // Spending limit
        const spending = spendingLimits.get(key);
        if (spending) {
          const lamportsPerSol = 1_000_000_000n;
          const limitSol = Number(spending.limit) / Number(lamportsPerSol);
          const usedSol = Number(spending.used) / Number(lamportsPerSol);
          const remaining = spending.limit - spending.used;
          const remainingSol = Number(remaining) / Number(lamportsPerSol);

          const windowAgeMs = Date.now() - spending.windowStart;
          const windowAgeSec = Math.floor(windowAgeMs / 1000);

          lines.push("Spending Limit:");
          lines.push(`  Limit:       ${spending.limit} lamports (~${limitSol.toFixed(4)} SOL)`);
          lines.push(`  Period:      ${spending.period}`);
          lines.push(`  Used:        ${spending.used} lamports (~${usedSol.toFixed(4)} SOL)`);
          lines.push(`  Remaining:   ${remaining} lamports (~${remainingSol.toFixed(4)} SOL)`);
          lines.push(`  Window age:  ${windowAgeSec}s`);
        } else {
          lines.push("Spending Limit: none");
        }

        lines.push("");

        // Tool permissions
        const perms = toolPermissions.get(key);
        if (perms) {
          lines.push("Tool Permissions:");
          lines.push(`  Mode:  ${perms.mode}`);
          lines.push(`  Tools: ${perms.tools.join(", ")}`);
        } else {
          lines.push("Tool Permissions: none (all tools allowed)");
        }

        lines.push("");

        // Address whitelist
        const whitelist = addressWhitelists.get(key);
        if (whitelist && whitelist.length > 0) {
          lines.push(`Address Whitelist: ${whitelist.length} entries`);
          for (const addr of whitelist) {
            lines.push(`  ${addr}`);
          }
        } else {
          lines.push("Address Whitelist: none (all addresses allowed)");
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
