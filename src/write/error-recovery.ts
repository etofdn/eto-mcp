import { blockhashCache } from "./blockhash-cache.js";
import { nonceManager } from "./nonce-manager.js";
import { config } from "../config.js";
import type { TransactionError } from "../models/index.js";

export interface RecoveryResult {
  recovered: boolean;
  strategy: string;
  explanation: string;
  retryRecommended: boolean;
}

/** Attempt automatic recovery from a transaction error */
export async function attemptRecovery(
  error: TransactionError | string,
  context?: { walletAddress?: string; evmAddress?: string; vm?: string }
): Promise<RecoveryResult> {
  const errMsg = typeof error === "string" ? error : error.raw_message;

  // BlockhashNotFound → refresh blockhash
  if (errMsg.includes("BlockhashNotFound") || errMsg.includes("blockhash")) {
    await blockhashCache.refresh();
    return {
      recovered: true,
      strategy: "blockhash_refresh",
      explanation: "Blockhash expired. Refreshed with a new blockhash. Re-sign and resubmit.",
      retryRecommended: true,
    };
  }

  // NonceTooLow → reset nonce from chain
  if (errMsg.includes("NonceTooLow") || errMsg.includes("nonce too low")) {
    if (context?.evmAddress) {
      await nonceManager.resetNonce(context.evmAddress);
    }
    return {
      recovered: true,
      strategy: "nonce_reset",
      explanation: "EVM nonce was stale. Re-fetched from chain. Re-sign and resubmit.",
      retryRecommended: true,
    };
  }

  // InsufficientFunds → check balance and suggest airdrop
  if (errMsg.includes("InsufficientFunds") || errMsg.includes("insufficient")) {
    let suggestion = "Reduce the transaction amount.";
    if (config.network !== "mainnet" && context?.walletAddress) {
      suggestion = `Request test tokens: use the 'airdrop' tool with address '${context.walletAddress}'.`;
    }
    return {
      recovered: false,
      strategy: "insufficient_funds",
      explanation: `Wallet doesn't have enough ETO. ${suggestion}`,
      retryRecommended: false,
    };
  }

  // AccountNotFound → suggest creating the account
  if (errMsg.includes("AccountNotFound") || errMsg.includes("account does not exist")) {
    return {
      recovered: false,
      strategy: "account_creation",
      explanation: "Recipient account doesn't exist. The transfer tool will auto-create it on retry, or use create_account explicitly.",
      retryRecommended: true,
    };
  }

  // ComputeExhausted → suggest increasing CU budget
  if (errMsg.includes("ComputeExhausted") || errMsg.includes("compute budget")) {
    return {
      recovered: false,
      strategy: "increase_compute",
      explanation: "Transaction ran out of compute units. Try simplifying the operation or splitting into smaller transactions.",
      retryRecommended: false,
    };
  }

  // SignatureVerification → key mismatch
  if (errMsg.includes("SignatureVerification") || errMsg.includes("signature verification")) {
    return {
      recovered: false,
      strategy: "signature_error",
      explanation: "Signature doesn't match the signing key. Verify you're using the correct wallet.",
      retryRecommended: false,
    };
  }

  // Default: unknown error
  return {
    recovered: false,
    strategy: "unknown",
    explanation: `Unrecognized error: ${errMsg}. Check the transaction details and try again.`,
    retryRecommended: false,
  };
}

/** Format a recovery result as human-readable text */
export function formatRecovery(result: RecoveryResult): string {
  const lines = [
    `Recovery: ${result.recovered ? "Automatic" : "Manual action needed"}`,
    `Strategy: ${result.strategy}`,
    `${result.explanation}`,
  ];
  if (result.retryRecommended) {
    lines.push("Action: Retry the operation.");
  }
  return lines.join("\n");
}
