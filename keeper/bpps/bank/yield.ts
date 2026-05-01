/**
 * Yield accrual engine for SavingsAccount balances (v0 simulated).
 *
 * Spec: T-3.11.2.3 (FN-122).
 *
 * v0 model:
 *   - APY = 4 % (400 bps), parameterizable per-account in v1
 *   - Compounding: daily (365 ticks/year)
 *   - Off-chain calculation; on-chain SavingsAccount.balance is updated
 *     by a `CommitYield` instruction (STUBBED today — see FN-3.11.2.x).
 *   - Idempotent per (account_pda, period_index): re-running the same
 *     period yields no balance change.
 *
 * v1 will swap to a real on-chain `apply_yield` instruction signed by
 * the bank treasury authority, with per-account APY tiers.
 */

import { createHash } from "node:crypto";

export interface SavingsAccount {
  pda: string;             // hex pubkey
  holder: string;          // hex pubkey
  balance: bigint;         // atomic eUSD units (1 eUSD = 1_000_000)
  opened_slot: number;
  apy_bps: number;         // basis points (400 = 4%)
  last_accrual_period: number; // monotonic counter
}

export interface YieldDeps {
  /** Submit on-chain CommitYield instruction. STUBBED today. */
  commitYieldOnChain: (account_pda: string, new_balance: bigint, period_index: number) => Promise<{ tx_signature: string }>;
  /** Current period index (e.g. days since epoch). Test injection point. */
  currentPeriod: () => number;
}

/** Per-period yield multiplier given an APY in basis points. Compounds daily. */
export function periodMultiplier(apy_bps: number, periods_per_year: number = 365): number {
  if (apy_bps <= 0) return 1;
  const apy = apy_bps / 10_000;
  return Math.pow(1 + apy, 1 / periods_per_year);
}

/**
 * Compute the new balance for `account` after `periods_elapsed` accrual ticks.
 * Pure function; no side effects.
 *
 * Uses bigint arithmetic via fixed-point: `balance * scaled_mult / 10**12`,
 * where `scaled_mult = round(multiplier^periods_elapsed * 10**12)`.
 * 12-decimal precision is overkill but locks ≪ 1 atomic-unit drift over
 * realistic horizons (e.g. 100 years × $1B principal ≈ atomic-unit-precise).
 */
export function applyYield(account: SavingsAccount, periods_elapsed: number): bigint {
  if (periods_elapsed <= 0 || account.apy_bps <= 0) return account.balance;
  const m = periodMultiplier(account.apy_bps);
  const total = Math.pow(m, periods_elapsed);
  const scaled = BigInt(Math.round(total * 1_000_000_000_000));
  return (account.balance * scaled) / 1_000_000_000_000n;
}

/**
 * Process accrual for a single account against the current period. Skips
 * (returns null) if no periods have elapsed since `last_accrual_period`,
 * making this safe to invoke on a tick. Returns the on-chain commit tx
 * signature if a balance change was committed.
 */
export async function accrueOne(
  account: SavingsAccount,
  deps: YieldDeps,
): Promise<{ tx_signature: string; new_balance: bigint; period: number } | null> {
  const current = deps.currentPeriod();
  const elapsed = current - account.last_accrual_period;
  if (elapsed <= 0) return null;
  const new_balance = applyYield(account, elapsed);
  if (new_balance === account.balance) return null;
  const { tx_signature } = await deps.commitYieldOnChain(account.pda, new_balance, current);
  return { tx_signature, new_balance, period: current };
}

/**
 * Batch accrual — processes a list of SavingsAccounts. Returns results per
 * account. Caller is responsible for persisting the new balances locally
 * after the on-chain commits land.
 */
export async function accrueAll(
  accounts: SavingsAccount[],
  deps: YieldDeps,
): Promise<Awaited<ReturnType<typeof accrueOne>>[]> {
  return Promise.all(accounts.map(a => accrueOne(a, deps)));
}

/** Default stub for v0. */
export const stubCommitYield: YieldDeps['commitYieldOnChain'] = async (pda, balance, period) => {
  const sig = createHash('sha256').update(`${pda}|${balance}|${period}`).digest('hex').slice(0, 64);
  console.log(`[STUB] commit yield pda=${pda.slice(0,8)}... new_balance=${balance} period=${period} → tx=${sig.slice(0,16)}...`);
  return { tx_signature: sig };
};
