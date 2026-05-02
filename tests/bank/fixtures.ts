/**
 * Shared fixtures for the FN-123 bank account lifecycle test.
 *
 * Provides:
 *   - Stable hex pubkeys (HOLDER_PUBKEY, BANK_ISSUER_PUBKEY)
 *   - MockChainState — in-memory simulation of on-chain accounts
 *   - deposit() / withdraw() — simulated eUSD instructions (FN-117 / FN-118)
 *   - transferToSavings() — move eUSD from checking → savings
 *   - totalEusd() — conservation invariant helper
 *   - makeDeps — factory functions for each handler's deps wired to state
 *   - cred() / cardWith() / loaderFor() helpers (adapted from cred-gate.test.ts)
 *   - INITIAL_MINT_ATOMIC — starting eUSD balance for the holder
 */

import { createHash } from "node:crypto";

import type {
  AgentCardSnapshot,
  HeldCredentialSnapshot,
} from "../../keeper/templates/bpp/types.js";
import type { AgentCardLoader } from "../../keeper/templates/bpp/credential-gate.js";
import type {
  OpenCheckingDeps,
  OpenCheckingResult,
} from "../../keeper/bpps/bank/handlers/open-checking.js";
import type {
  OpenSavingsDeps,
} from "../../keeper/bpps/bank/handlers/open-savings.js";
import type {
  WireDeps,
  WireKind,
} from "../../keeper/bpps/bank/handlers/wire.js";
import type {
  SavingsAccount,
  YieldDeps,
} from "../../keeper/bpps/bank/yield.js";

/* -------------------------------------------------------------------------- */
/* Stable pubkeys (64-char lowercase hex)                                     */
/* -------------------------------------------------------------------------- */

/** Simulated holder (BAP) pubkey. */
export const HOLDER_PUBKEY = "11".repeat(32); // 64 chars

/** Simulated bank issuer (BPP) pubkey. */
export const BANK_ISSUER_PUBKEY = "22".repeat(32); // 64 chars

/* -------------------------------------------------------------------------- */
/* Monetary constants                                                         */
/* -------------------------------------------------------------------------- */

/** 1 eUSD = 1_000_000 atomic units (6 decimal places). */
export const ONE_EUSD = 1_000_000n;

/**
 * Starting eUSD balance minted to the holder.
 * 500 eUSD — enough for deposit, wire, and savings transfer with headroom.
 */
export const INITIAL_MINT_ATOMIC = 500n * ONE_EUSD; // 500_000_000n

/** Deposit amount: 100 eUSD into checking. */
export const DEPOSIT_AMOUNT = 100n * ONE_EUSD;

/** Withdrawal amount: 20 eUSD out of checking. */
export const WITHDRAW_AMOUNT = 20n * ONE_EUSD;

/** Wire amount: 10 eUSD domestic wire. */
export const WIRE_AMOUNT = 10n * ONE_EUSD;

/** Wire fee: 5 eUSD (domestic flat fee per wire.ts stubs). */
export const WIRE_FEE = 5n * ONE_EUSD;

/** Savings transfer: 50 eUSD from checking → savings. */
export const SAVINGS_TRANSFER = 50n * ONE_EUSD;

/* -------------------------------------------------------------------------- */
/* Mock chain state                                                           */
/* -------------------------------------------------------------------------- */

export interface MockChainState {
  /** Holder's eUSD wallet balance (atomic units). */
  walletBalance: bigint;

  /** Checking account PDA (hex), null until openChecking is called. */
  checkingPda: string | null;
  /** Checking account balance (atomic units). */
  checkingBalance: bigint;
  /** Checking account holder pubkey. */
  checkingHolder: string | null;
  /** Checking account opened_slot. */
  checkingOpenedSlot: number;

  /** Savings account PDA (hex), null until openSavings is called. */
  savingsPda: string | null;
  /** Savings account balance (atomic units). */
  savingsBalance: bigint;
  /** Savings account APY in basis points. */
  savingsApyBps: number;
  /** Savings account last_accrual_period. */
  savingsLastAccrualPeriod: number;

  /** Wire escrow balance (amount + fee locked, atomic units). */
  wireEscrowBalance: bigint;
  /** Cumulative amount wired out (amount + fee transferred, atomic units). */
  wiredOutBalance: bigint;

  /** Issued account.checking credential body, null until issued. */
  checkingCredential: OpenCheckingResult["credential"] | null;
  /** Issued account.savings credential body, null until issued. */
  savingsCredential: unknown | null;

  /** Wire IDs that have been locked. */
  lockedWireIds: Set<string>;
}

