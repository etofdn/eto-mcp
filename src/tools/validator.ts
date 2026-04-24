import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { rpc } from "../read/rpc-client.js";

const SLOTS_PER_EPOCH = 432_000;

export function registerValidatorTools(server: McpServer): void {
  server.tool(
    "list_validators",
    "List all validators on the ETO network with their index, address, block-server endpoint, and active/delinquent status.",
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
          `${"#".padEnd(4)}  ${"Address".padEnd(22)}  ${"Block Server".padEnd(22)}  Status`,
          "-".repeat(70),
        ];

        for (const v of validators) {
          const idx = String(v.publicKeySeed ?? v.index ?? "?").padEnd(4);
          const address = (v.address ?? v.identity ?? v.nodePubkey ?? "N/A").padEnd(22);
          const blockServer = (v.blockServer ?? v.voteKey ?? v.votePubkey ?? "N/A").padEnd(22);
          const status = (v.active === false || v.delinquent) ? "delinquent" : "active";
          lines.push(`${idx}  ${address}  ${blockServer}  ${status}`);
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

        const current: any[] = result?.current ?? [];
        const delinquent: any[] = result?.delinquent ?? [];

        // ETO uses a proprietary consensus model — use list_validators for active validator info.
        if (current.length === 0 && delinquent.length === 0) {
          const validators = await rpc.etoListValidators().catch(() => []);
          const active = validators.filter((v: any) => v.active !== false).length;
          return {
            content: [{
              type: "text",
              text: `ETO uses a proprietary multi-VM consensus (not Solana-style vote accounts).\nActive validators: ${active}\nUse list_validators for full validator details.`,
            }],
          };
        }

        const lines = [
          `Vote Accounts — Current: ${current.length}, Delinquent: ${delinquent.length}`,
          "",
        ];

        for (const v of current) {
          lines.push(`  Vote: ${v.votePubkey ?? "N/A"}  Node: ${v.nodePubkey ?? "N/A"}  Stake: ${v.activatedStake ?? "N/A"}  Commission: ${v.commission ?? "N/A"}%`);
        }
        for (const v of delinquent) {
          lines.push(`  [delinquent] Vote: ${v.votePubkey ?? "N/A"}  Node: ${v.nodePubkey ?? "N/A"}`);
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
