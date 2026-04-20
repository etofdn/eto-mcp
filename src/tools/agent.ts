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
import { BorshReader, decodeAccountData } from "../utils/borsh-reader.js";

// AgentState on-chain layout (Rust borsh, see runtime/src/programs/agent.rs):
//   discriminator: [u8; 8]
//   authority: Pubkey (32)
//   name: String, model_id: String, metadata_uri: String
//   reputation: u64
//   status: u8 (0=active, 1=paused, 2=deactivated)
//   ...
function parseAgentState(rawData: any): {
  authority: string;
  name: string;
  modelId: string;
  metadataUri: string;
  reputation: bigint;
  statusByte: number;
} | null {
  const buf = decodeAccountData(rawData);
  if (!buf || buf.length < 40) return null;
  try {
    const r = new BorshReader(buf);
    r.skip(8); // discriminator
    const authority = r.readPubkey();
    const name = r.readString();
    const modelId = r.readString();
    const metadataUri = r.readString();
    const reputation = r.readU64();
    const statusByte = r.readU8();
    return { authority, name, modelId, metadataUri, reputation, statusByte };
  } catch {
    return null;
  }
}
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

  // Rust expects: [signer+writable funder, writable agent, read-only authority]
  // Authority = payer (index 0). Program at index 2.
  const accountKeys = [payerKey, agentKey, programKey];

  const sigCount = 1; // only payer signs (matches working swarm pattern)
  const zeroSig = new Uint8Array(64);
  const ixAccountIndices = new Uint8Array([0, 1, 0]); // funder, agent, authority=payer

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
  writeBytes(txBuf, msgBytes);

  return new Uint8Array(txBuf);
}

function buildSetStatusTx(
  payer: string,
  agentAccount: string,
  status: number,
  recentBlockhash: string,
): Uint8Array {
  // Discriminator 6 = SetStatus (Borsh enum index 6), then u8 status
  const data: number[] = [];
  writeU8(data, 6);
  writeU8(data, status);
  return buildAgentTx(payer, agentAccount, new Uint8Array(data), recentBlockhash);
}

