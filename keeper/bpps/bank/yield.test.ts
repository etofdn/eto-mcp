/**
 * Tests for the v0 yield accrual engine (FN-122 / T-3.11.2.3).
 */

import { describe, it, expect, vi } from "vitest";
import {
  periodMultiplier,
  applyYield,
  accrueOne,
  accrueAll,
  stubCommitYield,
  type SavingsAccount,
  type YieldDeps,
} from "./yield.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeAccount(overrides: Partial<SavingsAccount> = {}): SavingsAccount {
  return {
    pda: "aabbccddeeff00112233445566778899aabbccddeeff00112233445566778899",
    holder: "0011223344556677889900aabbccddee0011223344556677889900aabbccddee",
    balance: 1_000_000_000n, // 1000 eUSD (1 eUSD = 1_000_000 atomic units)
    opened_slot: 0,
    apy_bps: 400,
    last_accrual_period: 0,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// periodMultiplier
// ---------------------------------------------------------------------------

describe("periodMultiplier", () => {
  it("raised to 365 periods approximates 1.04 (4% APY round-trip)", () => {
    const m = periodMultiplier(400);
    const annual = Math.pow(m, 365);
    expect(annual).toBeCloseTo(1.04, 8);
  });

  it("returns 1 for apy_bps = 0", () => {
    expect(periodMultiplier(0)).toBe(1);
  });

  it("returns 1 for negative apy_bps", () => {
    expect(periodMultiplier(-100)).toBe(1);
  });

  it("respects custom periods_per_year", () => {
    // Monthly compounding: 12 periods/year. (1+0.04)^(1/12) should give 1.04 over 12 periods.
    const m = periodMultiplier(400, 12);
    const annual = Math.pow(m, 12);
    expect(annual).toBeCloseTo(1.04, 8);
  });
});

// ---------------------------------------------------------------------------
// applyYield
// ---------------------------------------------------------------------------

describe("applyYield", () => {
  it("returns unchanged balance for 0 periods_elapsed", () => {
    const account = makeAccount({ balance: 1_000_000_000n });
    expect(applyYield(account, 0)).toBe(1_000_000_000n);
  });

  it("returns unchanged balance for negative periods_elapsed", () => {
    const account = makeAccount({ balance: 1_000_000_000n });
    expect(applyYield(account, -5)).toBe(1_000_000_000n);
  });

  it("returns unchanged balance when apy_bps is 0", () => {
    const account = makeAccount({ balance: 1_000_000_000n, apy_bps: 0 });
    expect(applyYield(account, 365)).toBe(1_000_000_000n);
  });

  it("$1000 principal over 365 periods at 4% APY yields ~$1040 (within 1 atomic unit)", () => {
    // 1000 eUSD = 1_000_000_000 atomic units (1 eUSD = 1_000_000)
    const account = makeAccount({ balance: 1_000_000_000n, apy_bps: 400 });
    const result = applyYield(account, 365);
    // expected: 1_040_000_000 (1040 eUSD)
    const expected = 1_040_000_000n;
    const diff = result > expected ? result - expected : expected - result;
    expect(diff).toBeLessThanOrEqual(1n);
    // Also verify direction: result should be > original balance
    expect(result).toBeGreaterThan(account.balance);
  });

  it("produces larger balance for more periods", () => {
    const account = makeAccount({ balance: 1_000_000_000n, apy_bps: 400 });
    const after1 = applyYield(account, 1);
    const after365 = applyYield(account, 365);
    expect(after365).toBeGreaterThan(after1);
  });
});

// ---------------------------------------------------------------------------
// accrueOne
// ---------------------------------------------------------------------------

describe("accrueOne", () => {
  it("returns null when currentPeriod === last_accrual_period (no elapsed periods)", async () => {
    const account = makeAccount({ last_accrual_period: 100 });
    const deps: YieldDeps = {
      commitYieldOnChain: vi.fn(),
      currentPeriod: () => 100,
    };
    const result = await accrueOne(account, deps);
    expect(result).toBeNull();
    expect(deps.commitYieldOnChain).not.toHaveBeenCalled();
  });

  it("returns null when currentPeriod < last_accrual_period", async () => {
    const account = makeAccount({ last_accrual_period: 100 });
    const deps: YieldDeps = {
      commitYieldOnChain: vi.fn(),
      currentPeriod: () => 99,
    };
    const result = await accrueOne(account, deps);
    expect(result).toBeNull();
    expect(deps.commitYieldOnChain).not.toHaveBeenCalled();
  });

  it("commits when periods have elapsed and returns tx_signature + new_balance + period", async () => {
    const account = makeAccount({ last_accrual_period: 0, balance: 1_000_000_000n, apy_bps: 400 });
    const mockSig = "deadbeef1234";
    const deps: YieldDeps = {
      commitYieldOnChain: vi.fn().mockResolvedValue({ tx_signature: mockSig }),
      currentPeriod: () => 365,
    };
    const result = await accrueOne(account, deps);
    expect(result).not.toBeNull();
    expect(result!.tx_signature).toBe(mockSig);
    expect(result!.period).toBe(365);
    expect(result!.new_balance).toBeGreaterThan(account.balance);
    expect(deps.commitYieldOnChain).toHaveBeenCalledOnce();
    expect(deps.commitYieldOnChain).toHaveBeenCalledWith(
      account.pda,
      result!.new_balance,
      365,
    );
  });

  it("tx_signature is deterministic for the same inputs (via stubCommitYield)", async () => {
    const account = makeAccount({ last_accrual_period: 0, balance: 1_000_000_000n, apy_bps: 400 });
    const deps: YieldDeps = {
      commitYieldOnChain: stubCommitYield,
      currentPeriod: () => 365,
    };
    const result1 = await accrueOne(account, deps);
    const result2 = await accrueOne(account, deps);
    expect(result1).not.toBeNull();
    expect(result2).not.toBeNull();
    expect(result1!.tx_signature).toBe(result2!.tx_signature);
  });
});

// ---------------------------------------------------------------------------
// accrueAll
// ---------------------------------------------------------------------------

describe("accrueAll", () => {
  it("returns one result per account in input order", async () => {
    const accounts = [
      makeAccount({ pda: "aabb", last_accrual_period: 0 }),
      makeAccount({ pda: "ccdd", last_accrual_period: 100 }),
      makeAccount({ pda: "eeff", last_accrual_period: 200 }),
    ];
    const deps: YieldDeps = {
      commitYieldOnChain: vi.fn().mockResolvedValue({ tx_signature: "sig" }),
      currentPeriod: () => 100,
    };
    const results = await accrueAll(accounts, deps);
    expect(results).toHaveLength(3);
    // first account: elapsed = 100, should commit
    expect(results[0]).not.toBeNull();
    // second account: elapsed = 0, should skip
    expect(results[1]).toBeNull();
    // third account: elapsed = -100, should skip
    expect(results[2]).toBeNull();
  });

  it("handles an empty array", async () => {
    const deps: YieldDeps = {
      commitYieldOnChain: vi.fn(),
      currentPeriod: () => 10,
    };
    const results = await accrueAll([], deps);
    expect(results).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// stubCommitYield
// ---------------------------------------------------------------------------

describe("stubCommitYield", () => {
  it("returns a tx_signature string of length 64", async () => {
    const { tx_signature } = await stubCommitYield("pda_abc", 1_000_000n, 42);
    expect(typeof tx_signature).toBe("string");
    expect(tx_signature).toHaveLength(64);
  });

  it("produces a deterministic signature for given (pda, balance, period)", async () => {
    const sig1 = (await stubCommitYield("pda_abc", 1_000_000n, 42)).tx_signature;
    const sig2 = (await stubCommitYield("pda_abc", 1_000_000n, 42)).tx_signature;
    expect(sig1).toBe(sig2);
  });

  it("produces different signatures for different inputs", async () => {
    const sig1 = (await stubCommitYield("pda_abc", 1_000_000n, 42)).tx_signature;
    const sig2 = (await stubCommitYield("pda_abc", 1_000_001n, 42)).tx_signature;
    const sig3 = (await stubCommitYield("pda_abc", 1_000_000n, 43)).tx_signature;
    expect(sig1).not.toBe(sig2);
    expect(sig1).not.toBe(sig3);
  });
});
