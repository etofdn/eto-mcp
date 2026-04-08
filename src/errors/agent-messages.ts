export interface MappedChainError {
  code: string;
  explanation: string;
  recovery: string[];
  retryable: boolean;
}

export function mapChainError(
  rawError: string,
  context?: { program?: string },
): MappedChainError {
  if (rawError.includes("BlockhashNotFound") || rawError.includes("blockhash not found")) {
    return {
      code: "CHAIN_001",
      explanation:
        "The transaction blockhash has expired. Blockhashes are valid for approximately 60 seconds on ETO. This usually means the transaction took too long between signing and submission.",
      recovery: ["Auto-retrying with fresh blockhash"],
      retryable: true,
    };
  }

  if (rawError.includes("AccountNotFound") || rawError.includes("account does not exist")) {
    return {
      code: "CHAIN_002",
      explanation:
        "The target account does not exist on-chain. On ETO, accounts must be created and funded with a rent-exempt balance before use.",
      recovery: ["Creating account automatically", "Verify the address is correct"],
      retryable: true,
    };
  }

  if (
    rawError.includes("InsufficientFunds") ||
    rawError.includes("insufficient funds") ||
    rawError.includes("insufficient lamports")
  ) {
    return {
      code: "CHAIN_003",
      explanation:
        "The wallet does not have enough ETO to cover the transaction fee. You need a small amount of ETO in your wallet to pay for any transaction, regardless of what you are sending.",
      recovery: [
        "Request free ETO from the testnet faucet (testnet only)",
        "Add ETO to your wallet to cover fees",
      ],
      retryable: false,
    };
  }

  if (
    rawError.includes("ComputeExhausted") ||
    rawError.includes("compute budget exceeded") ||
    rawError.includes("exceeded CU meter")
  ) {
    return {
      code: "CHAIN_004",
      explanation:
        "The transaction ran out of compute units before completing. Complex operations require a higher compute budget. The system will retry with an increased compute limit.",
      recovery: ["Auto-retrying with increased compute budget"],
      retryable: true,
    };
  }

  if (rawError.includes("NonceTooLow") || rawError.includes("nonce too low")) {
    return {
      code: "CHAIN_006",
      explanation:
        "The transaction nonce is below the current expected nonce on-chain. This can happen due to concurrent transaction submissions. The system will re-fetch the current nonce and retry.",
      recovery: ["Auto-retrying after re-fetching current nonce"],
      retryable: true,
    };
  }

  if (rawError.includes("NonceTooHigh") || rawError.includes("nonce too high")) {
    return {
      code: "CHAIN_006",
      explanation:
        "The transaction nonce is ahead of the current expected nonce on-chain. A previous transaction may not have confirmed yet. Wait for pending transactions to settle.",
      recovery: ["Wait for pending transactions to confirm, then retry"],
      retryable: true,
    };
  }

  if (rawError.includes("SignatureVerification") || rawError.includes("signature verification failed")) {
    return {
      code: "SIGN_001",
      explanation:
        "The transaction signature is invalid. This indicates a problem with the signing process — the key used to sign does not match the account, or the transaction was mutated after signing.",
      recovery: ["Re-sign the transaction with the correct key"],
      retryable: false,
    };
  }

  if (rawError.includes("SimulationFailed") || rawError.includes("simulation failed")) {
    return {
      code: "SIM_001",
      explanation:
        "Transaction simulation failed before submission. The transaction was not broadcast. Review the error details and correct your transaction parameters.",
      recovery: ["Review simulation failure details and correct transaction inputs"],
      retryable: false,
    };
  }

  if (rawError.includes("custom program error") || rawError.includes("Program error")) {
    const program = context?.program ?? "unknown program";
    const codeMatch = rawError.match(/0x([0-9a-fA-F]+)|error code (\d+)/);
    const errorCode = codeMatch ? (codeMatch[1] ? parseInt(codeMatch[1], 16) : parseInt(codeMatch[2] ?? "0")) : 0;
    return {
      code: "CHAIN_005",
      explanation:
        `The on-chain program "${program}" rejected the transaction with error code ${errorCode}. This is a business-logic rejection, not a network error. Check the program documentation for the meaning of error code ${errorCode}.`,
      recovery: [
        `Review ${program} program documentation for error code ${errorCode}`,
        "Verify your transaction inputs match what the program expects",
      ],
      retryable: false,
    };
  }

  if (rawError.includes("RateLimited") || rawError.includes("rate limit") || rawError.includes("Too many requests")) {
    return {
      code: "CHAIN_999",
      explanation:
        "The RPC endpoint is rate-limiting requests. Too many requests were sent in a short period. The system will back off and retry after a delay.",
      recovery: ["Auto-retrying after backoff delay"],
      retryable: true,
    };
  }

  return {
    code: "CHAIN_999",
    explanation: `Chain error: ${rawError}`,
    recovery: [],
    retryable: false,
  };
}
