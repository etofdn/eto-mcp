import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { localSignerFactory } from "../signing/local-signer.js";
import { currentScope } from "../signing/session-context.js";
import { getActiveWalletId } from "./wallet.js";
import { authenticate } from "../gateway/auth.js";

const STARTED_AT = new Date().toISOString();

export function registerSessionTools(server: McpServer): void {
  server.tool(
    "session_info",
    "Returns a snapshot of the current MCP session: the caller's scope (thirdweb sub / __stdio__ / __dev__), their persisted wallets with derived SVM+EVM addresses, the active wallet id, the declared auth strategy on the session token, and the server's last restart timestamp. Useful for agents that want to confirm they landed on the same wallet set after an SSE reconnect.",
    {},
    async () => {
      try {
        const scope = currentScope();
        const walletIds = await localSignerFactory.listWallets();
        const wallets = await Promise.all(
          walletIds.map(async (id) => {
            const entry = localSignerFactory.getWalletEntry(scope, id);
            try {
              const signer = await localSignerFactory.getSigner(id);
              return {
                id,
                label: entry?.label ?? null,
                svm: signer.getPublicKey(),
                evm: signer.getEvmAddress(),
              };
            } catch {
              return { id, label: entry?.label ?? null, svm: null, evm: null };
            }
          }),
        );

        let authStrategy: string | undefined;
        try {
          const { session } = authenticate();
          authStrategy = session.auth_strategy;
        } catch {
          // No session (unauth or error) — leave undefined
        }

        const payload = {
          wallets,
          active_wallet_id: getActiveWalletId(),
          scope,
          auth_strategy: authStrategy ?? null,
          last_restart_iso: STARTED_AT,
        };

        return { content: [{ type: "text" as const, text: JSON.stringify(payload, null, 2) }] };
      } catch (err: any) {
        return {
          content: [{ type: "text" as const, text: `Error in session_info: ${err?.message ?? String(err)}` }],
          isError: true,
        };
      }
    },
  );
}
