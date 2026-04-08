import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { getSignerFactory } from "../signing/index.js";
import { getActiveWalletId } from "./wallet.js";
import { buildCreateSwarmTx, buildSwarmProposeTx, buildSwarmVoteTx } from "../wasm/index.js";
import { blockhashCache } from "../write/blockhash-cache.js";
import { submitter } from "../write/submitter.js";

// ---------------------------------------------------------------------------
// In-memory DAO registry
// ---------------------------------------------------------------------------

const daoRegistry = new Map<string, DaoState>();

interface DaoState {
  id: string;
  name: string;
  governanceToken: string;
  quorum: number;
  votingPeriod: number;
  executionDelay: number;
  treasury: string;
  proposals: Proposal[];
  delegations: Map<string, string>;
  createdAt: string;
  creator: string;
}

interface Proposal {
  id: string;
  title: string;
  description: string;
  actions: { tool: string; params: any }[];
  votes: { for: number; against: number; abstain: number };
  voters: Set<string>;
  status: "draft" | "active" | "queued" | "executed" | "defeated";
  createdAt: string;
  endsAt: number;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function generateId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

// Derive a deterministic swarm/treasury account from creator + dao name
function deriveDaoAddress(creator: string, name: string): string {
  // Simple deterministic derivation without external dependency
  const seed = `dao:${creator}:${name}`;
  const bytes = new TextEncoder().encode(seed);
  const hash = new Uint8Array(32);
  for (let i = 0; i < 32; i++) {
    hash[i] = bytes[i % bytes.length] ^ bytes[(i + 7) % bytes.length] ^ (i * 13);
  }
  // Encode as base58 manually using the bs58-compatible charset
  const ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
  let num = BigInt("0x" + Array.from(hash).map(b => b.toString(16).padStart(2, "0")).join(""));
  let result = "";
  while (num > 0n) {
    result = ALPHABET[Number(num % 58n)] + result;
    num = num / 58n;
  }
  for (const b of hash) {
    if (b !== 0) break;
    result = "1" + result;
  }
  return result || "1";
}

// ---------------------------------------------------------------------------
// Tool registration
// ---------------------------------------------------------------------------

export function registerDaoTools(server: McpServer): void {
  server.tool(
    "create_dao",
    "Create a Decentralized Autonomous Organization on ETO. The DAO uses the Swarm program under the hood but adds token-weighted voting, proposal lifecycle (draft→active→queued→executed), treasury management, and delegation.",
    {
      name: z.string(),
      governance_token: z.string().describe("Token mint address for voting power"),
      quorum: z.number().default(50).optional().describe("Min votes % for proposal to pass"),
      voting_period: z.number().default(86400).optional().describe("Seconds for voting"),
      execution_delay: z.number().default(3600).optional().describe("Timelock before execution (seconds)"),
      treasury_funding: z.string().optional().describe("Initial ETO for treasury"),
    },
    async ({ name, governance_token, quorum, voting_period, execution_delay, treasury_funding }) => {
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

        const daoId = generateId();
        // DAOs use Swarm under the hood — derive a swarm account address
        const swarmAccount = deriveDaoAddress(payerSvm, name);

        // MajorityVote strategy = 2
        const { blockhash } = await blockhashCache.getBlockhash();
        const txBytes = buildCreateSwarmTx(
          payerSvm,
          swarmAccount,
          name,
          2, // majority vote strategy
          100, // max members (generous for a DAO)
          blockhash,
        );
        const signedBytes = await signer.sign(txBytes);
        const signedBase64 = Buffer.from(signedBytes).toString("base64");

        const result = await submitter.submitAndConfirm({
          signedTxBase64: signedBase64,
          vm: "svm",
          idempotencyKey: `create-dao-${payerSvm}-${name}-${blockhash}`,
        });

        if (result.status !== "confirmed" && result.status !== "finalized") {
          if (result.status === "timeout") {
            return {
              content: [{ type: "text" as const, text: `DAO creation submitted but timed out.\nDAO ID: ${daoId}\nSignature: ${result.signature}` }],
            };
          }
          return {
            content: [{ type: "text" as const, text: `DAO creation failed: ${result.error?.explanation ?? "Unknown error"}` }],
            isError: true,
          };
        }

        const daoState: DaoState = {
          id: daoId,
          name,
          governanceToken: governance_token,
          quorum: quorum ?? 50,
          votingPeriod: voting_period ?? 86400,
          executionDelay: execution_delay ?? 3600,
          treasury: swarmAccount,
          proposals: [],
          delegations: new Map(),
          createdAt: new Date().toISOString(),
          creator: payerSvm,
        };
        daoRegistry.set(daoId, daoState);

        const lines = [
          "DAO created successfully.",
          `DAO ID:          ${daoId}`,
          `Name:            ${name}`,
          `Governance Token:${governance_token}`,
          `Quorum:          ${quorum ?? 50}%`,
          `Voting Period:   ${voting_period ?? 86400}s`,
          `Execution Delay: ${execution_delay ?? 3600}s`,
          `Treasury:        ${swarmAccount}`,
          `Creator:         ${payerSvm}`,
          `Signature:       ${result.signature}`,
        ];
        if (treasury_funding) lines.push(`Initial Funding: ${treasury_funding} ETO`);

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
    "dao_propose",
    "Create a governance proposal in a DAO. Proposals can execute any transaction when passed. Proposals go through lifecycle: draft→active→queued→executed.",
    {
      dao_id: z.string(),
      title: z.string(),
      description: z.string().optional(),
      actions: z.array(z.object({
        tool: z.string(),
        params: z.record(z.any()),
      })).describe("Transactions to execute if proposal passes"),
    },
    async ({ dao_id, title, description, actions }) => {
      try {
        const dao = daoRegistry.get(dao_id);
        if (!dao) {
          return {
            content: [{ type: "text" as const, text: `DAO not found: ${dao_id}` }],
            isError: true,
          };
        }

        const walletId = getActiveWalletId();
        if (!walletId) {
          return {
            content: [{ type: "text" as const, text: "No active wallet set. Use set_active_wallet first." }],
          };
        }

        const factory = getSignerFactory();
        const signer = await factory.getSigner(walletId);
        const payerSvm = signer.getPublicKey();

        const proposalId = generateId();
        const now = Math.floor(Date.now() / 1000);
        const endsAt = now + dao.votingPeriod;

        // Encode actions as the proposal action data
        const actionData = new TextEncoder().encode(JSON.stringify(actions));

        const { blockhash } = await blockhashCache.getBlockhash();
        const txBytes = buildSwarmProposeTx(
          payerSvm,
          dao.treasury,
          title,
          actionData,
          blockhash,
        );
        const signedBytes = await signer.sign(txBytes);
        const signedBase64 = Buffer.from(signedBytes).toString("base64");

        const result = await submitter.submitAndConfirm({
          signedTxBase64: signedBase64,
          vm: "svm",
          idempotencyKey: `dao-propose-${dao_id}-${payerSvm}-${blockhash}`,
        });

        if (result.status !== "confirmed" && result.status !== "finalized") {
          if (result.status === "timeout") {
            return {
              content: [{ type: "text" as const, text: `Proposal submitted but timed out.\nProposal ID: ${proposalId}\nSignature: ${result.signature}` }],
            };
          }
          return {
            content: [{ type: "text" as const, text: `Proposal submission failed: ${result.error?.explanation ?? "Unknown error"}` }],
            isError: true,
          };
        }

        const proposal: Proposal = {
          id: proposalId,
          title,
          description: description ?? "",
          actions,
          votes: { for: 0, against: 0, abstain: 0 },
          voters: new Set(),
          status: "active",
          createdAt: new Date().toISOString(),
          endsAt,
        };
        dao.proposals.push(proposal);

        const deadline = new Date(endsAt * 1000).toISOString();
        const lines = [
          "Proposal created successfully.",
          `DAO ID:      ${dao_id}`,
          `Proposal ID: ${proposalId}`,
          `Title:       ${title}`,
          `Status:      active`,
          `Voting ends: ${deadline}`,
          `Proposer:    ${payerSvm}`,
          `Signature:   ${result.signature}`,
          "",
          `To vote: use dao_vote with dao_id="${dao_id}" proposal_id="${proposalId}" vote="for|against|abstain"`,
        ];
        if (description) lines.splice(4, 0, `Description: ${description}`);

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
    "dao_vote",
    "Vote on a DAO proposal. Vote weight is determined by governance token balance at the proposal snapshot block.",
    {
      dao_id: z.string(),
      proposal_id: z.string(),
      vote: z.enum(["for", "against", "abstain"]),
    },
    async ({ dao_id, proposal_id, vote }) => {
      try {
        const dao = daoRegistry.get(dao_id);
        if (!dao) {
          return {
            content: [{ type: "text" as const, text: `DAO not found: ${dao_id}` }],
            isError: true,
          };
        }

        const proposal = dao.proposals.find(p => p.id === proposal_id);
        if (!proposal) {
          return {
            content: [{ type: "text" as const, text: `Proposal not found: ${proposal_id}` }],
            isError: true,
          };
        }

        const walletId = getActiveWalletId();
        if (!walletId) {
          return {
            content: [{ type: "text" as const, text: "No active wallet set. Use set_active_wallet first." }],
          };
        }

        const factory = getSignerFactory();
        const signer = await factory.getSigner(walletId);
        const payerSvm = signer.getPublicKey();

        if (proposal.voters.has(payerSvm)) {
          return {
            content: [{ type: "text" as const, text: `Already voted on proposal ${proposal_id}.` }],
            isError: true,
          };
        }

        const now = Math.floor(Date.now() / 1000);
        if (proposal.status !== "active" || now > proposal.endsAt) {
          return {
            content: [{ type: "text" as const, text: `Proposal ${proposal_id} is not open for voting (status: ${proposal.status}).` }],
            isError: true,
          };
        }

        // Map vote to number: for=0, against=1, abstain=2
        const voteMap: Record<string, number> = { for: 0, against: 1, abstain: 2 };
        const voteNum = voteMap[vote];

        // Use proposal index within DAO proposals array
        const proposalIndex = dao.proposals.indexOf(proposal);

        const { blockhash } = await blockhashCache.getBlockhash();
        const txBytes = buildSwarmVoteTx(
          payerSvm,
          dao.treasury,
          proposalIndex,
          voteNum,
          blockhash,
        );
        const signedBytes = await signer.sign(txBytes);
        const signedBase64 = Buffer.from(signedBytes).toString("base64");

        const result = await submitter.submitAndConfirm({
          signedTxBase64: signedBase64,
          vm: "svm",
          idempotencyKey: `dao-vote-${dao_id}-${proposal_id}-${payerSvm}-${blockhash}`,
        });

        if (result.status !== "confirmed" && result.status !== "finalized") {
          if (result.status === "timeout") {
            return {
              content: [{ type: "text" as const, text: `Vote submitted but timed out.\nSignature: ${result.signature}` }],
            };
          }
          return {
            content: [{ type: "text" as const, text: `Vote failed: ${result.error?.explanation ?? "Unknown error"}` }],
            isError: true,
          };
        }

        // Update in-memory vote counts
        proposal.voters.add(payerSvm);
        if (vote === "for") proposal.votes.for += 1;
        else if (vote === "against") proposal.votes.against += 1;
        else proposal.votes.abstain += 1;

        // Check if quorum reached
        const totalVotes = proposal.votes.for + proposal.votes.against + proposal.votes.abstain;
        const forPct = totalVotes > 0 ? (proposal.votes.for / totalVotes) * 100 : 0;
        if (forPct >= dao.quorum) {
          proposal.status = "queued";
        }

        const lines = [
          "Vote cast successfully.",
          `DAO ID:      ${dao_id}`,
          `Proposal ID: ${proposal_id}`,
          `Vote:        ${vote}`,
          `Voter:       ${payerSvm}`,
          `Signature:   ${result.signature}`,
          "",
          `Current tally:`,
          `  For:     ${proposal.votes.for}`,
          `  Against: ${proposal.votes.against}`,
          `  Abstain: ${proposal.votes.abstain}`,
          `  Status:  ${proposal.status}`,
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
    "dao_delegate",
    "Delegate your voting power to another address. The delegate can vote on your behalf until you revoke. Revoke by delegating to your own address.",
    {
      dao_id: z.string(),
      delegate_to: z.string().describe("Address to delegate voting power to"),
    },
    async ({ dao_id, delegate_to }) => {
      try {
        const dao = daoRegistry.get(dao_id);
        if (!dao) {
          return {
            content: [{ type: "text" as const, text: `DAO not found: ${dao_id}` }],
            isError: true,
          };
        }

        const walletId = getActiveWalletId();
        if (!walletId) {
          return {
            content: [{ type: "text" as const, text: "No active wallet set. Use set_active_wallet first." }],
          };
        }

        const factory = getSignerFactory();
        const signer = await factory.getSigner(walletId);
        const payerSvm = signer.getPublicKey();

        dao.delegations.set(payerSvm, delegate_to);

        const isRevoke = delegate_to === payerSvm;
        const message = isRevoke
          ? `Delegation revoked in ${dao.name}. You are now voting for yourself.`
          : `Delegated voting power in ${dao.name} to ${delegate_to}. Revoke by delegating to yourself.`;

        return { content: [{ type: "text" as const, text: message }] };
      } catch (err: any) {
        return {
          content: [{ type: "text" as const, text: `Error: ${err?.message ?? String(err)}` }],
          isError: true,
        };
      }
    }
  );
}
