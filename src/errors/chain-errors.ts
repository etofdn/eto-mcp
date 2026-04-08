import { McpError } from "./index.js";

// AUTH errors

export function sessionExpired(): McpError {
  return new McpError(
    "AUTH_001",
    "auth",
    "Session has expired",
    "Your authentication session is no longer valid. Sessions expire after 5 minutes of inactivity to protect your wallet. You must re-authenticate before performing any write operations.",
    [
      {
        action: "reauthenticate",
        description: "Start a new session by authenticating again",
        tool: "authenticate",
      },
    ],
    false,
  );
}

export function insufficientCapabilities(required: string[], current: string[]): McpError {
  const missing = required.filter((r) => !current.includes(r));
  return new McpError(
    "AUTH_002",
    "auth",
    `Insufficient capabilities: missing ${missing.join(", ")}`,
    `This operation requires capabilities [${required.join(", ")}] but the current session only has [${current.join(", ")}]. The missing capabilities are: [${missing.join(", ")}]. You need to request elevated permissions or use a session with the appropriate capabilities.`,
    [
      {
        action: "request_capabilities",
        description: `Request a new session with capabilities: ${missing.join(", ")}`,
        tool: "authenticate",
        params: { capabilities: required },
      },
    ],
    false,
  );
}

// VALIDATION errors

export function invalidAddress(address: string): McpError {
  return new McpError(
    "VAL_001",
    "validation",
    `Invalid address: ${address}`,
    `The address "${address}" is not a valid ETO address. Addresses must be either a base58-encoded 32-byte SVM public key (e.g. "3Kj5...") or a 0x-prefixed 20-byte EVM address (e.g. "0x1234...abcd"). Check for typos or incorrect format.`,
    [
      {
        action: "check_address",
        description: "Verify the address format — SVM addresses are base58 (32 bytes), EVM addresses start with 0x (20 bytes)",
      },
      {
        action: "list_wallets",
        description: "List your available wallet addresses",
        tool: "list_wallets",
      },
    ],
    false,
  );
}

export function amountExceedsBalance(amount: string, balance: string, shortfall: string): McpError {
  return new McpError(
    "VAL_002",
    "validation",
    `Amount ${amount} exceeds available balance ${balance}`,
    `You are trying to send ${amount} ETO but your wallet only has ${balance} ETO available. You are short by ${shortfall} ETO. Note that you also need to keep enough balance to cover transaction fees.`,
    [
      {
        action: "reduce_amount",
        description: `Reduce the send amount to at most ${balance} ETO (minus fees)`,
      },
      {
        action: "check_balance",
        description: "Check your current wallet balance",
        tool: "get_balance",
      },
    ],
    false,
  );
}

export function invalidAmount(reason: string): McpError {
  return new McpError(
    "VAL_003",
    "validation",
    `Invalid amount: ${reason}`,
    `The amount provided is not valid: ${reason}. Amounts must be positive numbers expressed as decimal strings (e.g. "1.5" for 1.5 ETO). Amounts cannot be zero, negative, or exceed the maximum supply.`,
    [
      {
        action: "fix_amount",
        description: "Provide a valid positive decimal amount as a string, e.g. \"1.0\" or \"0.5\"",
      },
    ],
    false,
  );
}

// CHAIN errors

export function blockhashExpired(): McpError {
  return new McpError(
    "CHAIN_001",
    "chain",
    "Transaction blockhash has expired",
    "The blockhash used to sign this transaction is no longer valid. Blockhashes on ETO expire after approximately 60 seconds. This typically happens if a transaction took too long to submit after being signed. The system will automatically fetch a fresh blockhash and re-sign the transaction.",
    [
      {
        action: "retry",
        description: "Auto-retrying with a fresh blockhash — no action needed",
      },
    ],
    true,
    0,
  );
}

export function accountNotFound(address: string): McpError {
  return new McpError(
    "CHAIN_002",
    "chain",
    `Account not found: ${address}`,
    `The account at address "${address}" does not exist on-chain. On ETO (like Solana), accounts must be explicitly created and funded with a minimum rent-exempt balance before they can receive tokens or be used in transactions. The system can automatically create this account.`,
    [
      {
        action: "create_account",
        description: "Automatically create and fund the account with the minimum rent-exempt balance",
        tool: "create_account",
        params: { address },
      },
      {
        action: "verify_address",
        description: "Verify the address is correct — the account may not have been created yet",
      },
    ],
    true,
  );
}

export function insufficientFundsForFee(fee: string, balance: string): McpError {
  return new McpError(
    "CHAIN_003",
    "chain",
    `Insufficient funds for transaction fee: need ${fee}, have ${balance}`,
    `Your wallet has ${balance} ETO but the transaction fee is ${fee} ETO. You need at least ${fee} ETO in your wallet just to cover the fee, separate from the transfer amount. On testnet, you can request free ETO from the faucet.`,
    [
      {
        action: "request_airdrop",
        description: "Request free ETO from the testnet faucet (testnet only)",
        tool: "request_airdrop",
      },
      {
        action: "fund_wallet",
        description: "Add ETO to your wallet to cover transaction fees",
      },
    ],
    false,
  );
}

