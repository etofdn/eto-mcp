import { describe, test, expect, beforeAll } from "bun:test";
import { attemptRecovery, formatRecovery } from "../../src/write/error-recovery.js";
import { blockhashCache } from "../../src/write/blockhash-cache.js";
import {
  sessionExpired,
  insufficientCapabilities,
  invalidAddress,
  amountExceedsBalance,
  invalidAmount,
  blockhashExpired,
  accountNotFound,
  insufficientFundsForFee,
  computeBudgetExceeded,
  programError,
  nonceTooLow,
  spendingLimitExceeded,
  toolNotPermitted,
  signingServiceUnavailable,
  simulationFailed,
} from "../../src/errors/chain-errors.js";
import { McpError } from "../../src/errors/index.js";

// Pre-seed blockhash cache so attemptRecovery doesn't hit the network
beforeAll(() => {
  // @ts-ignore — accessing private field to seed cache for tests
  (blockhashCache as any).current = { blockhash: "test-blockhash", lastValidBlockHeight: 99999 };
  // @ts-ignore
  (blockhashCache as any).fetchedAt = Date.now();
});

describe("attemptRecovery - BlockhashNotFound", () => {
  test("recognizes BlockhashNotFound and returns blockhash_refresh strategy", async () => {
    const result = await attemptRecovery("BlockhashNotFound: the transaction blockhash is invalid");
    expect(result.strategy).toBe("blockhash_refresh");
    expect(result.retryRecommended).toBe(true);
  });

  test("recognizes lowercase blockhash error", async () => {
    const result = await attemptRecovery("invalid blockhash provided");
    expect(result.strategy).toBe("blockhash_refresh");
  });
});

describe("attemptRecovery - NonceTooLow", () => {
  test("recognizes NonceTooLow and returns nonce_reset strategy", async () => {
    const result = await attemptRecovery("NonceTooLow: nonce has already been used");
    expect(result.strategy).toBe("nonce_reset");
    expect(result.retryRecommended).toBe(true);
  });

  test("recognizes lowercase nonce too low error", async () => {
    const result = await attemptRecovery("nonce too low");
    expect(result.strategy).toBe("nonce_reset");
  });
});

describe("attemptRecovery - InsufficientFunds", () => {
  test("recognizes InsufficientFunds and returns insufficient_funds strategy", async () => {
    const result = await attemptRecovery("InsufficientFunds: not enough balance");
    expect(result.strategy).toBe("insufficient_funds");
    expect(result.recovered).toBe(false);
  });

  test("recognizes lowercase insufficient error", async () => {
    const result = await attemptRecovery("insufficient funds for transaction");
    expect(result.strategy).toBe("insufficient_funds");
  });

  test("on testnet with wallet address suggests airdrop", async () => {
    // config.network defaults to 'testnet' in test env
    const result = await attemptRecovery("InsufficientFunds", {
      walletAddress: "SomeWalletAddr123",
    });
    expect(result.strategy).toBe("insufficient_funds");
    expect(result.explanation).toContain("airdrop");
  });

  test("without wallet address suggests reduce amount", async () => {
    const result = await attemptRecovery("InsufficientFunds");
    expect(result.strategy).toBe("insufficient_funds");
    expect(result.explanation).toContain("Reduce");
  });
});

describe("attemptRecovery - AccountNotFound", () => {
  test("recognizes AccountNotFound and returns account_creation strategy", async () => {
    const result = await attemptRecovery("AccountNotFound: account does not exist on chain");
    expect(result.strategy).toBe("account_creation");
    expect(result.retryRecommended).toBe(true);
  });

  test("recognizes account does not exist error", async () => {
    const result = await attemptRecovery("account does not exist at this address");
    expect(result.strategy).toBe("account_creation");
  });
});

describe("attemptRecovery - ComputeExhausted", () => {
  test("recognizes ComputeExhausted and returns increase_compute strategy", async () => {
    const result = await attemptRecovery("ComputeExhausted: transaction used too many compute units");
    expect(result.strategy).toBe("increase_compute");
    expect(result.recovered).toBe(false);
  });

  test("recognizes compute budget error", async () => {
    const result = await attemptRecovery("compute budget exceeded");
    expect(result.strategy).toBe("increase_compute");
  });
});

describe("attemptRecovery - SignatureVerification", () => {
  test("recognizes SignatureVerification and returns signature_error strategy", async () => {
    const result = await attemptRecovery("SignatureVerification: invalid signature");
    expect(result.strategy).toBe("signature_error");
    expect(result.recovered).toBe(false);
    expect(result.retryRecommended).toBe(false);
  });

  test("recognizes lowercase signature verification error", async () => {
    const result = await attemptRecovery("signature verification failed");
    expect(result.strategy).toBe("signature_error");
  });
});

describe("attemptRecovery - unknown error", () => {
  test("returns unknown strategy for unrecognized error", async () => {
    const result = await attemptRecovery("some completely unknown blockchain error xyz");
    expect(result.strategy).toBe("unknown");
    expect(result.recovered).toBe(false);
  });
});

describe("formatRecovery", () => {
  test("formats recovered result correctly", () => {
    const result = {
      recovered: true,
      strategy: "blockhash_refresh",
      explanation: "Refreshed blockhash.",
      retryRecommended: true,
    };
    const text = formatRecovery(result);
    expect(text).toContain("Automatic");
    expect(text).toContain("blockhash_refresh");
    expect(text).toContain("Refreshed blockhash.");
    expect(text).toContain("Retry");
  });

  test("formats manual recovery correctly", () => {
    const result = {
      recovered: false,
      strategy: "insufficient_funds",
      explanation: "Not enough balance.",
      retryRecommended: false,
    };
    const text = formatRecovery(result);
    expect(text).toContain("Manual action needed");
    expect(text).toContain("insufficient_funds");
    expect(text).not.toContain("Retry");
  });
});

