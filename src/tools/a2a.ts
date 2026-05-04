import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { rpc } from "../read/rpc-client.js";
import { getSignerFactory } from "../signing/index.js";
import { getActiveWalletId } from "./wallet.js";
import { PROGRAM_IDS } from "../config.js";
import { blockhashCache } from "../write/blockhash-cache.js";
import { submitter } from "../write/submitter.js";
import { buildCreateA2AChannelTx, findPda } from "../wasm/index.js";
import bs58 from "bs58";

// ---------------------------------------------------------------------------
// Minimal tx builder helpers for A2A instructions
// ---------------------------------------------------------------------------

function writeU8(buf: number[], v: number): void { buf.push(v & 0xff); }
function writeU32LE(buf: number[], v: number): void {
  buf.push(v & 0xff, (v >>> 8) & 0xff, (v >>> 16) & 0xff, (v >>> 24) & 0xff);
}
function writeBytes(buf: number[], bytes: Uint8Array): void {
  for (const b of bytes) buf.push(b);
}
function writeVec(buf: number[], bytes: Uint8Array): void {
  writeU32LE(buf, bytes.length);
  writeBytes(buf, bytes);
}

function pubkeyBytes(b58: string): Uint8Array {
  const decoded = bs58.decode(b58);
  if (decoded.length > 32) throw new Error(`Invalid pubkey: ${b58}`);
  if (decoded.length < 32) { const p = new Uint8Array(32); p.set(decoded, 32 - decoded.length); return p; }
  return decoded;
}

function blockhashBytesOf(b58: string): Uint8Array {
  const decoded = bs58.decode(b58);
  if (decoded.length === 32) return decoded;
  const p = new Uint8Array(32);
  p.set(decoded, 32 - decoded.length);
  return p;
}

function buildA2ATx(
  payer: string,
  channelAccount: string,
  instructionData: Uint8Array,
  recentBlockhash: string,
  signerCount = 1,
): Uint8Array {
  const payerKey = pubkeyBytes(payer);
  const channelKey = pubkeyBytes(channelAccount);
  const programKey = PROGRAM_IDS.a2a;
  const blockhash = blockhashBytesOf(recentBlockhash);

  const accountKeys = [payerKey, channelKey, programKey];
  const zeroSig = new Uint8Array(64);

  const msgBuf: number[] = [];
  writeU8(msgBuf, signerCount);
  writeU8(msgBuf, 0); // numReadonlySigned
  writeU8(msgBuf, 1); // numReadonlyUnsigned (program)
  writeU32LE(msgBuf, accountKeys.length);
  for (const k of accountKeys) writeBytes(msgBuf, k);
  writeBytes(msgBuf, blockhash);
  writeU32LE(msgBuf, 1);
  writeU8(msgBuf, 2); // programIdIndex
  writeVec(msgBuf, new Uint8Array([0, 1]));
  writeVec(msgBuf, instructionData);

  const msgBytes = new Uint8Array(msgBuf);

  const txBuf: number[] = [];
  writeU32LE(txBuf, signerCount);
  for (let i = 0; i < signerCount; i++) writeBytes(txBuf, zeroSig);
  writeBytes(txBuf, msgBytes);

  return new Uint8Array(txBuf);
}

// Derive the AgentCard PDA owned by the A2A program. Uses the canonical
// findPda helper so the address matches what the on-chain program / other
// clients would compute. Seeds: "card" || authority || agent_account.
function deriveCardAddress(authority: string, agentAccount: string): string {
  return findPda(
    [
      new TextEncoder().encode("card"),
      bs58.decode(authority),
      bs58.decode(agentAccount),
    ],
    bs58.encode(PROGRAM_IDS.a2a),
  ).address;
}

