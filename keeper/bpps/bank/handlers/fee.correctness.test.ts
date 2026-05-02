/**
 * FN-113 / T-3.10.3.3 — Exhaustive correctness suite for 1-pip eUSD fee math.
 *
 * Acceptance criteria:
 *   AC-1: |amount/10_000 − oneBipFee(amount)| < 1 for all valid inputs
 *         (bias bound: < 1 wei eUSD per call)
 *   AC-2: fee * 10_000 <= amount (no-overcharge invariant)
 *   AC-3: oneBipFee is non-decreasing
 *   AC-4: oneBipFee(n) === Math.floor(n / 10_000) for all valid n
 *
 * Two suites:
 *   1. pure-math correctness (FN-113) — oneBipFee directly
 *   2. handler fee correctness (FN-113) — executeOnramp / executeOfframp end-to-end
 */

import { describe, it, expect, vi } from 'vitest';
import { oneBipFee, ONE_BIP_DIVISOR } from './fee.js';
import { executeOnramp, type OnrampRequest, type OnrampDeps } from './onramp.js';
import {
  executeOfframp,
  OfframpRejected,
  type OfframpRequest,
  type OfframpDeps,
} from './offramp.js';

// ---------------------------------------------------------------------------
// Reference oracle (local, no external dep)
// ---------------------------------------------------------------------------

/** Reference implementation: floor(amount / 10_000), returns 0 for non-positive or non-integer */
function referenceFee(amount: number): number {
  if (!Number.isInteger(amount) || amount <= 0) return 0;
  return Math.floor(amount / ONE_BIP_DIVISOR);
}

// ---------------------------------------------------------------------------
// Deterministic LCG fuzz RNG (mulberry32 variant — no external dep)
// ---------------------------------------------------------------------------
// Seed is a fixed literal constant so every failure is reproducible.
const FUZZ_SEED = 0xdeadbeef;

function makeLcg(seed: number): () => number {
  let state = seed >>> 0;
  return function next(): number {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state;
  };
}

/** Generate `count` integers uniformly in [0, max] using the seeded LCG. */
function fuzzIntegers(count: number, max: number, seed: number): number[] {
  const rng = makeLcg(seed);
  const result: number[] = [];
  for (let i = 0; i < count; i++) {
    // Combine two LCG outputs for better coverage of large ranges
    const hi = rng() >>> 0;
    const lo = rng() >>> 0;
    const combined = hi * 0x100000000 + lo;
    result.push(Math.floor((combined % (max + 1) + (max + 1)) % (max + 1)));
  }
  return result;
}

// ---------------------------------------------------------------------------
// Curated test table
// ---------------------------------------------------------------------------

const CURATED_CASES: number[] = [
  // Exact multiples of 10_000
  10_000,
  20_000,
  100_000,
  1_000_000,
  1_000_000_000,       // 1 USD at 6-decimal eUSD
  1_000_000_000_000,   // 1 M USD
  // Largest safe multiple of 10_000
  Number.MAX_SAFE_INTEGER - (Number.MAX_SAFE_INTEGER % 10_000),
  // Just below a boundary
  9_999,
  19_999,
  99_999,
  999_999_999,
  // Just above a boundary
  10_001,
  20_001,
  100_001,
  // Dust
  0,
  1,
  2,
  5_000,
];

// Sorted ascending list for monotonicity test
const SORTED_CASES: number[] = [...CURATED_CASES].sort((a, b) => a - b);

// Arithmetic progression: 100 points from 0 to 1e12
const PROGRESSION: number[] = Array.from({ length: 100 }, (_, i) =>
  Math.round((i / 99) * 1e12),
);

// Combined sorted list for monotonicity
const MONOTONE_LIST: number[] = [...new Set([...SORTED_CASES, ...PROGRESSION])]
  .sort((a, b) => a - b);

// ---------------------------------------------------------------------------
// Suite 1: Pure-math correctness (FN-113)
// ---------------------------------------------------------------------------