/** Create a fresh mock chain state with holder pre-seeded with eUSD. */
export function makeInitialState(): MockChainState {
  return {
    walletBalance: INITIAL_MINT_ATOMIC,

    checkingPda: null,
    checkingBalance: 0n,
    checkingHolder: null,
    checkingOpenedSlot: 0,

    savingsPda: null,
    savingsBalance: 0n,
    savingsApyBps: 400,
    savingsLastAccrualPeriod: 0,

    wireEscrowBalance: 0n,
    wiredOutBalance: 0n,

    checkingCredential: null,
    savingsCredential: null,

    lockedWireIds: new Set(),
  };
}

/* -------------------------------------------------------------------------- */
/* Conservation invariant                                                     */
/* -------------------------------------------------------------------------- */

/**
 * Sum all on-chain buckets.
 *
 * For pure transfer operations (deposit / withdraw / wire / savings transfer)
 * this value MUST equal INITIAL_MINT_ATOMIC, proving no eUSD is created or
 * destroyed.
 *
 * Yield accrual intentionally increases this total (the v0 engine mints yield
 * ex nihilo from a simulated treasury).  The lifecycle test asserts the yield
 * delta separately via `applyYield`.
 */
export function totalEusd(state: MockChainState): bigint {
  return (
    state.walletBalance +
    state.checkingBalance +
    state.savingsBalance +
    state.wireEscrowBalance +
    state.wiredOutBalance
  );
}

/* -------------------------------------------------------------------------- */
/* Simulated on-chain instructions (FN-117 / FN-118)                         */
/*                                                                             */
/* The deposit.rs / withdraw.rs Rust instructions are not yet landed (FN-117  */
/* / FN-118 are not complete).  These helpers simulate what those instructions */
/* would do: an atomic transfer between the holder wallet and the checking     */
/* account, enforcing balance constraints.                                     */
/* -------------------------------------------------------------------------- */

/** Simulate eUSD Deposit instruction: wallet → checking. */
export function deposit(state: MockChainState, amount: bigint): void {
  if (amount <= 0n) throw new Error("deposit: amount must be > 0");
  if (state.walletBalance < amount) {
    throw new Error(
      `deposit: insufficient wallet balance (have ${state.walletBalance}, want ${amount})`,
    );
  }
  state.walletBalance -= amount;
  state.checkingBalance += amount;
}

/** Simulate eUSD Withdraw instruction: checking → wallet. */
export function withdraw(state: MockChainState, amount: bigint): void {
  if (amount <= 0n) throw new Error("withdraw: amount must be > 0");
  if (state.checkingBalance < amount) {
    throw new Error(
      `withdraw: insufficient checking balance (have ${state.checkingBalance}, want ${amount})`,
    );
  }
  state.checkingBalance -= amount;
  state.walletBalance += amount;
}

/**
 * Attempt to overdraw from checking; expected to throw.
 * Returns the error thrown (for assertion), or throws if no error was raised.
 */
export function tryOverdrawChecking(
  state: MockChainState,
  amount: bigint,
): Error {
  try {
    withdraw(state, amount);
    throw new Error("expected an overdraw error but none was thrown");
  } catch (err) {
    if (!(err instanceof Error)) throw err;
    if (err.message.startsWith("expected")) throw err;
    return err;
  }
}

/** Transfer eUSD from checking → savings (simulated internal move). */
export function transferToSavings(
  state: MockChainState,
  amount: bigint,
): void {
  if (amount <= 0n) throw new Error("transferToSavings: amount must be > 0");
  if (state.checkingBalance < amount) {
    throw new Error(
      `transferToSavings: insufficient checking balance (have ${state.checkingBalance}, want ${amount})`,
    );
  }
  state.checkingBalance -= amount;
  state.savingsBalance += amount;
}

/* -------------------------------------------------------------------------- */
/* Build SavingsAccount object from state (for yield engine calls)           */
/* -------------------------------------------------------------------------- */

export function buildSavingsAccount(state: MockChainState): SavingsAccount {
  if (!state.savingsPda) throw new Error("savings account not yet opened");
  return {
    pda: state.savingsPda,
    holder: HOLDER_PUBKEY,
    balance: state.savingsBalance,
    opened_slot: state.checkingOpenedSlot,
    apy_bps: state.savingsApyBps,
    last_accrual_period: state.savingsLastAccrualPeriod,
  };
}

/* -------------------------------------------------------------------------- */
/* Handler deps wired to mock state                                           */
/* -------------------------------------------------------------------------- */

function detSig(...parts: string[]): string {
  return createHash("sha256")
    .update(parts.join("|"))
    .digest("hex")
    .slice(0, 64);
}

/**
 * Build `openChecking` deps that read/write to `state`.
 *
 * `credentialSchemas` is the set of schema IDs the holder is deemed to hold;
 * used by `verifyHolderCredentials` to simulate the on-chain credential gate.
 */
