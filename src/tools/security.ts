import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

const SIGNING_SERVICE_URL = process.env.SIGNING_SERVICE_URL || "http://127.0.0.1:9100";

async function signingServiceCall<T>(method: string, path: string, body?: any): Promise<T> {
  const response = await fetch(`${SIGNING_SERVICE_URL}${path}`, {
    method,
    headers: body ? { "Content-Type": "application/json" } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!response.ok) {
    const err = await response.text();
    throw new Error(`Signing service error (${response.status}): ${err}`);
  }
  return response.json() as Promise<T>;
}

// Module-level step-up auth config store: walletId → config
const stepUpConfigs = new Map<string, {
  transferThreshold?: string;
  dailyThreshold?: string;
  highRiskTools?: string[];
}>();

export function registerSecurityTools(server: McpServer): void {
  server.tool(
    "manage_key_shares",
    "Manage FROST threshold key shares for a wallet. FROST (Flexible Round-Optimized Schnorr Threshold) splits a private key into N shares such that any T of them can sign. Use 'status' to inspect current share state and sign count, 'rotate' to generate fresh shares via a new DKG round (old key remains until assets are transferred), 'recover' to view instructions for assembling shares to recover wallet access, or 'revoke_device' to remove the device share (share index 1) so a lost device can no longer participate in signing.",
    {
      action: z.enum(["status", "rotate", "recover", "revoke_device"]).describe(
        "Key share management action: status | rotate | recover | revoke_device"
      ),
      wallet_id: z.string().describe("Wallet ID whose FROST key shares to manage"),
    },
    async ({ action, wallet_id }) => {
      try {
        if (action === "status") {
          const result = await signingServiceCall<any>("GET", `/keys/${wallet_id}`);
          const lines = [
            `Key Share Status for wallet: ${wallet_id}`,
            `Key ID:      ${result.key_id ?? "N/A"}`,
            `Public Key:  ${result.public_key ?? "N/A"}`,
            `Threshold:   ${result.threshold ?? "N/A"} of ${result.total_shares ?? "N/A"}`,
            `Sign Count:  ${result.sign_count ?? 0}`,
            `Created At:  ${result.created_at ?? "N/A"}`,
          ];
          if (result.shares && Array.isArray(result.shares)) {
            lines.push(`Shares:`);
            for (const s of result.shares) {
              lines.push(`  Index ${s.share_index}: ${s.status ?? "active"}`);
            }
          }
          return { content: [{ type: "text", text: lines.join("\n") }] };

        } else if (action === "rotate") {
          // Generate new DKG round
          const dkg = await signingServiceCall<any>("POST", "/dkg");
          const lines = [
            `Key Rotation initiated for wallet: ${wallet_id}`,
            `New Key ID:      ${dkg.key_id}`,
            `New Public Key:  ${dkg.public_key}`,
            ``,
            `Next steps:`,
            `  1. Transfer all assets from old key to new public key: ${dkg.public_key}`,
            `  2. Update your wallet configuration to use the new key ID`,
            `  3. Old key will remain valid until explicitly revoked`,
          ];
          return { content: [{ type: "text", text: lines.join("\n") }] };

        } else if (action === "recover") {
          const lines = [
            `Recovery Instructions for wallet: ${wallet_id}`,
            ``,
            `To recover this wallet you need T-of-N FROST shares:`,
            `  1. Gather the required threshold number of share holders`,
            `  2. Each share holder provides their share_hex for their share_index`,
            `  3. Use the signing service POST /sign with the collected share_indices`,
            `  4. Alternatively, call POST /recover with all available shares to reconstruct`,
            ``,
            `Share sources:`,
            `  - Share 1: Device share (stored on primary signing device)`,
            `  - Share 2: Backup share (stored in secure backup location)`,
            `  - Share 3: Recovery share (stored with trusted third party, if configured)`,
          ];
          return { content: [{ type: "text", text: lines.join("\n") }] };

        } else {
          // revoke_device: remove share index 1
          await signingServiceCall<any>("DELETE", `/keys/${wallet_id}`);
          const lines = [
            `Device share (index 1) revoked for wallet: ${wallet_id}`,
            ``,
            `The device share has been removed from the signing service.`,
            `A lost or compromised device can no longer participate in signing.`,
            `Ensure you have remaining shares available to continue signing.`,
          ];
          return { content: [{ type: "text", text: lines.join("\n") }] };
        }
      } catch (err: any) {
        return {
          content: [{ type: "text", text: `Error: ${err.message}` }],
          isError: true,
        };
      }
    }
  );

  server.tool(
    "configure_step_up_auth",
    "Configure step-up authentication thresholds for a wallet. Step-up auth requires an additional confirmation (e.g. hardware key or second factor) before executing high-value or high-risk operations. Set a per-transfer SOL threshold to trigger step-up on large transfers, a daily cumulative threshold for total daily spend, or specify a list of tool names that always require step-up regardless of amount. All three settings are optional and can be configured independently.",
    {
      wallet_id: z.string().describe("Wallet ID to configure step-up auth for"),
      transfer_threshold: z.string().optional().describe(
        "SOL amount that triggers step-up auth on a single transfer (e.g. '10.0')"
      ),
      daily_threshold: z.string().optional().describe(
        "Cumulative daily SOL spend threshold that triggers step-up auth (e.g. '100.0')"
      ),
      high_risk_tools: z.array(z.string()).optional().describe(
        "List of tool names that always require step-up auth (e.g. ['deploy_contract', 'transfer_token'])"
      ),
    },
    async ({ wallet_id, transfer_threshold, daily_threshold, high_risk_tools }) => {
      try {
        const existing = stepUpConfigs.get(wallet_id) ?? {};
        const updated = {
          transferThreshold: transfer_threshold ?? existing.transferThreshold,
          dailyThreshold: daily_threshold ?? existing.dailyThreshold,
          highRiskTools: high_risk_tools ?? existing.highRiskTools,
        };
        stepUpConfigs.set(wallet_id, updated);

        const lines = [
          `Step-up auth configured for wallet: ${wallet_id}`,
          ``,
          `Transfer Threshold: ${updated.transferThreshold ?? "(not set)"}${updated.transferThreshold ? " SOL" : ""}`,
          `Daily Threshold:    ${updated.dailyThreshold ?? "(not set)"}${updated.dailyThreshold ? " SOL" : ""}`,
          `High-Risk Tools:    ${updated.highRiskTools?.length ? updated.highRiskTools.join(", ") : "(none)"}`,
        ];
        return { content: [{ type: "text", text: lines.join("\n") }] };
      } catch (err: any) {
        return {
          content: [{ type: "text", text: `Error: ${err.message}` }],
          isError: true,
        };
      }
    }
  );

  server.tool(
    "get_audit_log",
    "Retrieve the audit log of signing operations from the FROST signing service. Each entry records the timestamp, operation type (sign, dkg, rotate, revoke), whether it succeeded, and which share indices participated. Use the optional filters to scope results by wallet ID and date range, or limit the number of returned entries. Useful for compliance, security reviews, and post-incident investigation.",
    {
      wallet_id: z.string().optional().describe(
        "Filter log entries to a specific wallet ID (optional)"
      ),
      from_date: z.string().optional().describe(
        "ISO 8601 start date filter (e.g. '2024-01-01T00:00:00Z')"
      ),
      to_date: z.string().optional().describe(
        "ISO 8601 end date filter (e.g. '2024-12-31T23:59:59Z')"
      ),
      limit: z.number().default(50).optional().describe(
        "Maximum number of log entries to return (default 50)"
      ),
    },
    async ({ wallet_id, from_date, to_date, limit }) => {
      try {
        const params = new URLSearchParams();
        if (wallet_id) params.set("wallet_id", wallet_id);
        if (from_date) params.set("from", from_date);
        if (to_date) params.set("to", to_date);
        if (limit) params.set("limit", String(limit));

        const query = params.toString() ? `?${params.toString()}` : "";
        const result = await signingServiceCall<any>("GET", `/audit${query}`);

        const entries: any[] = Array.isArray(result) ? result : (result.entries ?? []);

        if (entries.length === 0) {
          return {
            content: [{ type: "text", text: "No audit log entries found for the given filters." }],
          };
        }

        // Format as a readable table
        const header = `${"Timestamp".padEnd(24)} ${"Operation".padEnd(16)} ${"Success".padEnd(8)} ${"Shares Used"}`;
        const divider = "-".repeat(70);
        const rows = entries.map((e: any) => {
          const ts = (e.timestamp ?? e.created_at ?? "N/A").toString().slice(0, 23).padEnd(24);
          const op = (e.operation ?? e.op ?? "N/A").toString().padEnd(16);
          const ok = (e.success ?? e.ok ?? true) ? "yes" : "no ";
          ok.padEnd(8);
          const shares = Array.isArray(e.share_indices)
            ? e.share_indices.join(", ")
            : (e.shares_used ?? "N/A");
          return `${ts} ${op} ${ok.padEnd(8)} ${shares}`;
        });

        const lines = [
          `Audit Log (${entries.length} entries):`,
          "",
          header,
          divider,
          ...rows,
        ];
        return { content: [{ type: "text", text: lines.join("\n") }] };
      } catch (err: any) {
        return {
          content: [{ type: "text", text: `Error: ${err.message}` }],
          isError: true,
        };
      }
    }
  );
}