export function registerA2ATools(server: McpServer): void {
  server.tool(
    "create_a2a_channel",
    "Register an AgentCard on-chain linking your agent to the A2A task network. Requires an existing agent account (from create_agent). The card makes your agent discoverable and hirable for tasks. Returns the card address used in A2A task operations.",
    {
      agent_account: z.string().describe("Your on-chain agent account address (from create_agent)"),
      name: z.string().default("Agent Card").optional().describe("Agent card name"),
      description: z.string().default("A2A agent card").optional().describe("Agent description"),
      endpoint_uri: z.string().default("").optional().describe("Agent endpoint URI"),
      capabilities_uri: z.string().default("").optional().describe("Capabilities manifest URI"),
    },
    async ({ agent_account, name, description, endpoint_uri, capabilities_uri }) => {
      try {
        const walletId = getActiveWalletId();
        if (!walletId) {
          return { content: [{ type: "text" as const, text: "No active wallet set. Use set_active_wallet first." }] };
        }

        const factory = getSignerFactory();
        const signer = await factory.getSigner(walletId);
        const payerSvm = signer.getPublicKey();
        const cardId = deriveCardAddress(payerSvm, agent_account);
        const { blockhash } = await blockhashCache.getBlockhash();

        const txBytes = buildCreateA2AChannelTx(
          payerSvm, cardId, agent_account, 0, blockhash,
          name ?? "Agent Card", description ?? "A2A agent card",
          endpoint_uri ?? "", capabilities_uri ?? "", "1.0"
        );
        const signedBytes = await signer.sign(txBytes);
        const signedBase64 = Buffer.from(signedBytes).toString("base64");

        // idempotencyKey deduplicates retries at the submitter. Deriving it
        // from (payer, agent_account, blockhash) means the same in-flight
        // registration short-circuits to the first attempt's result rather
        // than double-submitting the tx.
        const idempotencyKey = `a2a-register-card:${payerSvm}:${agent_account}:${blockhash}`;
        const result = await submitter.submitAndConfirm({
          signedTxBase64: signedBase64,
          vm: "svm",
          idempotencyKey,
        });

        if (result.status === "confirmed" || result.status === "finalized") {
          return { content: [{ type: "text" as const, text: [
            "Agent card registered on A2A network.",
            `Card address: ${cardId}`,
            `Agent:        ${agent_account}`,
            `Name:         ${name ?? "Agent Card"}`,
            `Signature:    ${result.signature}`,
          ].join("\n") }] };
        } else if (result.status === "timeout") {
          return { content: [{ type: "text" as const, text: `Submitted but timed out.\nCard: ${cardId}\nSignature: ${result.signature}` }] };
        } else {
          return { content: [{ type: "text" as const, text: `Failed: ${result.error?.explanation ?? "Unknown error"}` }], isError: true };
        }
      } catch (err: any) {
        return {
          content: [{ type: "text" as const, text: `Error: ${err?.message ?? String(err)}` }],
          isError: true,
        };
      }
    }
  );

  server.tool(
    "send_a2a_message",
    "Returns guidance for sending an interim agent-to-agent message by piggy-backing on `transfer_native` with a structured memo. The real CreateTask/SendMessage A2A flow is tracked in PR #5 (github.com/etofdn/eto-mcp/pull/5) and milestone FN-054; until it lands, this tool documents the bridge pattern (a tiny `transfer_native` carrying a `{type:\"a2a_message\",...}` memo) and emits a copy-pasteable example. Pass optional `to` (recipient agent_id / SVM address) and `body` (any JSON) to have them interpolated into the example. Legacy params `channel_id`, `message`, `priority` are accepted and ignored for backward compatibility.",
    {
      channel_id: z.string().optional().describe("(legacy) ignored — kept for backward compatibility"),
      message: z.any().optional().describe("(legacy) ignored — kept for backward compatibility"),
      priority: z.enum(["normal", "high"]).optional().describe("(legacy) ignored — kept for backward compatibility"),
      to: z.string().optional().describe("Recipient agent_id / SVM address; interpolated into the example if provided"),
      body: z.any().optional().describe("Message body (any JSON); interpolated into the example if provided"),
    },
    async ({ to, body }) => {
      const recipient = to ?? "<recipient_svm_address>";
      const bodyJson = body !== undefined ? JSON.stringify(body) : "<your json body>";
      const memoObj = `{"type":"a2a_message","to":"${recipient}","body":${bodyJson},"nonce":"<uuid>","ts":<unix_ms>}`;

      const example = [
        "transfer_native({",
        `  to: "${recipient}",`,
        '  amount: "0.000001",',
        '  unit: "sol",',
        `  memo: ${JSON.stringify(memoObj)}`,
        "})",
      ].join("\n");

      const text = [
        "send_a2a_message — interim bridge pattern (NOT the final A2A protocol)",
        "",
        "This response documents how to send an agent-to-agent message today by",
        "piggy-backing on `transfer_native` with a structured SPL Memo. The real",
        "on-chain CreateTask + SendMessage flow is tracked in PR #5 and will",
        "replace this bridge once shipped.",
        "",
        "Memo schema (JSON, anchored via SPL Memo Program v2):",
        '  {"type":"a2a_message","to":"<agent_id>","body":<json>}',
        "  Recommended fields: `nonce` (uuid, dedupe) and `ts` (unix ms, ordering).",
        "",
        "Bridge call example (paste into your MCP client):",
        example,
        "",
        "The receiver polls inbound memos with `query_memos` / `get_account_transactions`",
        "and filters for `type == \"a2a_message\"` addressed to its agent_id.",
        "",
        "Limitations:",
        "  (a) Costs SOL/gas per message (a real on-chain transfer + memo).",
        "  (b) No delivery guarantee — receiver must poll; no push.",
        "  (c) No escrow — unlike CreateTask, funds are not held pending completion.",
        "  (d) No read-receipt — sender cannot tell if the receiver consumed the memo.",
        "  (e) Memo size limit ~566 bytes (SPL Memo Program v2 cap); keep bodies tiny.",
        "  (f) Plaintext on-chain — anyone can read the memo. Encrypt sensitive payloads.",
        "",
        "Future replacement:",
        "  When CreateTask + SendMessage tools land (github.com/etofdn/eto-mcp/pull/5,",
        "  milestone FN-054), this tool will be re-wired to invoke them directly and",
        "  the bridge pattern can be retired. Memos written today using",
        '  `{"type":"a2a_message"}` remain queryable via `query_memos`, so messages',
        "  sent via the bridge are not lost when the real protocol lands.",
      ].join("\n");

      return {
        content: [{ type: "text" as const, text }],
      };
    }
  );

  server.tool(
    "read_a2a_messages",
    "Reads buffered messages from an A2A channel. Returns up to the specified limit of messages along with their sender, timestamp, and priority. When mark_read is true (the default), messages are marked as consumed so they won't be returned in future reads. Use this to implement agent message polling loops or inbox-style message processing.",
    {
      channel_id: z.string().describe("Channel account address (base58)"),
      limit: z.number().default(10).optional().describe("Maximum number of messages to return (default: 10)"),
      mark_read: z.boolean().default(true).optional().describe("Whether to mark fetched messages as read (default: true)"),
    },
    async ({ channel_id, limit, mark_read }) => {
      try {
        const account = await rpc.getAccountInfo(channel_id);

        if (!account) {
          return {
            content: [{ type: "text" as const, text: `Channel not found: ${channel_id}` }],
          };
        }

        const rawData = account.data;
        const messages: any[] = [];

        if (rawData && typeof rawData === "string") {
          try {
            const bytes = Buffer.from(rawData, "base64");
            // Parse message count at offset 2 (after discriminator + type byte)
            const msgCount = Math.min(bytes.readUInt32LE(2), limit ?? 10);
            let offset = 6;
            for (let i = 0; i < msgCount && offset < bytes.length; i++) {
              const msgLen = bytes.readUInt32LE(offset);
              offset += 4;
              if (offset + msgLen > bytes.length) break;
              const msgBytes = bytes.slice(offset, offset + msgLen);
              offset += msgLen;
              try {
                messages.push(JSON.parse(msgBytes.toString("utf8")));
              } catch {
                messages.push(msgBytes.toString("utf8"));
              }
            }
          } catch {
            // Data format unknown — return raw info
          }
        }

        const lines = [
          `Messages in channel ${channel_id}:`,
          `Count:     ${messages.length}`,
          `Mark read: ${mark_read ?? true}`,
          "",
        ];

        if (messages.length === 0) {
          lines.push("No messages found (channel may be empty or data format is pending on-chain deployment).");
        } else {
          for (let i = 0; i < messages.length; i++) {
            lines.push(`[${i + 1}] ${JSON.stringify(messages[i])}`);
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

  server.tool(
    "list_a2a_channels",
    "Lists all A2A communication channels associated with the currently active wallet. Queries the A2A program for channel accounts where the active wallet is a participant (either as creator or counterparty). Returns channel IDs, counterparty addresses, channel type, and unread message counts.",
    {},
    async () => {
      try {
        const walletId = getActiveWalletId();
        if (!walletId) {
          return {
            content: [{ type: "text" as const, text: "No active wallet set. Use set_active_wallet first." }],
          };
        }

        const factory = getSignerFactory();
        const signer = await factory.getSigner(walletId);
        const ownerAddress = signer.getPublicKey();

        const a2aProgramId = bs58.encode(PROGRAM_IDS.a2a);

        let accounts: any[] = [];
        try {
          accounts = await rpc.getProgramAccounts(a2aProgramId);
        } catch {
          accounts = [];
        }

        if (!accounts || accounts.length === 0) {
          return {
            content: [{ type: "text" as const, text: `No A2A channels found for wallet ${ownerAddress}.` }],
          };
        }

        const lines = [`A2A channels for ${ownerAddress} (${accounts.length} found):\n`];

        for (const acct of accounts) {
          const addr = acct.pubkey ?? acct.address ?? "N/A";
          lines.push(`  Channel: ${addr}`);
          lines.push(`  Owner:   ${acct.account?.owner ?? a2aProgramId}`);
          lines.push("");
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

  server.tool(
    "close_a2a_channel",
    "Closes an existing A2A channel and reclaims its rent-exempt balance back to the payer. Any unread messages in the channel buffer will be permanently discarded. This action is irreversible — after closing, a new channel must be created to resume communication. The active wallet must be the original channel creator to authorize the close.",
    {
      channel_id: z.string().describe("Channel account address (base58) to close"),
    },
    async ({ channel_id }) => {
      try {
        const walletId = getActiveWalletId();
        if (!walletId) {
          return {
            content: [{ type: "text" as const, text: "No active wallet set. Use set_active_wallet first." }],
          };
        }

        const factory = getSignerFactory();
        const signer = await factory.getSigner(walletId);
        const payerSvm = signer.getPublicKey();

        // Instruction data: discriminator 2 = CloseChannel
        const data: number[] = [];
        writeU8(data, 2); // CloseChannel

        const { blockhash } = await blockhashCache.getBlockhash();
        const txBytes = buildA2ATx(payerSvm, channel_id, new Uint8Array(data), blockhash);
        const signedBytes = await signer.sign(txBytes);
        const signedBase64 = Buffer.from(signedBytes).toString("base64");

        const result = await submitter.submitAndConfirm({
          signedTxBase64: signedBase64,
          vm: "svm",
          idempotencyKey: `close-a2a-${channel_id}-${payerSvm}-${blockhash}`,
        });

        if (result.status === "confirmed" || result.status === "finalized") {
          return {
            content: [{ type: "text" as const, text: `Channel closed successfully.\nChannel:   ${channel_id}\nSignature: ${result.signature}\nStatus:    ${result.status}` }],
          };
        } else if (result.status === "timeout") {
          return {
            content: [{ type: "text" as const, text: `Close submitted but timed out.\nChannel: ${channel_id}\nSignature: ${result.signature}` }],
          };
        } else {
          return {
            content: [{ type: "text" as const, text: `Failed to close channel: ${result.error?.explanation ?? "Unknown error"}` }],
            isError: true,
          };
        }
      } catch (err: any) {
        return {
          content: [{ type: "text" as const, text: `Error: ${err?.message ?? String(err)}` }],
          isError: true,
        };
      }
    }
  );
}