export function makeOpenCheckingDeps(
  state: MockChainState,
  credentialSchemas: ReadonlySet<string>,
): OpenCheckingDeps {
  return {
    verifyHolderCredentials: async (_subject, schemas) => {
      return schemas.every((s) => credentialSchemas.has(s));
    },
    issueCheckingCredential: async (cred) => {
      state.checkingCredential = cred;
      const tx_signature = detSig("checking-cred", cred.subject);
      const credential_pda = detSig("checking-cred-pda", cred.subject);
      return { tx_signature, credential_pda };
    },
    recordCheckingAccount: async (pda, account) => {
      state.checkingPda = pda;
      state.checkingHolder = account.holder;
      state.checkingOpenedSlot = account.opened_slot;
      state.checkingBalance = BigInt(account.opening_balance);
    },
  };
}

/**
 * Build `openSavings` deps that read/write to `state`.
 *
 * `hasCheckingCred` controls whether `verifyCheckingCredential` succeeds.
 */
export function makeOpenSavingsDeps(
  state: MockChainState,
  hasCheckingCred: () => boolean,
): OpenSavingsDeps {
  return {
    verifyCheckingCredential: async (_subject, _pda) => hasCheckingCred(),
    issueSavingsCredential: async (cred) => {
      state.savingsCredential = cred;
      const tx_signature = detSig("savings-cred", cred.subject);
      const credential_pda = detSig("savings-cred-pda", cred.subject);
      return { tx_signature, credential_pda };
    },
    recordSavingsAccount: async (pda, account) => {
      state.savingsPda = pda;
      state.savingsApyBps = account.apy_bps;
    },
  };
}

/**
 * Build `executeWire` deps that read/write to `state`.
 * Uses the same flat-fee schedule as `wire.ts` stubs (domestic 5 eUSD,
 * international 25 eUSD) so the conservation maths match exactly.
 */
export function makeWireDeps(state: MockChainState): WireDeps {
  return {
    feeFor: (kind: WireKind, _amount: number) =>
      kind === "domestic" ? 5_000_000 : 25_000_000,

    lockEscrow: async ({ amount, fee, wire_id }) => {
      const total = BigInt(amount + fee);
      if (state.checkingBalance < total) {
        throw new Error(
          `lockEscrow: insufficient checking balance (${state.checkingBalance} < ${total})`,
        );
      }
      state.checkingBalance -= total;
      state.wireEscrowBalance += total;
      state.lockedWireIds.add(wire_id);
      const tx_signature = detSig("lock", wire_id);
      return { tx_signature };
    },

    releaseEscrow: async ({ wire_id, amount }) => {
      // Full escrow (amount + fee) moves to wiredOut on release.
      const total = state.wireEscrowBalance;
      state.wireEscrowBalance = 0n;
      state.wiredOutBalance += total;
      const external_ref = detSig("ext", wire_id).slice(0, 16);
      const confirmed_at_slot = 7000;
      void amount; // amount is informational only in mock
      return { external_ref, confirmed_at_slot };
    },

    refundEscrow: async ({ wire_id, amount, fee }) => {
      const total = BigInt(amount + fee);
      state.wireEscrowBalance -= total;
      state.checkingBalance += total;
      const tx_signature = detSig("refund", wire_id);
      return { tx_signature };
    },
  };
}

/** Build `YieldDeps` wired to `state`. `currentPeriod` is injected externally. */
export function makeYieldDeps(
  state: MockChainState,
  currentPeriod: () => number,
): YieldDeps {
  return {
    currentPeriod,
    commitYieldOnChain: async (account_pda, new_balance, period_index) => {
      if (state.savingsPda === account_pda) {
        state.savingsBalance = new_balance;
        state.savingsLastAccrualPeriod = period_index;
      }
      const tx_signature = detSig("yield", account_pda, String(period_index));
      return { tx_signature };
    },
  };
}

/* -------------------------------------------------------------------------- */
/* Credential-gate helpers (adapted from tests/unit/cred-gate.test.ts)       */
/* -------------------------------------------------------------------------- */

/**
 * Build a minimal `HeldCredentialSnapshot` with sensible defaults.
 * Pass `overrides` for any field you need to customise.
 */
export function cred(
  overrides: Partial<HeldCredentialSnapshot> = {},
): HeldCredentialSnapshot {
  return {
    schema: "a".repeat(64),
    predicateHash: "0".repeat(64),
    issuer: BANK_ISSUER_PUBKEY,
    validFrom: 0,
    validUntil: 0,
    revoked: false,
    ...overrides,
  };
}

/** Build an `AgentCardSnapshot` holding the given credentials. */
export function cardWith(
  credentials: readonly HeldCredentialSnapshot[],
): AgentCardSnapshot {
  return { authority: HOLDER_PUBKEY, credentials };
}

/** Build an `AgentCardLoader` that returns the given card. */
export function loaderFor(card: AgentCardSnapshot): AgentCardLoader {
  return async () => card;
}
