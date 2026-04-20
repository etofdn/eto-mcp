import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { rpc } from "../read/rpc-client.js";
import { getSignerFactory } from "../signing/index.js";
import { getActiveWalletId } from "./wallet.js";
import { PROGRAM_IDS } from "../config.js";
import { blockhashCache } from "../write/blockhash-cache.js";
import { submitter } from "../write/submitter.js";
import bs58 from "bs58";
import { BorshReader, decodeAccountData } from "../utils/borsh-reader.js";

// SwarmState on-chain layout (Rust borsh, see runtime/src/programs/swarm.rs):
//   discriminator: [u8; 8]
//   leader: Pubkey (32)
//   sub_tasks: Vec<SubTask>  // SubTask = agent[32] + task_key[32] + status(u8) + result_hash[32] = 97 B
//   status: u8, strategy: u8
//   created_slot: u64, deadline_slot: u64
//   escrow_total: u64, escrow_per_task: u64
function parseSwarmState(rawData: any): {
  leader: string;
  subTaskCount: number;
  statusByte: number;
  strategyByte: number;
  createdSlot: bigint;
  deadlineSlot: bigint;
  escrowTotal: bigint;
  escrowPerTask: bigint;
} | null {
  const buf = decodeAccountData(rawData);
  if (!buf || buf.length < 40) return null;
  try {
    const r = new BorshReader(buf);
    r.skip(8); // discriminator
    const leader = r.readPubkey();
    const subTaskCount = r.readU32();
    r.skip(subTaskCount * 97); // skip SubTask entries
    const statusByte = r.readU8();
    const strategyByte = r.readU8();
    const createdSlot = r.readU64();
    const deadlineSlot = r.readU64();
    const escrowTotal = r.readU64();
    const escrowPerTask = r.readU64();
    return { leader, subTaskCount, statusByte, strategyByte, createdSlot, deadlineSlot, escrowTotal, escrowPerTask };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Minimal tx builder helpers for swarm instructions
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
  writeVec(buf, new TextEncoder().encode(s));
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

function buildSwarmTx(
  payer: string,
  swarmAccount: string,
  instructionData: Uint8Array,
  recentBlockhash: string,
): Uint8Array {
  const payerKey = pubkeyBytes(payer);
  const swarmKey = pubkeyBytes(swarmAccount);
  const programKey = PROGRAM_IDS.swarm;
  const blockhash = blockhashBytesOf(recentBlockhash);

  const accountKeys = [payerKey, swarmKey, programKey];
  const zeroSig = new Uint8Array(64);

  const msgBuf: number[] = [];
  writeU8(msgBuf, 1); // numRequiredSignatures
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
  writeU32LE(txBuf, 1);
  writeBytes(txBuf, zeroSig);
  writeBytes(txBuf, msgBytes);

  return new Uint8Array(txBuf);
}

// Derive a deterministic swarm account address from creator + name
function deriveSwarmAddress(creator: string, name: string): string {
  const seed = new TextEncoder().encode(`swarm:${creator}:${name}`);
  const programKey = PROGRAM_IDS.swarm;
  const combined = new Uint8Array(seed.length + 32);
  combined.set(seed);
  combined.set(programKey, seed.length);
  const hash = new Uint8Array(32);
  for (let i = 0; i < 32; i++) {
    hash[i] = combined[i % combined.length] ^ combined[(i + 13) % combined.length];
  }
  return bs58.encode(hash);
}

// consensus_type -> strategy number
// majority=2, unanimous=0, weighted=2, leader=3
const CONSENSUS_MAP: Record<string, number> = {
  majority: 2,
  unanimous: 0,
  weighted: 2,
  leader: 3,
};

// join_policy -> number
const JOIN_POLICY_MAP: Record<string, number> = {
  open: 0,
  invite_only: 1,
  stake_required: 2,
};

// vote -> number
const VOTE_MAP: Record<string, number> = {
  approve: 0,
  reject: 1,
  abstain: 2,
};

export function registerSwarmTools(server: McpServer): void {
  server.tool(
    "create_swarm",
    "Creates a new agent swarm on the ETO network — a coordinated group of agents that govern themselves via on-chain proposals and voting. The consensus_type determines how votes are tallied: majority requires >50%, unanimous requires all members to approve, weighted counts stake, and leader delegates decisions to a single coordinator. The join_policy controls membership: open allows anyone, invite_only requires an invitation, and stake_required mandates locking tokens. Returns the swarm account address.",
    {
      name: z.string().describe("Human-readable name for the swarm"),
      max_members: z.number().default(10).optional()
        .describe("Maximum number of agent members allowed in the swarm (default: 10)"),
      consensus_type: z.enum(["majority", "unanimous", "weighted", "leader"]).default("majority").optional()
        .describe("Voting consensus mechanism: majority, unanimous, weighted (by stake), or leader-based"),
      join_policy: z.enum(["open", "invite_only", "stake_required"]).default("invite_only").optional()
        .describe("Membership policy: open, invite_only, or stake_required"),
      initial_funding: z.string().optional()
        .describe("Initial funding in lamports transferred to the swarm treasury"),
    },
    async (_args) => {
      // The swarm program has no standalone CreateSwarm instruction. Swarms are
      // spawned exclusively via the agent_triggers system (TriggerType::CreateSwarm
      // + CreateSwarmPayload), which fans out work to a pre-registered set of
      // agents. The previous standalone tool was sending an instruction that no
      // on-chain handler accepted — txs confirmed but no account was ever created,
      // making downstream get_swarm/swarm_propose/swarm_vote impossible.
      return {
        content: [{ type: "text" as const, text:
          "create_swarm is not available as a standalone instruction.\n\n" +
          "Swarms on ETO are spawned by the agent_triggers program. To create a swarm:\n" +
          "  1. Register the participating agents (create_agent for each).\n" +
          "  2. Set up an AgentTrigger of type CreateSwarm with a CreateSwarmPayload\n" +
          "     containing { agents: [Pubkey], strategy, deadline_slot, task_data }.\n" +
          "  3. Fire the trigger; the swarm SubTask records appear in SwarmState.\n\n" +
          "A dedicated trigger-based create_swarm wrapper is on the roadmap." }],
        isError: true,
      };
    }
  );

  server.tool(
    "join_swarm",
    "Submits a request for the active wallet's agent to join an existing swarm. For open-policy swarms, membership is granted immediately. For invite-only swarms, an invitation token must be provided. For stake-required swarms, a stake_amount in lamports must be locked as collateral. The joining agent's address is derived from the active wallet.",
    {
      swarm_id: z.string().describe("Swarm account address (base58) to join"),
      stake_amount: z.string().optional()
        .describe("Stake amount in lamports required for stake_required swarms"),
      invitation: z.string().optional()
        .describe("Invitation token for invite_only swarms"),
    },
    async ({ swarm_id, stake_amount, invitation }) => {
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

        // Instruction: discriminator 1 = JoinSwarm
        const data: number[] = [];
        writeU8(data, 1);
        writeU64LE(data, BigInt(stake_amount ?? "0"));
        writeStr(data, invitation ?? "");

        const { blockhash } = await blockhashCache.getBlockhash();
        const txBytes = buildSwarmTx(payerSvm, swarm_id, new Uint8Array(data), blockhash);
        const signedBytes = await signer.sign(txBytes);
        const signedBase64 = Buffer.from(signedBytes).toString("base64");

        const result = await submitter.submitAndConfirm({
          signedTxBase64: signedBase64,
          vm: "svm",
          idempotencyKey: `join-swarm-${swarm_id}-${payerSvm}-${blockhash}`,
        });

        if (result.status === "confirmed" || result.status === "finalized") {
          const lines = [
            "Joined swarm successfully.",
            `Swarm:     ${swarm_id}`,
            `Member:    ${payerSvm}`,
            `Signature: ${result.signature}`,
            `Status:    ${result.status}`,
          ];
          if (stake_amount) lines.push(`Staked:    ${stake_amount} lamports`);
          return { content: [{ type: "text" as const, text: lines.join("\n") }] };
        } else if (result.status === "timeout") {
          return {
            content: [{ type: "text" as const, text: `Join submitted but timed out.\nSwarm: ${swarm_id}\nSignature: ${result.signature}` }],
          };
        } else {
          return {
            content: [{ type: "text" as const, text: `Failed to join swarm: ${result.error?.explanation ?? "Unknown error"}` }],
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
    "swarm_propose",
    "Submits a governance proposal to a swarm for member voting. Proposals can represent any action the swarm should collectively approve — such as parameter changes, treasury disbursements, or agent configuration updates. The action field is a JSON-serializable object describing what should happen if the proposal passes. An optional voting_deadline (Unix timestamp) sets when voting closes.",
    {
      swarm_id: z.string().describe("Swarm account address (base58) to submit the proposal to"),
      title: z.string().describe("Short title for the proposal"),
      description: z.string().optional().describe("Detailed description of the proposal and its rationale"),
      action: z.any().describe("JSON-serializable action object describing what to execute if the proposal passes"),
      voting_deadline: z.number().optional()
        .describe("Unix timestamp (seconds) when voting closes; omit for default deadline"),
    },
    async ({ swarm_id, title, description, action, voting_deadline }) => {
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

        // Instruction: discriminator 2 = SwarmPropose
        const data: number[] = [];
        writeU8(data, 2);
        writeStr(data, title);
        writeStr(data, description ?? "");
        writeStr(data, JSON.stringify(action ?? {}));
        writeU64LE(data, BigInt(voting_deadline ?? 0));

        const { blockhash } = await blockhashCache.getBlockhash();
        const txBytes = buildSwarmTx(payerSvm, swarm_id, new Uint8Array(data), blockhash);
        const signedBytes = await signer.sign(txBytes);
        const signedBase64 = Buffer.from(signedBytes).toString("base64");

        const result = await submitter.submitAndConfirm({
          signedTxBase64: signedBase64,
          vm: "svm",
          idempotencyKey: `swarm-propose-${swarm_id}-${payerSvm}-${blockhash}`,
        });

        if (result.status === "confirmed" || result.status === "finalized") {
          const lines = [
            "Proposal submitted successfully.",
            `Swarm:     ${swarm_id}`,
            `Title:     ${title}`,
            `Proposer:  ${payerSvm}`,
            `Signature: ${result.signature}`,
          ];
          if (description) lines.push(`Desc:      ${description}`);
          if (voting_deadline) lines.push(`Deadline:  ${new Date(voting_deadline * 1000).toISOString()}`);
          return { content: [{ type: "text" as const, text: lines.join("\n") }] };
        } else if (result.status === "timeout") {
          return {
            content: [{ type: "text" as const, text: `Proposal submitted but timed out.\nSignature: ${result.signature}` }],
          };
        } else {
          return {
            content: [{ type: "text" as const, text: `Proposal failed: ${result.error?.explanation ?? "Unknown error"}` }],
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
    "swarm_vote",
    "Casts a vote on an active swarm governance proposal. Each swarm member can vote approve, reject, or abstain on any open proposal before its voting deadline. An optional reason string is stored on-chain for audit purposes. The vote is irreversible once submitted. Results are tallied according to the swarm's consensus_type once all votes are in or the deadline passes.",
    {
      swarm_id: z.string().describe("Swarm account address (base58)"),
      proposal_id: z.string().describe("Proposal account address or ID to vote on"),
      vote: z.enum(["approve", "reject", "abstain"]).describe("Your vote: approve, reject, or abstain"),
      reason: z.string().optional().describe("Optional on-chain reason for your vote"),
    },
    async ({ swarm_id, proposal_id, vote, reason }) => {
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

        // Instruction: discriminator 3 = SwarmVote
        const data: number[] = [];
        writeU8(data, 3);
        writeStr(data, proposal_id);
        writeU8(data, VOTE_MAP[vote] ?? 0);
        writeStr(data, reason ?? "");

        const { blockhash } = await blockhashCache.getBlockhash();
        const txBytes = buildSwarmTx(payerSvm, swarm_id, new Uint8Array(data), blockhash);
        const signedBytes = await signer.sign(txBytes);
        const signedBase64 = Buffer.from(signedBytes).toString("base64");

        const result = await submitter.submitAndConfirm({
          signedTxBase64: signedBase64,
          vm: "svm",
          idempotencyKey: `swarm-vote-${swarm_id}-${proposal_id}-${payerSvm}-${blockhash}`,
        });

        if (result.status === "confirmed" || result.status === "finalized") {
          const lines = [
            "Vote cast successfully.",
            `Swarm:      ${swarm_id}`,
            `Proposal:   ${proposal_id}`,
            `Vote:       ${vote}`,
            `Voter:      ${payerSvm}`,
            `Signature:  ${result.signature}`,
          ];
          if (reason) lines.push(`Reason:     ${reason}`);
          return { content: [{ type: "text" as const, text: lines.join("\n") }] };
        } else if (result.status === "timeout") {
          return {
            content: [{ type: "text" as const, text: `Vote submitted but timed out.\nSignature: ${result.signature}` }],
          };
        } else {
          return {
            content: [{ type: "text" as const, text: `Vote failed: ${result.error?.explanation ?? "Unknown error"}` }],
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
    "get_swarm",
    "Fetches the on-chain state of a swarm account. Returns the swarm's name, creator, member list, consensus type, join policy, treasury balance, and active proposal count. Use this before submitting proposals or votes to verify the swarm is active and to understand its governance configuration.",
    {
      swarm_id: z.string().describe("Swarm account address (base58)"),
    },
    async ({ swarm_id }) => {
      try {
        const info: any = await rpc.getAccountInfo(swarm_id);
        if (!info) {
          return {
            content: [{ type: "text" as const, text: `Swarm account not found: ${swarm_id}` }],
          };
        }
        const account: any = info.value === null
          ? null
          : (info.value && typeof info.value === "object" ? info.value : info);
        if (!account) {
          return {
            content: [{ type: "text" as const, text: `Swarm account not found: ${swarm_id}` }],
          };
        }

        // Names match the Rust enums in runtime/src/programs/swarm.rs.
        const statusNames: Record<number, string> = { 0: "active", 1: "completed", 2: "cancelled", 3: "failed" };
        const strategyNames: Record<number, string> = { 0: "all_required", 1: "k_of_n", 2: "first_complete", 3: "leader_decides" };

        const parsed = parseSwarmState(account.data);
        const lines: string[] = [
          `Swarm:           ${swarm_id}`,
          `Owner program:   ${account.owner ?? bs58.encode(PROGRAM_IDS.swarm)}`,
          `Balance:         ${account.lamports ?? 0} lamports`,
        ];
        if (parsed) {
          lines.push(`Leader:          ${parsed.leader}`);
          lines.push(`Sub-tasks:       ${parsed.subTaskCount}`);
          lines.push(`Status:          ${statusNames[parsed.statusByte] ?? `status(${parsed.statusByte})`}`);
          lines.push(`Strategy:        ${strategyNames[parsed.strategyByte] ?? `strategy(${parsed.strategyByte})`}`);
          lines.push(`Created slot:    ${parsed.createdSlot}`);
          lines.push(`Deadline slot:   ${parsed.deadlineSlot === 0n ? "(none)" : parsed.deadlineSlot.toString()}`);
          lines.push(`Escrow total:    ${parsed.escrowTotal} lamports`);
          lines.push(`Escrow per task: ${parsed.escrowPerTask} lamports`);
        } else {
          lines.push("(account data could not be decoded as SwarmState)");
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
}