describe('pure-math fee correctness (FN-113)', () => {
  // -------------------------------------------------------------------------
  // Reference oracle + bias bound AC
  // -------------------------------------------------------------------------

  describe.each(CURATED_CASES.map((n) => [n] as [number]))(
    'oneBipFee(%i)',
    (n) => {
      it('equals referenceFee (oracle equality)', () => {
        expect(oneBipFee(n)).toBe(referenceFee(n));
      });

      it('bias < 1 wei eUSD (AC-1)', () => {
        const fee = oneBipFee(n);
        const exact = n / ONE_BIP_DIVISOR;
        const bias = Math.abs(exact - fee);
        expect(bias).toBeLessThan(1);
      });

      it('no-overcharge: fee * 10_000 <= amount (AC-2)', () => {
        const fee = oneBipFee(n);
        expect(fee * ONE_BIP_DIVISOR).toBeLessThanOrEqual(n);
      });

      it('bias >= 0 (always floored, never negative bias)', () => {
        const fee = oneBipFee(n);
        const bias = n / ONE_BIP_DIVISOR - fee;
        expect(bias).toBeGreaterThanOrEqual(0);
      });

      it('output is a non-negative integer', () => {
        const fee = oneBipFee(n);
        expect(Number.isInteger(fee)).toBe(true);
        expect(fee).toBeGreaterThanOrEqual(0);
      });
    },
  );

  // -------------------------------------------------------------------------
  // Monotonic non-decreasing
  // -------------------------------------------------------------------------

  it('monotonic non-decreasing over sorted curated + progression values', () => {
    for (let i = 1; i < MONOTONE_LIST.length; i++) {
      const prev = MONOTONE_LIST[i - 1]!;
      const curr = MONOTONE_LIST[i]!;
      expect(oneBipFee(prev)).toBeLessThanOrEqual(oneBipFee(curr));
    }
  });

  // -------------------------------------------------------------------------
  // Defensive inputs — all return 0 per FN-109 contract
  // -------------------------------------------------------------------------

  describe('defensive inputs → 0', () => {
    const defensiveCases: Array<[string, number]> = [
      ['negative integer -1', -1],
      ['negative integer -10_000', -10_000],
      ['negative non-integer -1.5', -1.5],
      ['non-integer 1.5', 1.5],
      ['non-integer 9999.999999', 9999.999999],
      ['non-integer 10_000.5', 10_000.5],
      ['NaN', NaN],
      ['Infinity', Infinity],
      ['-Infinity', -Infinity],
      ['zero', 0],
    ];

    it.each(defensiveCases)('%s returns 0', (_label, input) => {
      expect(oneBipFee(input)).toBe(0);
    });
  });

  // -------------------------------------------------------------------------
  // Deterministic fuzz: 1_000 random integers in [0, MAX_SAFE_INTEGER/2]
  // -------------------------------------------------------------------------

  describe('deterministic fuzz (seed=0xdeadbeef, 1_000 iterations)', () => {
    const MAX_FUZZ = Math.floor(Number.MAX_SAFE_INTEGER / 2);
    const FUZZ_AMOUNTS = fuzzIntegers(1_000, MAX_FUZZ, FUZZ_SEED);

    it('oracle equality for all 1_000 fuzz values', () => {
      for (const n of FUZZ_AMOUNTS) {
        expect(oneBipFee(n)).toBe(referenceFee(n));
      }
    });

    it('no-overcharge for all 1_000 fuzz values (AC-2: fee * 10_000 <= amount)', () => {
      for (const n of FUZZ_AMOUNTS) {
        const fee = oneBipFee(n);
        expect(fee * ONE_BIP_DIVISOR).toBeLessThanOrEqual(n);
      }
    });

    it('bias < 1 wei eUSD for all 1_000 fuzz values (AC-1)', () => {
      for (const n of FUZZ_AMOUNTS) {
        const fee = oneBipFee(n);
        const bias = Math.abs(n / ONE_BIP_DIVISOR - fee);
        expect(bias).toBeLessThan(1);
      }
    });

    it('output is always a non-negative integer for all 1_000 fuzz values', () => {
      for (const n of FUZZ_AMOUNTS) {
        const fee = oneBipFee(n);
        expect(Number.isInteger(fee)).toBe(true);
        expect(fee).toBeGreaterThanOrEqual(0);
      }
    });
  });
});

