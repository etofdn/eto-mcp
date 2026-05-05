import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { localSignerFactory } from "../signing/local-signer.js";
import { currentScope } from "../signing/session-context.js";
import { getActiveWalletId } from "./wallet.js";
import { authenticate } from "../gateway/auth.js";
import { mintSessionAttestation } from "../gateway/session-attestation.js";
import { getServerInstance } from "../signing/server-key.js";

// FN-048: `last_restart_iso` is sourced from the canonical owner in
// `src/signing/server-key.ts` so the JWKS module's `kid` derivation and the
// `session_info` field always agree on the same value.

export function registerSessionTools(server: McpServer): void {
  server.tool(
    "session_info",
    "Returns a snapshot of the current MCP session: the caller's scope (thirdweb sub / __stdio__ / __dev__), their persisted wallets with derived SVM+EVM addresses, the active wallet id, the declared auth strategy on the session token, and the server's last restart timestamp. Pass declared_model to mint a session attestation JWS tying your declared model identity to this session. Useful for agents that want to confirm they landed on the same wallet set after an SSE reconnect.",
    {
      declared_model: z.object({
        provider: z.string().describe("AI provider name (e.g. 'anthropic')"),
        model_id: z.string().describe("Model identifier (e.g. 'claude-sonnet-4-5')"),
      }).optional().describe("Caller-declared model identity. When provided, mints a session attestation JWS. Absent in stdio/dev sessions."),
    },
    async (args) => {
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
        let tokenExpiresAt: string | null = null;
        let tokenExpiresInSeconds: number | null = null;
        let sessionAttestationJws: string | null = null;

        try {
          const authCtx = authenticate();
          authStrategy = authCtx.session.auth_strategy;
          if (authCtx.session.exp) {
            const now = Math.floor(Date.now() / 1000);
            tokenExpiresAt = new Date(authCtx.session.exp * 1000).toISOString();
            tokenExpiresInSeconds = Math.max(0, authCtx.session.exp - now);
          }
          // FN-050: if declared_model is supplied and we have a valid session,
          // mint a fresh attestation JWS that includes the model claim.
          if (args.declared_model && authCtx.session_attestation_jws !== null) {
            try {
              sessionAttestationJws = mintSessionAttestation({
                sub: authCtx.session.sub,
                jti: authCtx.session.jti,
                exp: authCtx.session.exp,
                model_id_declared: args.declared_model.model_id,
                provider_declared: args.declared_model.provider,
              });
            } catch {
              // Fall back to the base JWS minted at auth time.
              sessionAttestationJws = authCtx.session_attestation_jws;
            }
          } else {
            // No declared_model — surface the attestation minted at auth time (may be null).
            sessionAttestationJws = authCtx.session_attestation_jws;
          }
        } catch {
          // No session (unauth or error) — leave undefined/null
        }

        const payload = {
          wallets,
          active_wallet_id: getActiveWalletId(),
          scope,
          auth_strategy: authStrategy ?? null,
          token_expires_at: tokenExpiresAt,
          token_expires_in_seconds: tokenExpiresInSeconds,
          last_restart_iso: getServerInstance(),
          // FN-050: null in stdio / dev / when no declared_model and no real auth.
          model_attestation_jws: sessionAttestationJws,
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
