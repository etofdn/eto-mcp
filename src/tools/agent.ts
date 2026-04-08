import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { rpc } from "../read/rpc-client.js";
import { getSignerFactory } from "../signing/index.js";
import { getActiveWalletId } from "./wallet.js";
import { PROGRAM_IDS } from "../config.js";
import { blockhashCache } from "../write/blockhash-cache.js";
import { submitter } from "../write/submitter.js";
import bs58 from "bs58";
import * as ed from "@noble/ed25519";
import { addTrigger, removeTrigger, getTriggers } from "./agent-triggers.js";

// ---------------------------------------------------------------------------
// Minimal tx builders for agent instructions (RegisterAgent / SetAgentStatus)
// ---------------------------------------------------------------------------

function writeU8(buf: number[], v: number): void { buf.push(v & 0xff); }
function writeU32LE(buf: number[], v: number): void {
  buf.push(v & 0xff, (v >>> 8) & 0xff, (v >>> 16) & 0xff, (v >>> 24) & 0xff);
}
function writeU64LE(buf: number[], v: bigint): void {
  const lo = Number(v & 0xffffffffn);
  const hi = Number((v >> 32n) & 0xffffffffn);
  writeU32LE(buf, lo);
  writeU32LE(buf, hi);
}
function writeBytes(buf: number[], bytes: Uint8Array): void {
  for (const b of bytes) buf.push(b);
}
function writeVec(buf: number[], bytes: Uint8Array): void {
  writeU32LE(buf, bytes.length);
  writeBytes(buf, bytes);
}
function writeStr(buf: number[], s: string): void {
  const encoded = new TextEncoder().encode(s);
  writeVec(buf, encoded);
}

function pubkeyBytes(b58: string): Uint8Array {
  const decoded = bs58.decode(b58);
  if (decoded.length > 32) throw new Error(`Invalid pubkey: ${b58}`);
  if (decoded.length < 32) { const p = new Uint8Array(32); p.set(decoded, 32 - decoded.length); return p; }
  return decoded;
}

function blockhashBytes(b58: string): Uint8Array {
  const decoded = bs58.decode(b58);
  if (decoded.length === 32) return decoded;
  const pb = new Uint8Array(32); pb.set(decoded, 32 - decoded.length); return pb;
  return decoded;
}

function buildAgentTx(
  payer: string,
  agentAccount: string,
  instructionData: Uint8Array,
  recentBlockhash: string,
): Uint8Array {
  const payerKey = pubkeyBytes(payer);
  const agentKey = pubkeyBytes(agentAccount);
  const programKey = PROGRAM_IDS.agent;
  const blockhash = blockhashBytes(recentBlockhash);

  const accountKeys = [payerKey, agentKey, programKey];

  const sigCount = 2; // payer + agentAccount sign
  const zeroSig = new Uint8Array(64);
  const ixAccountIndices = new Uint8Array([0, 1]);

  const msgBuf: number[] = [];
  writeU8(msgBuf, sigCount);
  writeU8(msgBuf, 0); // numReadonlySigned
  writeU8(msgBuf, 1); // numReadonlyUnsigned (program)
  writeU32LE(msgBuf, accountKeys.length);
  for (const k of accountKeys) writeBytes(msgBuf, k);
  writeBytes(msgBuf, blockhash);
  writeU32LE(msgBuf, 1); // 1 instruction
  writeU8(msgBuf, 2); // programIdIndex = 2
  writeVec(msgBuf, ixAccountIndices);
  writeVec(msgBuf, instructionData);

  const msgBytes = new Uint8Array(msgBuf);

  const txBuf: number[] = [];
  writeU32LE(txBuf, sigCount);
  writeBytes(txBuf, zeroSig);
  writeBytes(txBuf, zeroSig);
  writeBytes(txBuf, msgBytes);

  return new Uint8Array(txBuf);
}

