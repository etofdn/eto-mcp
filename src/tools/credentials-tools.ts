/**
 * FN-177 — Credential MCP tools.
 *
 * Exposes the four credential operations (request / attach / verify /
 * revoke) as MCP tools. Handlers proxy through the credential issuer
 * service at `CREDENTIAL_SERVICE_URL` (default `http://127.0.0.1:4072`).
 *
 * Auth + rate-limiting come from the `TOOL_CAPS` entries added in
 * `src/tools/index.ts`.
 */
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

const CREDENTIAL_SERVICE_URL =
  process.env.CREDENTIAL_SERVICE_URL ?? "http://127.0.0.1:4072";

async function postCred(path: string, body: unknown): Promise<unknown> {
  const res = await fetch(`${CREDENTIAL_SERVICE_URL}${path}`, {
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

const PUBKEY_SCHEMA = z
  .string()
  .regex(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/, "base58 pubkey, 32-44 chars");

const VC_SCHEMA = z.object({
  id: z.string(),
  type: z.string(),
  issuer: z.string(),
  subject: z.string(),
  issuedAt: z.string(),
  expiresAt: z.string().optional(),
  proof: z.string(),
});

export function registerCredentialTools(server: McpServer): void {
  server.tool(
    "credential_request",
    "Ask an issuer to issue a credential to a subject AgentCard. The issuer validates `claims` server-side and returns a signed VerifiableCredential on success.",
    {
      issuer: z.string().describe("Issuer DID (e.g. did:eto:bank)"),
      type: z.string().describe("Credential type (e.g. kyc.identity.v1)"),
      subject_pubkey: PUBKEY_SCHEMA.describe("Subject AgentCard pubkey"),
      claims: z.record(z.unknown()).describe("Issuer-specific claim payload"),
    },
    async ({ issuer, type, subject_pubkey, claims }) => {
      const result = await postCred("/credentials/request", {
        issuer,
        type,
        subjectPubkey: subject_pubkey,
        claims,
      });
      return asContent(result);
    },
  );

  server.tool(
    "credential_attach",
    "Bind a held credential to an AgentCard so it appears in the card's credential set. Returns the on-chain transaction signature.",
    {
      agent_card_pubkey: PUBKEY_SCHEMA.describe("AgentCard pubkey to attach to"),
      credential_id: z.string().describe("Credential id (urn) returned by credential_request"),
    },
    async ({ agent_card_pubkey, credential_id }) => {
      const result = await postCred("/credentials/attach", {
        agentCardPubkey: agent_card_pubkey,
        credentialId: credential_id,
      });
      return asContent(result);
    },
  );

  server.tool(
    "credential_verify",
    "Verify a credential's signature + revocation status. Optionally enforces a subject pubkey binding check before hitting the network.",
    {
      credential: VC_SCHEMA.describe("Full VerifiableCredential blob"),
      expected_subject: PUBKEY_SCHEMA.optional().describe("Pubkey the credential must be issued to"),
    },
    async ({ credential, expected_subject }) => {
      if (expected_subject && credential.subject !== expected_subject) {
        return asContent({
          ok: false,
          error: { code: "subject_unauthorized", message: "credential.subject does not match expected" },
        });
      }
      const result = await postCred("/credentials/verify", {
        credential,
        expectedSubject: expected_subject,
      });
      return asContent(result);
    },
  );

  server.tool(
    "credential_revoke",
    "Flag a credential as revoked at the issuer. Reason must be one of: subject_request, issuer_policy, compromise, expired, other.",
    {
      credential_id: z.string().describe("Credential id (urn) to revoke"),
      reason: z
        .enum(["subject_request", "issuer_policy", "compromise", "expired", "other"])
        .describe("Reason recorded in the revocation registry"),
      note: z.string().max(280).optional().describe("Optional free-form note"),
    },
    async ({ credential_id, reason, note }) => {
      const result = await postCred("/credentials/revoke", {
        credentialId: credential_id,
        reason,
        ...(note !== undefined ? { note } : {}),
      });
      return asContent(result);
    },
  );
}
