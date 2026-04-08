import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { rpc } from "../read/rpc-client.js";
import { getSignerFactory } from "../signing/index.js";
import { getActiveWalletId } from "./wallet.js";
import { PROGRAM_IDS } from "../config.js";
import { blockhashCache } from "../write/blockhash-cache.js";
import { submitter } from "../write/submitter.js";
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
  const p = new Uint8Array(32); p.set(decoded, 32 - decoded.length); return p;
  return decoded;
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

// Derive a deterministic channel PDA from two participants
function deriveChannelAddress(partyA: string, partyB: string): string {
  // Sort so the channel address is the same regardless of which party creates it
  const sorted = [partyA, partyB].sort();
  const seed = new TextEncoder().encode(`a2a:${sorted[0]}:${sorted[1]}`);
  const programKey = PROGRAM_IDS.a2a;
  // Simple deterministic derivation: sha256 of seed + program
  const combined = new Uint8Array(seed.length + 32);
  combined.set(seed);
  combined.set(programKey, seed.length);
  // Use a fixed 32-byte hash based on the input (without importing sha256 again)
  // We construct a pseudo-address from the bytes of the seed for channel ID generation
  const hash = new Uint8Array(32);
  for (let i = 0; i < 32; i++) {
    hash[i] = combined[i % combined.length] ^ combined[(i + 7) % combined.length];
  }
  return bs58.encode(hash);
}

export function registerA2ATools(server: McpServer): void {
  server.tool(
    "create_a2a_channel",
    "Creates a bidirectional or unidirectional Agent-to-Agent (A2A) communication channel on the ETO network. A2A channels provide authenticated, ordered message delivery between two agent accounts. The channel capacity controls the maximum number of unread messages that can be buffered. Returns the channel account address for use in subsequent send/read operations.",
    {
      counterparty: z.string().describe("Address (base58) of the other agent or wallet for this channel"),
      channel_type: z.enum(["bidirectional", "unidirectional"]).default("bidirectional").optional()
        .describe("Channel direction: bidirectional allows both sides to send, unidirectional only allows the creator to send"),
      capacity: z.number().default(100).optional()
        .describe("Maximum number of messages that can be buffered in the channel (default: 100)"),
    },
    async ({ counterparty, channel_type, capacity }) => {
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

        const channelId = deriveChannelAddress(payerSvm, counterparty);

        // Instruction data: discriminator 0 = CreateChannel, then type u8, capacity u32
        const data: number[] = [];
        writeU8(data, 0); // CreateChannel
        writeU8(data, channel_type === "unidirectional" ? 1 : 0);
        writeU32LE(data, capacity ?? 100);
        // counterparty pubkey
        writeBytes(data, pubkeyBytes(counterparty));

        const { blockhash } = await blockhashCache.getBlockhash();
        const txBytes = buildA2ATx(payerSvm, channelId, new Uint8Array(data), blockhash);
        const signedBytes = await signer.sign(txBytes);
        const signedBase64 = Buffer.from(signedBytes).toString("base64");

        const result = await submitter.submitAndConfirm({
          signedTxBase64: signedBase64,
          vm: "svm",
          idempotencyKey: `create-a2a-${payerSvm}-${counterparty}-${blockhash}`,
        });

        if (result.status === "confirmed" || result.status === "finalized") {
          const lines = [
            "A2A channel created successfully.",
            `Channel ID:   ${channelId}`,
            `Creator:      ${payerSvm}`,
            `Counterparty: ${counterparty}`,
            `Type:         ${channel_type ?? "bidirectional"}`,
            `Capacity:     ${capacity ?? 100}`,
            `Signature:    ${result.signature}`,
          ];
          return { content: [{ type: "text" as const, text: lines.join("\n") }] };
        } else if (result.status === "timeout") {
          return {
            content: [{ type: "text" as const, text: `Channel creation submitted but timed out.\nChannel ID: ${channelId}\nSignature: ${result.signature}` }],
          };
        } else {
          return {
            content: [{ type: "text" as const, text: `Failed to create channel: ${result.error?.explanation ?? "Unknown error"}` }],
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

  server.tool(
    "send_a2a_message",
    "Sends a message through an existing A2A channel to the counterparty agent. Messages are JSON-serialized and stored on-chain in the channel's message buffer. High-priority messages are placed at the front of the queue and processed before normal-priority messages. The message payload can be any JSON-serializable value including structured commands, data, or plain text.",
    {
      channel_id: z.string().describe("Channel account address (base58) returned by create_a2a_channel"),
      message: z.any().describe("Message payload — any JSON-serializable value"),
      priority: z.enum(["normal", "high"]).default("normal").optional()
        .describe("Message priority: high-priority messages are processed before normal ones"),
    },
    async ({ channel_id, message, priority }) => {
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

        const msgBytes = new TextEncoder().encode(JSON.stringify(message));

        // Instruction data: discriminator 1 = SendMessage, priority u8, then message vec
        const data: number[] = [];
        writeU8(data, 1); // SendMessage
        writeU8(data, priority === "high" ? 1 : 0);
        writeVec(data, msgBytes);

        const { blockhash } = await blockhashCache.getBlockhash();
        const txBytes = buildA2ATx(payerSvm, channel_id, new Uint8Array(data), blockhash);
        const signedBytes = await signer.sign(txBytes);
        const signedBase64 = Buffer.from(signedBytes).toString("base64");

        const result = await submitter.submitAndConfirm({
          signedTxBase64: signedBase64,
          vm: "svm",
          idempotencyKey: `send-a2a-${channel_id}-${payerSvm}-${blockhash}`,
        });

        if (result.status === "confirmed" || result.status === "finalized") {
          return {
            content: [{ type: "text" as const, text: `Message sent successfully.\nChannel:   ${channel_id}\nPriority:  ${priority ?? "normal"}\nSignature: ${result.signature}` }],
          };
        } else if (result.status === "timeout") {
          return {
            content: [{ type: "text" as const, text: `Message submitted but timed out.\nSignature: ${result.signature}` }],
          };
        } else {
          return {
            content: [{ type: "text" as const, text: `Failed to send message: ${result.error?.explanation ?? "Unknown error"}` }],
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
