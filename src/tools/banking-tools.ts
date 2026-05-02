/**
 * FN-178 — Banking flow MCP tools.
 *
 * Exposes bank-as-BPP operations (open-checking / onramp / offramp /
 * wire / transfer-funds) as MCP tools. Handlers proxy through the bank
 * BPP service at `BANK_BPP_URL` (default `http://127.0.0.1:4073`).
 *
 * Each tool emits an idempotency-key per call so retries can't
 * double-charge. Auth + rate-limiting come from the `TOOL_CAPS`
 * entries added in `src/tools/index.ts`.
 */
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

const BANK_BPP_URL = process.env.BANK_BPP_URL ?? "http://127.0.0.1:4073";

async function postBank(path: string, body: unknown, idempotencyKey: string): Promise<unknown> {
  const res = await fetch(`${BANK_BPP_URL}${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "idempotency-key": idempotencyKey,
    },
    body: JSON.stringify(body),
  });
  return await res.json();
}

function newIdempotencyKey(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
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

const PUBKEY_SCHEMA = z
  .string()
  .regex(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/, "base58 pubkey, 32-44 chars");
const CENTS_SCHEMA = z
  .number()
  .int()
  .positive()
  .max(100_000_000, "amount exceeds the per-call $1M cap");

export function registerBankingTools(server: McpServer): void {
  server.tool(
    "bank_open_checking",
    "Open an eUSD checking account, gated by a KYC credential. Returns the on-chain account id, an `account.checking.v1` credential, and the commit timestamp.",
    {
      owner_pubkey: PUBKEY_SCHEMA.describe("Owner AgentCard pubkey"),
      kyc_credential_id: z.string().describe("KYC credential id to gate on"),
      label: z.string().max(64).optional().describe("Display label for the account"),
    },
    async ({ owner_pubkey, kyc_credential_id, label }) => {
      const result = await postBank(
        "/banking/open-checking",
        {
          ownerPubkey: owner_pubkey,
          kycCredentialId: kyc_credential_id,
          ...(label !== undefined ? { label } : {}),
        },
        newIdempotencyKey("open-checking"),
      );
      return asContent(result);
    },
  );

  server.tool(
    "bank_onramp",
    "USD → eUSD onramp with the 1pip fee. grossCents is integer cents. Returns minted netCents (server is source of truth).",
    {
      source_account_id: z.string().describe("Source bank account id"),
      gross_cents: CENTS_SCHEMA.describe("USD amount in integer cents"),
    },
    async ({ source_account_id, gross_cents }) => {
      const result = await postBank(
        "/banking/onramp",
        { sourceAccountId: source_account_id, grossCents: gross_cents },
        newIdempotencyKey("onramp"),
      );
      return asContent(result);
    },
  );

  server.tool(
    "bank_offramp",
    "eUSD → USD offramp. Burns eUSD on chain, then pushes USD to the destination account. Returns a `reconciled` flag (true only after the USD push reconciles with the bank).",
    {
      source_account_id: z.string().describe("eUSD account to debit"),
      destination_account_id: z.string().describe("USD account id to credit"),
      net_cents: CENTS_SCHEMA.describe("Net USD amount to push (cents)"),
    },
    async ({ source_account_id, destination_account_id, net_cents }) => {
      const result = await postBank(
        "/banking/offramp",
        {
          sourceAccountId: source_account_id,
          destinationAccountId: destination_account_id,
          netCents: net_cents,
        },
        newIdempotencyKey("offramp"),
      );
      return asContent(result);
    },
  );

  server.tool(
    "bank_wire",
    "Send a wire transfer. Routing is 9-digit ABA or 8/11-char SWIFT BIC; account is 4-17 digits; amountCents is integer cents.",
    {
      beneficiary_name: z.string().min(1).max(140).describe("Beneficiary name"),
      routing_number: z.string().regex(/^(\d{9}|[A-Z]{6}[A-Z0-9]{2}([A-Z0-9]{3})?)$/, "9-digit ABA or 8/11-char SWIFT BIC"),
      account_number: z.string().regex(/^\d{4,17}$/, "4-17 digit account number"),
      amount_cents: CENTS_SCHEMA.describe("Amount in integer cents"),
      memo: z.string().max(35).optional().describe("Optional Fedwire memo (≤ 35 chars)"),
    },
    async ({ beneficiary_name, routing_number, account_number, amount_cents, memo }) => {
      const result = await postBank(
        "/banking/wire",
        {
          beneficiaryName: beneficiary_name,
          routingNumber: routing_number,
          accountNumber: account_number,
          amountCents: amount_cents,
          ...(memo !== undefined ? { memo } : {}),
        },
        newIdempotencyKey("wire"),
      );
      return asContent(result);
    },
  );

  server.tool(
    "bank_transfer_funds",
    "Internal eUSD → eUSD transfer between two accounts. From and to must differ.",
    {
      from_account_id: z.string().describe("Source account id"),
      to_account_id: z.string().describe("Destination account id"),
      amount_cents: CENTS_SCHEMA.describe("Amount in integer cents"),
      memo: z.string().max(280).optional().describe("Optional memo"),
    },
    async ({ from_account_id, to_account_id, amount_cents, memo }) => {
      if (from_account_id === to_account_id) {
        return asContent({
          ok: false,
          error: { code: "validation", message: "from and to accounts must differ" },
        });
      }
      const result = await postBank(
        "/banking/transfer",
        {
          fromAccountId: from_account_id,
          toAccountId: to_account_id,
          amountCents: amount_cents,
          ...(memo !== undefined ? { memo } : {}),
        },
        newIdempotencyKey("transfer"),
      );
      return asContent(result);
    },
  );
}
