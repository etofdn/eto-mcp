import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { rpc } from "../read/rpc-client.js";

const SLOTS_PER_EPOCH = 432_000;

export function registerValidatorTools(server: McpServer): void {
  server.tool(
    "list_validators",
    "List all active validators on the ETO network with their identity, stake, commission, and status.",
    {},
    async () => {
      try {
        const validators = await rpc.etoListValidators();

        if (!validators || validators.length === 0) {
          return {
            content: [{ type: "text", text: "No validators found." }],
          };
        }

        const lines = [
          `Validators (${validators.length} total):`,
          "",
          `${"Identity".padEnd(46)}  ${"Vote Key".padEnd(46)}  ${"Stake".padEnd(16)}  ${"Comm%".padEnd(6)}  Status`,
          "-".repeat(130),
        ];

        for (const v of validators) {
          const identity = (v.identity ?? v.nodePubkey ?? "N/A").padEnd(46);
          const voteKey = (v.votePubkey ?? v.voteKey ?? "N/A").padEnd(46);
          const stake = String(v.activatedStake ?? v.stake ?? "N/A").padEnd(16);
          const commission = String(v.commission ?? "N/A").padEnd(6);
          const status = v.delinquent ? "delinquent" : "active";
          lines.push(`${identity}  ${voteKey}  ${stake}  ${commission}  ${status}`);
        }

        return { content: [{ type: "text", text: lines.join("\n") }] };
      } catch (err: any) {
        return {
          content: [{ type: "text", text: `Error: ${err.message}` }],
          isError: true,
        };
      }
    }
  );

  server.tool(
    "get_epoch_info",
    "Get the current epoch number, slot, and epoch progress percentage for the ETO chain. An epoch is 432,000 slots.",
    {},
    async () => {
      try {
        const slot = await rpc.getSlot();
        const epoch = Math.floor(slot / SLOTS_PER_EPOCH);
        const slotInEpoch = slot % SLOTS_PER_EPOCH;
        const progress = ((slotInEpoch / SLOTS_PER_EPOCH) * 100).toFixed(2);

        const lines = [
          `Epoch:          ${epoch}`,
          `Current Slot:   ${slot}`,
          `Slot in Epoch:  ${slotInEpoch} / ${SLOTS_PER_EPOCH}`,
          `Progress:       ${progress}%`,
        ];

        return { content: [{ type: "text", text: lines.join("\n") }] };
      } catch (err: any) {
        return {
          content: [{ type: "text", text: `Error: ${err.message}` }],
          isError: true,
        };
      }
    }
  );

  server.tool(
    "get_vote_accounts",
    "Get vote account details for all validators, including current and delinquent vote accounts with their activated stake and epoch credits.",
    {},
    async () => {
      try {
        const result = await rpc.getVoteAccounts();

        if (!result) {
          return {
            content: [{ type: "text", text: "No vote account data available." }],
          };
        }

        const current: any[] = result.current ?? [];
        const delinquent: any[] = result.delinquent ?? [];

        const lines = [
          `Vote Accounts — Current: ${current.length}, Delinquent: ${delinquent.length}`,
          "",
        ];

        if (current.length > 0) {
          lines.push("=== Current ===");
          for (const v of current) {
            lines.push(
              `  Vote: ${v.votePubkey ?? "N/A"}  Node: ${v.nodePubkey ?? "N/A"}  Stake: ${v.activatedStake ?? "N/A"}  Commission: ${v.commission ?? "N/A"}%`
            );
          }
        }

        if (delinquent.length > 0) {
          lines.push("");
          lines.push("=== Delinquent ===");
          for (const v of delinquent) {
            lines.push(
              `  Vote: ${v.votePubkey ?? "N/A"}  Node: ${v.nodePubkey ?? "N/A"}  Stake: ${v.activatedStake ?? "N/A"}  Commission: ${v.commission ?? "N/A"}%`
            );
          }
        }

        return { content: [{ type: "text", text: lines.join("\n") }] };
      } catch (err: any) {
        return {
          content: [{ type: "text", text: `Error: ${err.message}` }],
          isError: true,
        };
      }
    }
  );
}