export function computeBudgetExceeded(used: number, budget: number): McpError {
  return new McpError(
    "CHAIN_004",
    "chain",
    `Compute budget exceeded: used ${used} CU, budget ${budget} CU`,
    `The transaction consumed ${used} compute units but the budget was only ${budget} CU. Complex transactions (e.g. those involving multiple programs or large data) require more compute units. The system will automatically retry with an increased compute budget.`,
    [
      {
        action: "retry_higher_cu",
        description: `Auto-retrying with an increased compute budget (${Math.ceil(used * 1.25)} CU recommended)`,
      },
    ],
    true,
  );
}

export function programError(program: string, errorCode: number, decodedMessage: string): McpError {
  return new McpError(
    "CHAIN_005",
    "chain",
    `Program error from ${program}: ${decodedMessage} (code ${errorCode})`,
    `The on-chain program "${program}" returned error code ${errorCode}: "${decodedMessage}". This is a logic-level rejection from the smart contract itself, meaning the transaction was valid structurally but the program's business logic rejected it. Check the program's documentation for error code ${errorCode}.`,
    [
      {
        action: "check_program_docs",
        description: `Review the ${program} program documentation for error code ${errorCode}`,
      },
      {
        action: "inspect_inputs",
        description: "Verify your transaction inputs match what the program expects",
      },
    ],
    false,
    undefined,
    { raw: `${program} error ${errorCode}: ${decodedMessage}`, program_id: program },
  );
}

export function nonceTooLow(nonce: number): McpError {
  return new McpError(
    "CHAIN_006",
    "chain",
    `Nonce too low: ${nonce}`,
    `The transaction nonce ${nonce} has already been used or is below the current expected nonce. This can happen if a previous transaction was submitted concurrently or if the nonce was fetched before a recent transaction confirmed. The system will automatically re-fetch the current nonce and retry.`,
    [
      {
        action: "refetch_nonce",
        description: "Auto-retrying after re-fetching the current on-chain nonce",
      },
    ],
    true,
  );
}

// POLICY errors

export function spendingLimitExceeded(period: string, limit: string, used: string, amount: string): McpError {
  const remaining = (parseFloat(limit) - parseFloat(used)).toFixed(6);
  return new McpError(
    "POL_001",
    "policy",
    `Spending limit exceeded for ${period} period`,
    `This transaction of ${amount} ETO would exceed your ${period} spending limit of ${limit} ETO. You have already spent ${used} ETO this ${period}, leaving only ${remaining} ETO available. Spending limits are configured in your session policy to prevent runaway spending by automated agents.`,
    [
      {
        action: "reduce_amount",
        description: `Reduce the transaction amount to at most ${remaining} ETO`,
      },
      {
        action: "wait_for_reset",
        description: `Wait for the ${period} spending limit to reset before sending larger amounts`,
      },
      {
        action: "update_policy",
        description: "Contact your administrator to increase the spending limit for your session",
      },
    ],
    false,
  );
}

export function toolNotPermitted(tool: string, allowed: string[]): McpError {
  return new McpError(
    "POL_002",
    "policy",
    `Tool not permitted: ${tool}`,
    `The tool "${tool}" is not allowed in the current session policy. Your session is restricted to the following tools: [${allowed.join(", ")}]. This restriction is enforced to limit what automated agents can do on your behalf.`,
    [
      {
        action: "use_allowed_tool",
        description: `Use one of the permitted tools instead: ${allowed.join(", ")}`,
      },
      {
        action: "request_permission",
        description: `Request a new session that permits the "${tool}" tool`,
        tool: "authenticate",
        params: { permitted_tools: [...allowed, tool] },
      },
    ],
    false,
  );
}

// SIGNING errors

export function signingServiceUnavailable(): McpError {
  return new McpError(
    "SIGN_001",
    "signing",
    "Signing service is temporarily unavailable",
    "The signing service responsible for authorizing transactions is not reachable right now. This is usually a transient network or service issue. The system will automatically retry after a short delay.",
    [
      {
        action: "retry",
        description: "Auto-retrying after 2000ms — no action needed",
      },
    ],
    true,
    2000,
  );
}

// SIMULATION errors

export function simulationFailed(reason: string): McpError {
  return new McpError(
    "SIM_001",
    "chain",
    `Transaction simulation failed: ${reason}`,
    `The transaction was simulated before submission and the simulation failed with: "${reason}". This means the transaction would fail if submitted to the chain. The transaction has not been broadcast. Review the reason above and correct your inputs before retrying.`,
    [
      {
        action: "review_inputs",
        description: "Review the simulation failure reason and correct your transaction parameters",
      },
      {
        action: "skip_simulation",
        description: "If you believe the simulation result is a false positive, retry with simulation disabled (not recommended)",
      },
    ],
    false,
  );
}