describe("chain error factory functions - McpError properties", () => {
  test("sessionExpired returns McpError with code AUTH_001", () => {
    const err = sessionExpired();
    expect(err).toBeInstanceOf(McpError);
    expect(err.code).toBe("AUTH_001");
    expect(err.category).toBe("auth");
    expect(err.retryable).toBe(false);
  });

  test("insufficientCapabilities returns McpError with code AUTH_002", () => {
    const err = insufficientCapabilities(["transfer:write"], ["wallet:read"]);
    expect(err).toBeInstanceOf(McpError);
    expect(err.code).toBe("AUTH_002");
    expect(err.category).toBe("auth");
    expect(err.retryable).toBe(false);
    expect(err.message).toContain("transfer:write");
  });

  test("invalidAddress returns McpError with code VAL_001", () => {
    const err = invalidAddress("bad-address");
    expect(err).toBeInstanceOf(McpError);
    expect(err.code).toBe("VAL_001");
    expect(err.category).toBe("validation");
    expect(err.retryable).toBe(false);
    expect(err.message).toContain("bad-address");
  });

  test("amountExceedsBalance returns McpError with code VAL_002", () => {
    const err = amountExceedsBalance("100", "50", "50");
    expect(err).toBeInstanceOf(McpError);
    expect(err.code).toBe("VAL_002");
    expect(err.category).toBe("validation");
    expect(err.retryable).toBe(false);
  });

  test("invalidAmount returns McpError with code VAL_003", () => {
    const err = invalidAmount("negative number");
    expect(err).toBeInstanceOf(McpError);
    expect(err.code).toBe("VAL_003");
    expect(err.category).toBe("validation");
    expect(err.retryable).toBe(false);
  });

  test("blockhashExpired returns McpError with code CHAIN_001 and retryable=true", () => {
    const err = blockhashExpired();
    expect(err).toBeInstanceOf(McpError);
    expect(err.code).toBe("CHAIN_001");
    expect(err.category).toBe("chain");
    expect(err.retryable).toBe(true);
  });

  test("accountNotFound returns McpError with code CHAIN_002 and retryable=true", () => {
    const err = accountNotFound("SomeAddr");
    expect(err).toBeInstanceOf(McpError);
    expect(err.code).toBe("CHAIN_002");
    expect(err.category).toBe("chain");
    expect(err.retryable).toBe(true);
    expect(err.message).toContain("SomeAddr");
  });

  test("insufficientFundsForFee returns McpError with code CHAIN_003", () => {
    const err = insufficientFundsForFee("0.001", "0.0005");
    expect(err).toBeInstanceOf(McpError);
    expect(err.code).toBe("CHAIN_003");
    expect(err.category).toBe("chain");
    expect(err.retryable).toBe(false);
  });

  test("computeBudgetExceeded returns McpError with code CHAIN_004 and retryable=true", () => {
    const err = computeBudgetExceeded(500000, 200000);
    expect(err).toBeInstanceOf(McpError);
    expect(err.code).toBe("CHAIN_004");
    expect(err.category).toBe("chain");
    expect(err.retryable).toBe(true);
  });

  test("programError returns McpError with code CHAIN_005", () => {
    const err = programError("TokenProgram", 42, "InvalidAccountData");
    expect(err).toBeInstanceOf(McpError);
    expect(err.code).toBe("CHAIN_005");
    expect(err.category).toBe("chain");
    expect(err.retryable).toBe(false);
    expect(err.message).toContain("TokenProgram");
    expect(err.message).toContain("42");
  });

  test("nonceTooLow returns McpError with code CHAIN_006 and retryable=true", () => {
    const err = nonceTooLow(5);
    expect(err).toBeInstanceOf(McpError);
    expect(err.code).toBe("CHAIN_006");
    expect(err.category).toBe("chain");
    expect(err.retryable).toBe(true);
    expect(err.message).toContain("5");
  });

  test("spendingLimitExceeded returns McpError with code POL_001", () => {
    const err = spendingLimitExceeded("day", "100", "90", "20");
    expect(err).toBeInstanceOf(McpError);
    expect(err.code).toBe("POL_001");
    expect(err.category).toBe("policy");
    expect(err.retryable).toBe(false);
  });

  test("toolNotPermitted returns McpError with code POL_002", () => {
    const err = toolNotPermitted("deploy_contract", ["get_balance", "transfer"]);
    expect(err).toBeInstanceOf(McpError);
    expect(err.code).toBe("POL_002");
    expect(err.category).toBe("policy");
    expect(err.retryable).toBe(false);
    expect(err.message).toContain("deploy_contract");
  });

  test("signingServiceUnavailable returns McpError with code SIGN_001 and retryable=true", () => {
    const err = signingServiceUnavailable();
    expect(err).toBeInstanceOf(McpError);
    expect(err.code).toBe("SIGN_001");
    expect(err.category).toBe("signing");
    expect(err.retryable).toBe(true);
    expect(err.retryAfterMs).toBe(2000);
  });

  test("simulationFailed returns McpError with code SIM_001", () => {
    const err = simulationFailed("insufficient funds");
    expect(err).toBeInstanceOf(McpError);
    expect(err.code).toBe("SIM_001");
    expect(err.category).toBe("chain");
    expect(err.retryable).toBe(false);
    expect(err.message).toContain("insufficient funds");
  });

  test("McpError.toJSON returns structured object", () => {
    const err = sessionExpired();
    const json = err.toJSON();
    expect(json.code).toBe("AUTH_001");
    expect(json.category).toBe("auth");
    expect(json.retryable).toBe(false);
    expect(Array.isArray(json.recovery)).toBe(true);
  });
});
