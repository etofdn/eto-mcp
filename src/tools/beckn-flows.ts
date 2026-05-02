/**
 * FN-176 — Beckn flow MCP tools.
 *
 * Exposes the five Beckn v2.0 LTS actions (search / select / init /
 * confirm / rate) as MCP tools so any MCP-aware agent can drive a Beckn
 * flow through this server. Auth + rate-limiting come from the
 * `TOOL_CAPS` entries added in `src/tools/index.ts`.
 *
 * Handlers proxy the user's request through the Beckn gateway at
 * `BECKN_GATEWAY_URL` (default `http://127.0.0.1:4071`). The gateway
 * itself owns schema validation, signature verification, and on-chain
 * submission.
 */
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

const BECKN_GATEWAY_URL =
  process.env.BECKN_GATEWAY_URL ?? "http://127.0.0.1:4071";

async function postBeckn(path: string, body: unknown): Promise<unknown> {
  const res = await fetch(`${BECKN_GATEWAY_URL}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return await res.json();
}

function asContent(payload: unknown) {
  return {
    content: [
      {
        type: "text" as const,
        text: JSON.stringify(payload, null, 2),
      },
    ],
  };
}

const PUBKEY_SCHEMA = z.string().regex(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/, "base58 pubkey, 32-44 chars");
const HEX32_SCHEMA = z.string().regex(/^[0-9a-fA-F]{64}$/, "hex-encoded 32 bytes");

export function registerBecknFlowTools(server: McpServer): void {
  server.tool(
    "beckn_search",
    "Beckn v2.0 LTS search action. Discovers BPP providers offering a category of work. Returns a transactionId stable across the rest of the search → select → init → confirm → rate flow plus a list of providers and their quoted items.",
    {
      descriptor: z.string().describe("Free-form search descriptor (e.g. 'audit my Solidity contract')"),
      category: z.string().optional().describe("Optional Beckn category filter (e.g. 'eto:agents:audit')"),
      domain: z.string().default("eto:agents").optional().describe("Beckn domain tag"),
    },
    async ({ descriptor, category, domain }) => {
      const result = await postBeckn("/beckn/search", { intent: { descriptor, category }, domain });
      return asContent(result);
    },
  );

  server.tool(
    "beckn_select",
    "Beckn select action. Narrows a search context to a specific provider + item. Requires the transactionId returned by beckn_search.",
    {
      transaction_id: z.string().describe("transactionId from beckn_search"),
      provider_pubkey: PUBKEY_SCHEMA.describe("Provider pubkey (base58)"),
      item_id: z.string().describe("Item id selected from the provider's catalog"),
    },
    async ({ transaction_id, provider_pubkey, item_id }) => {
      const result = await postBeckn("/beckn/select", {
        context: { transactionId: transaction_id },
        providerPubkey: provider_pubkey,
        itemId: item_id,
      });
      return asContent(result);
    },
  );

  server.tool(
    "beckn_init",
    "Beckn init action. Proposes terms (lock-step before confirm). Carries termsHash (32-byte hex) so the BPP echoes the same hash back on init ack — required for the confirm step.",
    {
      transaction_id: z.string().describe("transactionId from beckn_search"),
      provider_pubkey: PUBKEY_SCHEMA.describe("Provider pubkey"),
      funder_pubkey: PUBKEY_SCHEMA.describe("Funder pubkey that will lock escrow"),
      terms_hash: HEX32_SCHEMA.describe("64-char hex digest of canonical terms"),
    },
    async ({ transaction_id, provider_pubkey, funder_pubkey, terms_hash }) => {
      const result = await postBeckn("/beckn/init", {
        context: { transactionId: transaction_id },
        providerPubkey: provider_pubkey,
        funderPubkey: funder_pubkey,
        termsHash: terms_hash,
      });
      return asContent(result);
    },
  );

  server.tool(
    "beckn_confirm",
    "Beckn confirm action. Commits terms + locks escrow. termsHash must match the one returned by init; funderSignature is hex-encoded.",
    {
      transaction_id: z.string().describe("transactionId from beckn_search"),
      terms_hash: HEX32_SCHEMA.describe("Echoed termsHash from init ack"),
      funder_signature: z.string().min(1).describe("Hex-encoded funder signature over the canonical terms"),
    },
    async ({ transaction_id, terms_hash, funder_signature }) => {
      const result = await postBeckn("/beckn/confirm", {
        context: { transactionId: transaction_id },
        termsHash: terms_hash,
        funderSignature: funder_signature,
      });
      return asContent(result);
    },
  );

  server.tool(
    "beckn_rate",
    "Beckn rate action. Posts post-fulfillment rating + comment. Rating is in [0, 5] with half-step granularity.",
    {
      transaction_id: z.string().describe("transactionId from beckn_search"),
      rating: z.number().min(0).max(5).describe("Rating in [0, 5]"),
      comment: z.string().max(280).optional().describe("Optional comment, ≤ 280 chars"),
    },
    async ({ transaction_id, rating, comment }) => {
      const result = await postBeckn("/beckn/rate", {
        context: { transactionId: transaction_id },
        rating,
        ...(comment !== undefined ? { comment } : {}),
      });
      return asContent(result);
    },
  );
}
