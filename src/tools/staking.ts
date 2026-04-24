import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { rpc } from "../read/rpc-client.js";
import { lamportsToSol, solToLamports } from "../utils/units.js";
import { getSignerFactory } from "../signing/index.js";
import { getActiveWalletId } from "./wallet.js";
import { buildCreateStakeTx, buildDelegateStakeTx, buildDeactivateStakeTx, buildWithdrawStakeTx, generateKeypair } from "../wasm/index.js";
import { blockhashCache } from "../write/blockhash-cache.js";
import { submitter } from "../write/submitter.js";

export function registerStakingTools(server: McpServer): void {
  server.tool(
    "create_stake",
    "Create a new stake account and deposit ETO into it. The stake account is a prerequisite for delegating to a validator. Provide the amount in ETO (e.g. '10.5'). The stake account address is returned after creation and must be saved for subsequent delegate/deactivate/withdraw operations.",
    {
      amount: z.string().describe("Amount of ETO to stake (e.g. '10.5')"),
      from_wallet: z
        .string()
        .optional()
        .describe("Funding wallet address. Uses default wallet if omitted."),
    },
    async ({ amount, from_wallet }) => {
      try {
        const walletId = from_wallet ?? getActiveWalletId();
        if (!walletId) {
          return { content: [{ type: "text", text: "No wallet specified and no active wallet set. Use set_active_wallet or provide from_wallet." }] };
        }
        const signer = await getSignerFactory().getSigner(walletId);
        const fromSvm = signer.getPublicKey();
        const stakeKeypair = generateKeypair();
        const stakeAddress = stakeKeypair.publicKey;
        const lamports = solToLamports(amount);
        const { blockhash } = await blockhashCache.getBlockhash();
        const txBytes = buildCreateStakeTx(fromSvm, stakeAddress, lamports, blockhash);

        // Two signers: staker (slot 0) and stake account (slot 1). Without
        // slot-1's signature, Stake::Initialize fails at account ownership
        // verification and the account is allocated but never initialized.
        const ed = await import("@noble/ed25519");
        const sigCountLE = new DataView(txBytes.buffer, txBytes.byteOffset, 4).getUint32(0, true);
        const messageBytes = txBytes.slice(4 + sigCountLE * 64);
        const payerSigned = await signer.sign(txBytes);
        const stakeSecret = Uint8Array.from(Buffer.from(stakeKeypair.secretKey, "hex"));
        const stakeSig = await ed.sign(messageBytes, stakeSecret);
        const fullySigned = new Uint8Array(payerSigned);
        fullySigned.set(stakeSig, 4 + 64); // slot 1
        const txBase64 = Buffer.from(fullySigned).toString("base64");
        const result = await submitter.submitAndConfirm({ signedTxBase64: txBase64, vm: "svm", timeoutMs: 15000 });
        const lines: string[] = [];
        if (result.status === "confirmed" || result.status === "finalized") {
          lines.push("Stake account created successfully.");
          lines.push(`Signature:     ${result.signature}`);
          lines.push(`Status:        ${result.status}`);
          lines.push(`Stake account: ${stakeAddress}`);
          lines.push(`Amount:        ${amount} ETO (${lamports} lamports)`);
          lines.push(`Staker:        ${fromSvm}`);
          if (result.fee !== undefined) lines.push(`Fee:           ${result.fee} lamports`);
        } else if (result.status === "timeout") {
          lines.push("Transaction submitted but confirmation timed out.");
          lines.push(`Signature: ${result.signature}`);
          lines.push(`Stake account: ${stakeAddress}`);
        } else {
          lines.push("Stake account creation failed.");
          lines.push(`Error: ${result.error?.explanation ?? result.error?.raw_message ?? "Unknown error"}`);
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
    "delegate_stake",
    "Delegate an existing stake account to a validator. The stake becomes active at the beginning of the next epoch. Use list_validators to find a validator's vote account address. Once delegated, rewards accrue each epoch.",
    {
      stake_account: z
        .string()
        .describe("Stake account address (base58) returned from create_stake"),
      validator: z
        .string()
        .describe("Validator vote account address (base58) from list_validators"),
      from_wallet: z
        .string()
        .optional()
        .describe("Staker authority wallet. Uses default wallet if omitted."),
    },
    async ({ stake_account, validator, from_wallet }) => {
      try {
        const walletId = from_wallet ?? getActiveWalletId();
        if (!walletId) {
          return {
            content: [{ type: "text" as const, text: "Error: no active wallet. Use set_active_wallet or provide from_wallet." }],
            isError: true,
          };
        }

        // Validate the validator vote account exists. The on-chain stake program
        // does not currently reject delegations to arbitrary addresses, so without
        // this pre-check the user can silently delegate to a typo or a non-validator.
        try {
          const va: any = await rpc.getVoteAccounts();
          const current: any[] = va?.current ?? [];
          const delinquent: any[] = va?.delinquent ?? [];
          const total = current.length + delinquent.length;
          if (total > 0) {
            const found =
              current.some((v: any) => v.votePubkey === validator) ||
              delinquent.some((v: any) => v.votePubkey === validator);
            if (!found) {
              return {
                content: [{ type: "text" as const, text: `Error: '${validator}' is not a known validator vote account on this network. Use list_validators to see eligible validators.` }],
                isError: true,
              };
            }
          }
          // total == 0 → no validators on this network (e.g. testnet); allow but warn in output below
        } catch {
          // RPC failure: don't block the user, just proceed
        }

        const factory = getSignerFactory();
        const signer = await factory.getSigner(walletId);
        const staker = signer.getPublicKey();

        const { blockhash } = await blockhashCache.getBlockhash();

        const txBytes = buildDelegateStakeTx(staker, stake_account, validator, blockhash);

        const signedBytes = await signer.sign(txBytes);
        const signedBase64 = Buffer.from(signedBytes).toString("base64");

        const result = await submitter.submitAndConfirm({
          signedTxBase64: signedBase64,
          vm: "svm",
          timeoutMs: 15000,
        });

        if (result.status === "confirmed" || result.status === "finalized") {
          return {
            content: [{ type: "text" as const, text: `Stake delegated.\nSignature: ${result.signature}\nStatus: ${result.status}\nStake account: ${stake_account}\nValidator: ${validator}${result.latency_ms ? `\nLatency: ${result.latency_ms}ms` : ""}` }],
          };
        } else if (result.status === "timeout") {
          return {
            content: [{ type: "text" as const, text: `Delegation submitted but confirmation timed out.\nSignature: ${result.signature}\nThe transaction may still confirm — check the signature on-chain.` }],
          };
        } else {
          return {
            content: [{ type: "text" as const, text: `Delegation failed: ${result.error?.explanation ?? result.error?.raw_message ?? result.status}` }],
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
    "deactivate_stake",
    "Begin the unstaking process for a delegated stake account. After deactivation, the stake becomes inactive at the end of the current epoch (one full epoch cooldown). Once inactive, use withdraw_stake to reclaim the ETO.",
    {
      stake_account: z
        .string()
        .describe("Stake account address (base58) to deactivate"),
      from_wallet: z
        .string()
        .optional()
        .describe("Staker authority wallet. Uses default wallet if omitted."),
    },
    async ({ stake_account, from_wallet }) => {
      try {
        const walletId = from_wallet ?? getActiveWalletId();
        if (!walletId) {
          return {
            content: [{ type: "text" as const, text: "Error: no active wallet. Use set_active_wallet or provide from_wallet." }],
            isError: true,
          };
        }

        const factory = getSignerFactory();
        const signer = await factory.getSigner(walletId);
        const staker = signer.getPublicKey();

        const { blockhash } = await blockhashCache.getBlockhash();

        const txBytes = buildDeactivateStakeTx(staker, stake_account, blockhash);

        const signedBytes = await signer.sign(txBytes);
        const signedBase64 = Buffer.from(signedBytes).toString("base64");

        const result = await submitter.submitAndConfirm({
          signedTxBase64: signedBase64,
          vm: "svm",
          timeoutMs: 15000,
        });

        if (result.status === "confirmed" || result.status === "finalized") {
          return {
            content: [{ type: "text" as const, text: `Stake deactivated.\nSignature: ${result.signature}\nStatus: ${result.status}\nStake account: ${stake_account}${result.latency_ms ? `\nLatency: ${result.latency_ms}ms` : ""}` }],
          };
        } else if (result.status === "timeout") {
          return {
            content: [{ type: "text" as const, text: `Deactivation submitted but confirmation timed out.\nSignature: ${result.signature}\nThe transaction may still confirm — check the signature on-chain.` }],
          };
        } else {
          return {
            content: [{ type: "text" as const, text: `Deactivation failed: ${result.error?.explanation ?? result.error?.raw_message ?? result.status}` }],
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
    "withdraw_stake",
    "Withdraw ETO from a deactivated stake account back to a wallet. The stake must be fully inactive (cooldown epoch has passed) before withdrawal is possible. Use 'all' to withdraw the full balance including accrued rewards, or specify an amount in ETO.",
    {
      stake_account: z
        .string()
        .describe("Stake account address (base58) in Inactive state"),
      to_wallet: z
        .string()
        .optional()
        .describe("Destination wallet address. Uses stake authority wallet if omitted."),
      amount: z
        .string()
        .default("all")
        .optional()
        .describe("Amount to withdraw in ETO, or 'all' for full balance (default: all)"),
      from_wallet: z
        .string()
        .optional()
        .describe("Staker authority wallet. Uses default wallet if omitted."),
    },
    async ({ stake_account, to_wallet, amount, from_wallet }) => {
      try {
        const walletId = from_wallet ?? getActiveWalletId();
        if (!walletId) {
          return {
            content: [{ type: "text" as const, text: "Error: no active wallet. Use set_active_wallet or provide from_wallet." }],
            isError: true,
          };
        }

        const factory = getSignerFactory();
        const signer = await factory.getSigner(walletId);
        const staker = signer.getPublicKey();
        const recipient = to_wallet ?? staker;

        // Resolve lamport amount — for "all", fetch the stake account balance
        let lamports: bigint;
        if (!amount || amount === "all") {
          const accountInfo = await rpc.getBalance(stake_account);
          const rawBalance = accountInfo?.value ?? accountInfo;
          lamports = BigInt(rawBalance ?? 0);
        } else {
          lamports = solToLamports(amount);
        }

        const { blockhash } = await blockhashCache.getBlockhash();

        const txBytes = buildWithdrawStakeTx(staker, stake_account, recipient, lamports, blockhash);

        const signedBytes = await signer.sign(txBytes);
        const signedBase64 = Buffer.from(signedBytes).toString("base64");

        const result = await submitter.submitAndConfirm({
          signedTxBase64: signedBase64,
          vm: "svm",
          timeoutMs: 15000,
        });

        if (result.status === "confirmed" || result.status === "finalized") {
          return {
            content: [{ type: "text" as const, text: `Stake withdrawn.\nSignature: ${result.signature}\nStatus: ${result.status}\nStake account: ${stake_account}\nRecipient: ${recipient}\nAmount: ${lamportsToSol(lamports)} ETO (${lamports} lamports)${result.latency_ms ? `\nLatency: ${result.latency_ms}ms` : ""}` }],
          };
        } else if (result.status === "timeout") {
          return {
            content: [{ type: "text" as const, text: `Withdrawal submitted but confirmation timed out.\nSignature: ${result.signature}\nThe transaction may still confirm — check the signature on-chain.` }],
          };
        } else {
          return {
            content: [{ type: "text" as const, text: `Withdrawal failed: ${result.error?.explanation ?? result.error?.raw_message ?? result.status}` }],
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
    "get_stake_info",
    "Get detailed information about a stake account including staked amount, delegated validator, current activation status (inactive/activating/active/deactivating), and epoch details.",
    {
      stake_account: z
        .string()
        .describe("Stake account address (base58) to inspect"),
    },
    async ({ stake_account }) => {
      try {
        const [activation, accountInfo] = await Promise.all([
          rpc.getStakeActivation(stake_account),
          rpc.getAccountInfo(stake_account),
        ]);

        const lines = [`Stake Account: ${stake_account}`, ""];

        if (activation) {
          lines.push(`Status:             ${activation.state ?? activation.status ?? "N/A"}`);
          lines.push(
            `Active Stake:       ${activation.active !== undefined ? lamportsToSol(activation.active) + " ETO (" + activation.active + " lamports)" : "N/A"}`
          );
          lines.push(
            `Inactive Stake:     ${activation.inactive !== undefined ? lamportsToSol(activation.inactive) + " ETO (" + activation.inactive + " lamports)" : "N/A"}`
          );
        }

        if (accountInfo) {
          const value = accountInfo.value ?? accountInfo;
          lines.push(
            `Total Balance:      ${value.lamports !== undefined ? lamportsToSol(value.lamports) + " ETO (" + value.lamports + " lamports)" : "N/A"}`
          );
          lines.push(`Owner Program:      ${value.owner ?? "N/A"}`);

          const data = value.data;
          if (data) {
            const parsed =
              data.parsed ?? (typeof data === "object" ? data : null);
            if (parsed?.info) {
              const info = parsed.info;
              lines.push(`Delegation:         ${info.stake?.delegation?.voter ?? "N/A"}`);
              lines.push(
                `Activation Epoch:   ${info.stake?.delegation?.activationEpoch ?? "N/A"}`
              );
              lines.push(
                `Deactivation Epoch: ${info.stake?.delegation?.deactivationEpoch ?? "N/A"}`
              );
              lines.push(`Staker Authority:   ${info.meta?.authorized?.staker ?? "N/A"}`);
              lines.push(
                `Withdrawer Auth:    ${info.meta?.authorized?.withdrawer ?? "N/A"}`
              );
            }
          }
        } else {
          lines.push("Account not found or no data available.");
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