// ---------------------------------------------------------------------------
// Suite 2: Handler fee correctness (FN-113)
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Onramp helpers
// ---------------------------------------------------------------------------

const ONRAMP_RECIPIENT = 'a'.repeat(64);
const ONRAMP_TOKEN_PDA = 'b'.repeat(64);

/**
 * Make an OnrampRequest where `usd_amount_cents` is set to produce
 * `gross_eusd_atomic` gross eUSD (1 cent = 10_000 atomic).
 * We pass `eusd_amount` directly as cents * 10_000 by computing cents = eusd / 10_000.
 *
 * For simplicity, we parameterise by the gross eUSD atomic amount.
 * usd_amount_cents = gross_eusd / 10_000 (since 1 cent = 10_000 atomic).
 */
function makeOnrampRequest(gross_eusd_atomic: number): OnrampRequest {
  return {
    recipient: ONRAMP_RECIPIENT,
    recipient_token_account_pda: ONRAMP_TOKEN_PDA,
    usd_amount_cents: gross_eusd_atomic / 10_000,
    funding_method: 'mock',
    external_payment_ref: 'ref-fn113-test',
    initiated_slot: 1000,
  };
}

function makeOnrampDeps(overrides: Partial<OnrampDeps> = {}): OnrampDeps {
  return {
    feeFor: oneBipFee,   // real oneBipFee — no fake injected
    verifyUsdPull: vi.fn().mockResolvedValue(true),
    mintOnChain: vi.fn().mockResolvedValue({ tx_signature: 'f'.repeat(64) }),
    remitToTreasury: vi.fn().mockResolvedValue({ tx_signature: 'a'.repeat(64) }),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Offramp helpers
// ---------------------------------------------------------------------------

const OFFRAMP_HOLDER = 'c'.repeat(64);
const OFFRAMP_HOLDER_TOKEN_PDA = 'd'.repeat(64);

const DOMESTIC_DEST: OfframpRequest['destination'] = {
  account_holder_name: 'FN-113 Test',
  routing_number: '021000021',
  account_number: '987654321',
};

function makeOfframpRequest(eusd_amount_atomic: number): OfframpRequest {
  return {
    holder: OFFRAMP_HOLDER,
    holder_token_account_pda: OFFRAMP_HOLDER_TOKEN_PDA,
    eusd_amount_atomic,
    destination: DOMESTIC_DEST,
    initiated_slot: 2000,
  };
}

function makeOfframpDeps(overrides: Partial<OfframpDeps> = {}): OfframpDeps {
  return {
    feeFor: oneBipFee,   // real oneBipFee — no fake injected
    burnOnChain: vi.fn().mockResolvedValue({ tx_signature: 'b'.repeat(64) }),
    pushUsd: vi.fn().mockResolvedValue({ external_ref: 'ext_ref_fn113' }),
    flagReconciliation: vi.fn().mockResolvedValue(undefined),
    remitToTreasury: vi.fn().mockResolvedValue({ tx_signature: 'a'.repeat(64) }),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Parameterised amounts
//
// Onramp takes usd_amount_cents (integer), converts via cents * 10_000 to
// atomic. So onramp amounts must be exact multiples of 10_000.
//
// Offramp takes eusd_amount_atomic directly, so any positive integer is valid.
// The PROMPT's full list [10_000, 19_999, 100_000, 1_000_000_000,
// 1_000_000_000_000] is used for offramp; onramp uses only the multiples of
// 10_000 from that list.
// ---------------------------------------------------------------------------

/** Gross eUSD amounts that are exact multiples of 10_000 (valid for onramp cents conversion). */
const ONRAMP_AMOUNTS = [
  10_000,
  100_000,
  1_000_000_000,
  1_000_000_000_000,
];

/** All parameterised amounts for offramp (takes atomic directly). */
const OFFRAMP_AMOUNTS = [
  10_000,
  19_999,
  100_000,
  1_000_000_000,
  1_000_000_000_000,
];

describe('handler fee correctness (FN-113)', () => {
  // -------------------------------------------------------------------------
  // Onramp parameterised matrix
  // -------------------------------------------------------------------------

  describe('executeOnramp — fee equals oneBipFee(gross)', () => {
    it.each(ONRAMP_AMOUNTS.map((amt) => [amt] as [number]))(
      'gross_eusd=%i: outcome.fee === oneBipFee(gross), eusd_net === gross - fee, remitToTreasury called with fee_atomic',
      async (gross_eusd) => {
        const deps = makeOnrampDeps();
        const req = makeOnrampRequest(gross_eusd);
        const outcome = await executeOnramp(req, deps);

        const expectedFee = oneBipFee(gross_eusd);
        const expectedNet = gross_eusd - expectedFee;

        expect(outcome.fee).toBe(expectedFee);
        expect(outcome.eusd_amount).toBe(expectedNet);

        // remitToTreasury must be called once with the correct fee_atomic
        expect(deps.remitToTreasury).toHaveBeenCalledOnce();
        const remitArg = (deps.remitToTreasury as ReturnType<typeof vi.fn>).mock.calls[0]![0];
        expect(remitArg.fee_atomic).toBe(expectedFee);
      },
    );

    it.each(ONRAMP_AMOUNTS.map((amt) => [amt] as [number]))(
      'gross_eusd=%i: bias < 1 wei eUSD at handler boundary (AC-1)',
      async (gross_eusd) => {
        const deps = makeOnrampDeps();
        const req = makeOnrampRequest(gross_eusd);
        const outcome = await executeOnramp(req, deps);

        const bias = gross_eusd / ONE_BIP_DIVISOR - outcome.fee;
        expect(bias).toBeLessThan(1);
        expect(bias).toBeGreaterThanOrEqual(0);
      },
    );
  });

  // -------------------------------------------------------------------------
  // Offramp parameterised matrix
  // -------------------------------------------------------------------------

  describe('executeOfframp — fee_atomic equals oneBipFee(amount)', () => {
    it.each(OFFRAMP_AMOUNTS.map((amt) => [amt] as [number]))(
      'eusd_amount=%i: outcome.fee_atomic === oneBipFee(amount), eusd_net === amount - fee_atomic',
      async (eusd_amount) => {
        const deps = makeOfframpDeps();
        const req = makeOfframpRequest(eusd_amount);
        const outcome = await executeOfframp(req, deps);

        const expectedFee = oneBipFee(eusd_amount);
        const expectedNet = eusd_amount - expectedFee;

        expect(outcome.fee_atomic).toBe(expectedFee);
        // eusd_net is verified via burned_atomic - fee_atomic
        expect(outcome.burned_atomic - outcome.fee_atomic).toBe(expectedNet);
      },
    );

    it.each(OFFRAMP_AMOUNTS.map((amt) => [amt] as [number]))(
      'eusd_amount=%i: bias < 1 wei eUSD at handler boundary (AC-1)',
      async (eusd_amount) => {
        const deps = makeOfframpDeps();
        const req = makeOfframpRequest(eusd_amount);
        const outcome = await executeOfframp(req, deps);

        const bias = eusd_amount / ONE_BIP_DIVISOR - outcome.fee_atomic;
        expect(bias).toBeLessThan(1);
        expect(bias).toBeGreaterThanOrEqual(0);
      },
    );
  });

  // -------------------------------------------------------------------------
  // Offramp dust rejection boundary behaviour (FN-109)
  // -------------------------------------------------------------------------

  describe('executeOfframp — dust and zero boundary behaviour', () => {
    it('eusd_amount_atomic=9_999: fee=0, call succeeds (eusd_net=9_999 > 0)', async () => {
      const deps = makeOfframpDeps();
      const req = makeOfframpRequest(9_999);
      const outcome = await executeOfframp(req, deps);

      expect(outcome.fee_atomic).toBe(0);               // oneBipFee(9_999) = 0
      expect(outcome.burned_atomic).toBe(9_999);
      expect(outcome.phase).toBe('pushed');
    });

    it('eusd_amount_atomic=0 rejects with OfframpRejected("invalid_amount")', async () => {
      const deps = makeOfframpDeps();
      const req = makeOfframpRequest(0);
      await expect(executeOfframp(req, deps)).rejects.toThrow(OfframpRejected);
      await expect(executeOfframp(req, deps)).rejects.toMatchObject({ reason: 'invalid_amount' });
    });
  });
});