export function registerAgentTools(server: McpServer): void {
  server.tool(
    "create_agent",
    "Creates a new autonomous agent account on the ETO network. Generates a fresh Ed25519 keypair for the agent account, builds and signs a RegisterAgent transaction using the active (or specified) wallet as the payer, and submits it on-chain. The on-chain agent record stores `name`, `model_id` (e.g. 'claude-opus-4-6'), and `metadata_uri` (off-chain capabilities JSON, e.g. an IPFS hash). Returns the new agent's public address.",
    {
      name: z.string().describe("Human-readable name for the agent"),
      model_id: z.string().optional().describe("Model identifier (e.g. 'claude-opus-4-6'). Aliased as 'description' for back-compat."),
      description: z.string().optional().describe("Deprecated alias for model_id"),
      metadata_uri: z.string().optional().describe("Off-chain metadata URI (IPFS/Arweave hash for capabilities JSON). Aliased as 'program' for back-compat."),
      program: z.string().optional().describe("Deprecated alias for metadata_uri"),
      initial_funding: z.string().default("0").optional().describe("Initial funding in lamports transferred to the agent account"),
      from_wallet: z.string().optional().describe("Wallet ID to pay for agent creation; defaults to active wallet"),
    },
    async ({ name, model_id, description, metadata_uri, program, initial_funding, from_wallet }) => {
      const modelId = model_id ?? description ?? "";
      const metadataUri = metadata_uri ?? program ?? "";
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

        // Build RegisterAgent instruction data: discriminator 0, then name, model_id, metadata_uri
        const data: number[] = [];
        writeU8(data, 0); // discriminator = RegisterAgent
        writeStr(data, name);
        writeStr(data, modelId);
        writeStr(data, metadataUri);
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
          if (modelId) lines.push(`Model:         ${modelId}`);
          if (metadataUri) lines.push(`Metadata URI:  ${metadataUri}`);
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
    "list_agents",
    "Lists all agent accounts associated with the current active wallet on the ETO network. Queries the agent program for accounts owned by the current wallet and returns their addresses, names, and status. Use status_filter to narrow results to only active, paused, or depleted agents. The active wallet must be set before calling this tool.",
    {
      status_filter: z.enum(["all", "active", "paused", "depleted"]).default("all").optional()
        .describe("Filter agents by status: all, active, paused, or depleted"),
    },
    async ({ status_filter }) => {
      try {
        // list_agents is a read-only discovery tool; an active wallet is helpful
        // for ownership context but not required.
        const walletId = getActiveWalletId();
        let ownerAddress: string | null = null;
        if (walletId) {
          try {
            const signer = await getSignerFactory().getSigner(walletId);
            ownerAddress = signer.getPublicKey();
          } catch {
            // ignore
          }
        }

        const agentProgramId = bs58.encode(PROGRAM_IDS.agent);

        let accounts: any[] = [];
        try {
          accounts = await rpc.getProgramAccounts(agentProgramId);
        } catch {
          // getProgramAccounts may not be supported; return empty
          accounts = [];
        }

        if (!accounts || accounts.length === 0) {
          const ctx = ownerAddress ? `for wallet ${ownerAddress}` : "on this network";
          return {
            content: [{ type: "text" as const, text: `No agents found ${ctx} (filter: ${status_filter ?? "all"}).` }],
          };
        }

        const statusNames: Record<number, string> = { 0: "active", 1: "paused", 2: "deactivated" };
        const header = ownerAddress
          ? `Agents (active wallet: ${ownerAddress}, filter: ${status_filter ?? "all"}):\n`
          : `Agents (filter: ${status_filter ?? "all"}):\n`;
        const lines = [header];

        for (const acct of accounts) {
          const addr = acct.pubkey ?? acct.address ?? "N/A";
          const rawData = acct.account?.data ?? acct.data;
          const parsed = parseAgentState(rawData);
          const nameStr = parsed?.name || "N/A";
          const statusStr = parsed ? (statusNames[parsed.statusByte] ?? `status(${parsed.statusByte})`) : "unknown";
          const ownerStr = parsed?.authority ?? null;

          if (status_filter && status_filter !== "all" && statusStr !== status_filter) {
            continue;
          }

          lines.push(`  Address: ${addr}`);
          lines.push(`  Name:    ${nameStr}`);
          lines.push(`  Status:  ${statusStr}`);
          if (ownerStr) lines.push(`  Owner:   ${ownerStr}`);
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
        const info: any = await rpc.getAccountInfo(agent_id);
        if (!info) {
          return {
            content: [{ type: "text" as const, text: `Agent account not found: ${agent_id}` }],
          };
        }
        // SVM RPC can return either {value: null|account} or the account fields directly.
        const account: any = info.value === null
          ? null
          : (info.value && typeof info.value === "object" ? info.value : info);
        if (!account) {
          return {
            content: [{ type: "text" as const, text: `Agent account not found: ${agent_id}` }],
          };
        }

        const statusNames: Record<number, string> = { 0: "active", 1: "paused", 2: "deactivated" };
        const agentProgramId = bs58.encode(PROGRAM_IDS.agent);

        const parsed = parseAgentState(account.data);
        const nameStr = parsed?.name || "N/A";
        const modelStr = parsed?.modelId || "N/A";
        const metaStr = parsed?.metadataUri || "";
        const statusStr = parsed ? (statusNames[parsed.statusByte] ?? `status(${parsed.statusByte})`) : "unknown";
        const authorityStr = parsed?.authority ?? "N/A";
        const reputationStr = parsed ? parsed.reputation.toString() : "N/A";

        const lines = [
          `Agent:       ${agent_id}`,
          `Name:        ${nameStr}`,
          `Authority:   ${authorityStr}`,
          `Model:       ${modelStr}`,
          `Status:      ${statusStr}`,
          `Reputation:  ${reputationStr}`,
          `Program:     ${account.owner ?? agentProgramId}`,
          `Balance:     ${account.lamports ?? 0} lamports`,
        ];
        if (metaStr) lines.push(`Metadata:    ${metaStr}`);

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