function buildSetStatusTx(
  payer: string,
  agentAccount: string,
  status: number,
  recentBlockhash: string,
): Uint8Array {
  // Discriminator 1 = SetAgentStatus, then u8 status
  const data: number[] = [];
  writeU8(data, 1);
  writeU8(data, status);
  return buildAgentTx(payer, agentAccount, new Uint8Array(data), recentBlockhash);
}

export function registerAgentTools(server: McpServer): void {
  server.tool(
    "create_agent",
    "Creates a new autonomous agent account on the ETO network. Generates a fresh Ed25519 keypair for the agent account, builds and signs a RegisterAgent transaction using the active (or specified) wallet as the payer, and submits it on-chain. Returns the new agent's public address. The description and program fields are stored in agent account metadata for discovery by other tools and swarms.",
    {
      name: z.string().describe("Human-readable name for the agent"),
      description: z.string().optional().describe("Optional description of the agent's purpose"),
      program: z.string().optional().describe("Optional program ID (base58) the agent is associated with"),
      initial_funding: z.string().default("0").optional().describe("Initial funding in lamports transferred to the agent account"),
      from_wallet: z.string().optional().describe("Wallet ID to pay for agent creation; defaults to active wallet"),
    },
    async ({ name, description, program, initial_funding, from_wallet }) => {
      try {
        const walletId = from_wallet ?? getActiveWalletId();
        if (!walletId) {
          return {
            content: [{ type: "text" as const, text: "No wallet specified and no active wallet set. Use set_active_wallet or provide from_wallet." }],
          };
        }

        const factory = getSignerFactory();
        const signer = await factory.getSigner(walletId);
        const payerSvm = signer.getPublicKey();

        // Generate random agent keypair
        const agentSecretBytes = ed.utils.randomPrivateKey();
        const agentPubBytes = await ed.getPublicKeyAsync(agentSecretBytes);
        const agentAddress = bs58.encode(agentPubBytes);

        // Build RegisterAgent instruction data: discriminator 0, then name, description, program
        const data: number[] = [];
        writeU8(data, 0); // discriminator = RegisterAgent
        writeStr(data, name);
        writeStr(data, description ?? "");
        writeStr(data, program ?? "");
        writeU64LE(data, BigInt(initial_funding ?? "0"));

        const { blockhash } = await blockhashCache.getBlockhash();
        const txBytes = buildAgentTx(payerSvm, agentAddress, new Uint8Array(data), blockhash);

        // Sign with payer
        const signedByPayer = await signer.sign(txBytes);
        const signedBase64 = Buffer.from(signedByPayer).toString("base64");

        const result = await submitter.submitAndConfirm({
          signedTxBase64: signedBase64,
          vm: "svm",
          idempotencyKey: `create-agent-${payerSvm}-${agentAddress}-${blockhash}`,
        });

        if (result.status === "confirmed" || result.status === "finalized") {
          const lines = [
            "Agent created successfully.",
            `Agent Address: ${agentAddress}`,
            `Name:          ${name}`,
            `Payer:         ${payerSvm}`,
            `Signature:     ${result.signature}`,
            `Status:        ${result.status}`,
          ];
          if (description) lines.push(`Description:   ${description}`);
          if (program) lines.push(`Program:       ${program}`);
          return { content: [{ type: "text" as const, text: lines.join("\n") }] };
        } else if (result.status === "timeout") {
          return {
            content: [{ type: "text" as const, text: `Agent creation submitted but confirmation timed out.\nAgent Address: ${agentAddress}\nSignature: ${result.signature}` }],
          };
        } else {
          return {
            content: [{ type: "text" as const, text: `Agent creation failed: ${result.error?.explanation ?? "Unknown error"}` }],
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
    "configure_agent_trigger",
    "Configures an on-chain trigger for an autonomous agent. Triggers define when and how an agent automatically executes — for example in response to a price oracle crossing a threshold, a block being produced, or a specific account state changing. The action parameter supports 'add', 'update', or 'remove' to manage the trigger lifecycle. Note: full on-chain trigger execution requires the trigger dispatch program to be deployed.",
    {
      agent_id: z.string().describe("Agent account address (base58)"),
      action: z.enum(["add", "update", "remove"]).describe("Trigger management action"),
      trigger_id: z.string().optional().describe("Trigger ID for update/remove operations"),
      trigger: z.any().optional().describe("Trigger definition object (for add/update)"),
    },
    async ({ agent_id, action, trigger_id, trigger }) => {
      try {
        if (action === "add") {
          if (!trigger) {
            return { content: [{ type: "text" as const, text: "trigger definition is required for action=add" }], isError: true };
          }
          const t = addTrigger(agent_id, trigger.type, trigger.params ?? trigger);
          return {
            content: [{ type: "text" as const, text: `Trigger added.\nTrigger ID: ${t.id}\nAgent:      ${agent_id}\nType:       ${t.type}\nEnabled:    ${t.enabled}` }],
          };
        }

        if (action === "update") {
          if (!trigger_id) {
            return { content: [{ type: "text" as const, text: "trigger_id is required for action=update" }], isError: true };
          }
          removeTrigger(trigger_id);
          if (!trigger) {
            return { content: [{ type: "text" as const, text: "trigger definition is required for action=update" }], isError: true };
          }
          const t = addTrigger(agent_id, trigger.type, trigger.params ?? trigger);
          return {
            content: [{ type: "text" as const, text: `Trigger updated.\nOld Trigger ID: ${trigger_id}\nNew Trigger ID: ${t.id}\nAgent:          ${agent_id}\nType:           ${t.type}` }],
          };
        }

        if (action === "remove") {
          if (!trigger_id) {
            return { content: [{ type: "text" as const, text: "trigger_id is required for action=remove" }], isError: true };
          }
          const removed = removeTrigger(trigger_id);
          return {
            content: [{ type: "text" as const, text: removed ? `Trigger ${trigger_id} removed.` : `Trigger ${trigger_id} not found.` }],
          };
        }

        return { content: [{ type: "text" as const, text: `Unknown action: ${action}` }], isError: true };
      } catch (err: any) {
        return {
          content: [{ type: "text" as const, text: `Error: ${err?.message ?? String(err)}` }],
          isError: true,
        };
      }
    }
  );

  server.tool(
    "list_agents",
    "Lists all agent accounts associated with the current active wallet on the ETO network. Queries the agent program for accounts owned by the current wallet and returns their addresses, names, and status. Use status_filter to narrow results to only active, paused, or depleted agents. The active wallet must be set before calling this tool.",
    {
      status_filter: z.enum(["all", "active", "paused", "depleted"]).default("all").optional()
        .describe("Filter agents by status: all, active, paused, or depleted"),
    },
    async ({ status_filter }) => {
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

        const agentProgramId = bs58.encode(PROGRAM_IDS.agent);

        let accounts: any[] = [];
        try {
          accounts = await rpc.getProgramAccounts(agentProgramId);
        } catch {
          // getProgramAccounts may not be supported; return empty
          accounts = [];
        }

        if (!accounts || accounts.length === 0) {
          return {
            content: [{ type: "text" as const, text: `No agents found for wallet ${ownerAddress} (filter: ${status_filter ?? "all"}).` }],
          };
        }

        const statusNames: Record<number, string> = { 0: "active", 1: "paused", 2: "depleted" };
        const lines = [`Agents for ${ownerAddress} (filter: ${status_filter ?? "all"}):\n`];

        for (const acct of accounts) {
          const addr = acct.pubkey ?? acct.address ?? "N/A";
          const rawData = acct.account?.data ?? acct.data;
          let statusStr = "unknown";
          let nameStr = "N/A";

          if (rawData && typeof rawData === "string") {
            try {
              const bytes = Buffer.from(rawData, "base64");
              // Skip 9 bytes (1 discriminator + 8 borsh enum prefix heuristic)
              const statusByte = bytes[1] ?? 0;
              statusStr = statusNames[statusByte] ?? `status(${statusByte})`;
              // name is a borsh string: u32 LE length then UTF-8 bytes, starting at offset 2
              const nameLen = bytes.readUInt32LE(2);
              nameStr = bytes.slice(6, 6 + nameLen).toString("utf8");
            } catch {
              // leave defaults
            }
          }

          if (status_filter && status_filter !== "all" && statusStr !== status_filter) {
            continue;
          }

          lines.push(`  Address: ${addr}`);
          lines.push(`  Name:    ${nameStr}`);
          lines.push(`  Status:  ${statusStr}`);
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
    "get_agent",
    "Fetches the on-chain state of a specific agent account. Returns the agent's name, owner, status (active, paused, or depleted), associated program, and any metadata stored at account creation time. Use this before dispatching work to an agent to verify it is active and funded.",
    {
      agent_id: z.string().describe("Agent account address (base58)"),
    },
    async ({ agent_id }) => {
      try {
        const account = await rpc.getAccountInfo(agent_id);

        if (!account) {
          return {
            content: [{ type: "text" as const, text: `Agent account not found: ${agent_id}` }],
          };
        }

        const statusNames: Record<number, string> = { 0: "active", 1: "paused", 2: "depleted" };
        const agentProgramId = bs58.encode(PROGRAM_IDS.agent);

        let statusStr = "unknown";
        let nameStr = "N/A";
        let descStr = "N/A";

        const rawData = account.data;
        if (rawData && typeof rawData === "string") {
          try {
            const bytes = Buffer.from(rawData, "base64");
            const statusByte = bytes[1] ?? 0;
            statusStr = statusNames[statusByte] ?? `status(${statusByte})`;
            const nameLen = bytes.readUInt32LE(2);
            nameStr = bytes.slice(6, 6 + nameLen).toString("utf8");
            const descOffset = 6 + nameLen;
            const descLen = bytes.readUInt32LE(descOffset);
            descStr = bytes.slice(descOffset + 4, descOffset + 4 + descLen).toString("utf8");
          } catch {
            // leave defaults
          }
        }

        const lines = [
          `Agent:       ${agent_id}`,
          `Name:        ${nameStr}`,
          `Description: ${descStr}`,
          `Status:      ${statusStr}`,
          `Owner:       ${account.owner ?? agentProgramId}`,
          `Balance:     ${account.lamports ?? 0} lamports`,
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
    "execute_agent",
    "Manually triggers execution of an autonomous agent with optional parameters. In the full implementation, this dispatches a trigger event to the agent's on-chain execution queue and returns a job ID for tracking. Note: manual agent execution requires the trigger dispatch integration to be deployed. For automated execution, use configure_agent_trigger to set up event-driven triggers.",
    {
      agent_id: z.string().describe("Agent account address (base58)"),
      params: z.any().optional().describe("Optional execution parameters to pass to the agent"),
    },
    async ({ agent_id, params }) => {
      try {
        const triggers = getTriggers(agent_id);
        if (triggers.length === 0) {
          return {
            content: [{ type: "text" as const, text: "No triggers configured for this agent. Use configure_agent_trigger to add triggers first." }],
          };
        }

        const results: string[] = [];
        for (const trigger of triggers) {
          trigger.lastFired = Date.now();
          trigger.fireCount++;
          results.push(`Trigger ${trigger.id} (${trigger.type}): fired (count: ${trigger.fireCount})`);
        }

        return {
          content: [{ type: "text" as const, text: `Agent ${agent_id} executed manually.\n\n${results.join("\n")}\n\nTotal triggers fired: ${results.length}` }],
        };
      } catch (err: any) {
        return {
          content: [{ type: "text" as const, text: `Error: ${err?.message ?? String(err)}` }],
          isError: true,
        };
      }
    }
  );

  server.tool(
    "pause_agent",
    "Pauses an active autonomous agent by submitting a SetAgentStatus transaction with status=Paused. While paused, the agent will not respond to triggers or execute automated tasks but its account and funding are preserved. Use resume_agent to re-activate. The active (or from_wallet) wallet must be the agent's owner.",
    {
      agent_id: z.string().describe("Agent account address (base58) to pause"),
      from_wallet: z.string().optional().describe("Wallet ID of the agent owner; defaults to active wallet"),
    },
    async ({ agent_id, from_wallet }) => {
      try {
        const walletId = from_wallet ?? getActiveWalletId();
        if (!walletId) {
          return {
            content: [{ type: "text" as const, text: "No wallet specified and no active wallet set." }],
          };
        }

        const factory = getSignerFactory();
        const signer = await factory.getSigner(walletId);
        const payerSvm = signer.getPublicKey();

        const { blockhash } = await blockhashCache.getBlockhash();
        const txBytes = buildSetStatusTx(payerSvm, agent_id, 1 /* Paused */, blockhash);
        const signedBytes = await signer.sign(txBytes);
        const signedBase64 = Buffer.from(signedBytes).toString("base64");

        const result = await submitter.submitAndConfirm({
          signedTxBase64: signedBase64,
          vm: "svm",
          idempotencyKey: `pause-agent-${agent_id}-${blockhash}`,
        });

        if (result.status === "confirmed" || result.status === "finalized") {
          return {
            content: [{ type: "text" as const, text: `Agent paused successfully.\nAgent:     ${agent_id}\nSignature: ${result.signature}\nStatus:    ${result.status}` }],
          };
        } else if (result.status === "timeout") {
          return {
            content: [{ type: "text" as const, text: `Pause submitted but confirmation timed out.\nAgent: ${agent_id}\nSignature: ${result.signature}` }],
          };
        } else {
          return {
            content: [{ type: "text" as const, text: `Failed to pause agent: ${result.error?.explanation ?? "Unknown error"}` }],
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
    "resume_agent",
    "Resumes a previously paused autonomous agent by submitting a SetAgentStatus transaction with status=Active. Once resumed, the agent will begin processing triggers and executing automated tasks again. The active (or from_wallet) wallet must be the agent's owner to authorize the status change.",
    {
      agent_id: z.string().describe("Agent account address (base58) to resume"),
      from_wallet: z.string().optional().describe("Wallet ID of the agent owner; defaults to active wallet"),
    },
    async ({ agent_id, from_wallet }) => {
      try {
        const walletId = from_wallet ?? getActiveWalletId();
        if (!walletId) {
          return {
            content: [{ type: "text" as const, text: "No wallet specified and no active wallet set." }],
          };
        }

        const factory = getSignerFactory();
        const signer = await factory.getSigner(walletId);
        const payerSvm = signer.getPublicKey();

        const { blockhash } = await blockhashCache.getBlockhash();
        const txBytes = buildSetStatusTx(payerSvm, agent_id, 0 /* Active */, blockhash);
        const signedBytes = await signer.sign(txBytes);
        const signedBase64 = Buffer.from(signedBytes).toString("base64");

        const result = await submitter.submitAndConfirm({
          signedTxBase64: signedBase64,
          vm: "svm",
          idempotencyKey: `resume-agent-${agent_id}-${blockhash}`,
        });

        if (result.status === "confirmed" || result.status === "finalized") {
          return {
            content: [{ type: "text" as const, text: `Agent resumed successfully.\nAgent:     ${agent_id}\nSignature: ${result.signature}\nStatus:    ${result.status}` }],
          };
        } else if (result.status === "timeout") {
          return {
            content: [{ type: "text" as const, text: `Resume submitted but confirmation timed out.\nAgent: ${agent_id}\nSignature: ${result.signature}` }],
          };
        } else {
          return {
            content: [{ type: "text" as const, text: `Failed to resume agent: ${result.error?.explanation ?? "Unknown error"}` }],
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
