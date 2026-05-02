/**
 * Mock USD ledger (FN-110, T-3.10.2.5) — v0.
 *
 * An off-chain, JSON-file-backed mock USD ledger used by the bank-as-BPP
 * onramp/offramp handlers (FN-107, FN-108) and their tests to simulate
 * real-world USD movement WITHOUT a real banking integration.
 *
 * **Scope (v0):**
 *   - Persists a `LedgerSnapshot` (accounts + chronological ramp events)
 *     to a single JSON file under a configurable path.
 *   - Stores all balances as integer **cents** (no float drift).
 *   - Atomic on-disk writes via temp file + rename.
 *   - Internal serialization of mutations so concurrent callers cannot
 *     interleave a read-modify-write cycle.
 *
 * **NOT in scope (v0):**
 *   - Real banking rails (Plaid / Stripe / ACH).
 *   - Multi-currency or FX.
 *   - Durable database (Postgres / SQLite). The JSON snapshot is
 *     deliberately simple and dev/test-only.
 *
 * Production blast radius: zero — this module is dev-time only and is
 * never imported by the published `dist/` build.
 */

import { promises as fs } from "node:fs";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import { z } from "zod";

/* -------------------------------------------------------------------------- */
/* Schemas + types                                                            */
/* -------------------------------------------------------------------------- */

/** Opaque USD account id, e.g. `"acct_<base58>"`. */
export type UsdAccountId = string;

/** USD amount in **cents**. Always a non-negative safe integer. */
export type UsdAmountCents = number;

/** Direction of a fiat ⇄ eUSD movement. */
export const zRampDirection = z.enum(["onramp", "offramp"]);
export type RampDirection = z.infer<typeof zRampDirection>;

/**
 * Convert dollars to cents with strict validation.
 *
 * @throws if the input is non-finite, negative, or rounds to a non-safe int.
 */
export function usd(dollars: number): UsdAmountCents {
  if (typeof dollars !== "number" || !Number.isFinite(dollars)) {
    throw new TypeError(`usd(): dollars must be a finite number, got ${dollars}`);
  }
  if (dollars < 0) {
    throw new RangeError(`usd(): dollars must be non-negative, got ${dollars}`);
  }
  // Round to the nearest cent to avoid 0.1 + 0.2 style float drift.
  const cents = Math.round(dollars * 100);
  if (!Number.isSafeInteger(cents)) {
    throw new RangeError(`usd(): dollars overflows safe integer cents (${dollars})`);
  }
  return cents;
}

/** Zod schema for a non-negative safe-integer cents amount. */
const zCents = z
  .number()
  .int("amountCents must be an integer")
  .nonnegative("amountCents must be >= 0")
  .refine((n) => Number.isSafeInteger(n), { message: "amountCents must be a safe integer" });

const zAccountId = z.string().min(1, "accountId must be a non-empty string");

/** A single ramp event (USD ⇄ eUSD movement). */
export const zRampEvent = z.object({
  id: z.string().min(1),
  direction: zRampDirection,
  accountId: zAccountId,
  amountCents: zCents,
  /** Decimal string to mirror on-chain amount conventions used elsewhere. */
  eusdAmount: z.string().min(1),
  memo: z.string().optional(),
  /** Unix epoch **seconds** at which the event was recorded. */
  createdAt: z.number().int().nonnegative(),
});
export type RampEvent = z.infer<typeof zRampEvent>;

/** On-disk shape of the ledger. */
export const zLedgerSnapshot = z.object({
  version: z.literal(1),
  accounts: z.record(zAccountId, z.object({ balanceCents: zCents })),
  ramps: z.array(zRampEvent),
});
export type LedgerSnapshot = z.infer<typeof zLedgerSnapshot>;

/* -------------------------------------------------------------------------- */
/* Errors                                                                     */
/* -------------------------------------------------------------------------- */

/** Thrown when a debit would push an account balance below zero. */
export class InsufficientFundsError extends Error {
  readonly code = "INSUFFICIENT_FUNDS" as const;
  readonly accountId: UsdAccountId;
  readonly requestedCents: UsdAmountCents;
  readonly availableCents: UsdAmountCents;

  constructor(
    accountId: UsdAccountId,
    requestedCents: UsdAmountCents,
    availableCents: UsdAmountCents,
  ) {
    super(
      `insufficient funds on account ${accountId}: requested ${requestedCents} cents, available ${availableCents} cents`,
    );
    this.name = "InsufficientFundsError";
    this.accountId = accountId;
    this.requestedCents = requestedCents;
    this.availableCents = availableCents;
  }
}

/** Thrown when an on-disk snapshot fails schema validation. */
export class LedgerCorruptError extends Error {
  readonly code = "LEDGER_CORRUPT" as const;
  readonly path: string;
  override readonly cause?: unknown;

  constructor(path: string, message: string, cause?: unknown) {
    super(`ledger at ${path} is corrupt: ${message}`);
    this.name = "LedgerCorruptError";
    this.path = path;
    this.cause = cause;
  }
}

/* -------------------------------------------------------------------------- */
/* Ledger                                                                     */
/* -------------------------------------------------------------------------- */

export interface MockUsdLedgerOpts {
  /** Absolute or cwd-relative path to the JSON snapshot file. */
  path: string;
  /** Override clock for deterministic tests. Returns unix seconds. */
  clock?: () => number;
  /** Override id generator for deterministic tests. */
  idGen?: () => string;
}

const defaultClock = (): number => Math.floor(Date.now() / 1000);
const defaultIdGen = (): string => randomUUID();

function emptySnapshot(): LedgerSnapshot {
  return { version: 1, accounts: {}, ramps: [] };
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

/**
 * Mock USD ledger. Use {@link MockUsdLedger.open} to load (or create) an
 * instance pinned to a JSON file on disk.
 */
export class MockUsdLedger {
  private snap: LedgerSnapshot;
  private readonly path: string;
  private readonly clock: () => number;
  private readonly idGen: () => string;
  /** Tail of the mutation queue — used to serialize concurrent writers. */
  private tail: Promise<unknown> = Promise.resolve();

  private constructor(snap: LedgerSnapshot, opts: Required<MockUsdLedgerOpts>) {
    this.snap = snap;
    this.path = opts.path;
    this.clock = opts.clock;
    this.idGen = opts.idGen;
  }

  /** Load an existing snapshot or create a fresh empty one. */
  static async open(opts: MockUsdLedgerOpts): Promise<MockUsdLedger> {
    const resolved: Required<MockUsdLedgerOpts> = {
      path: opts.path,
      clock: opts.clock ?? defaultClock,
      idGen: opts.idGen ?? defaultIdGen,
    };

    let snap: LedgerSnapshot;
    let raw: string | undefined;
    try {
      raw = await fs.readFile(resolved.path, "utf8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        snap = emptySnapshot();
        await fs.mkdir(dirname(resolved.path), { recursive: true });
        const ledger = new MockUsdLedger(snap, resolved);
        await ledger.persist();
        return ledger;
      }
      throw err;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (err) {
      throw new LedgerCorruptError(resolved.path, "JSON parse failed", err);
    }

    const result = zLedgerSnapshot.safeParse(parsed);
    if (!result.success) {
      throw new LedgerCorruptError(
        resolved.path,
        `schema validation failed: ${result.error.message}`,
        result.error,
      );
    }
    return new MockUsdLedger(result.data, resolved);
  }

  /** Returns the cents balance for an account; non-existent accounts are 0. */
  async getBalance(accountId: UsdAccountId): Promise<UsdAmountCents> {
    return this.enqueue(() => this.snap.accounts[accountId]?.balanceCents ?? 0);
  }

  /** Add `amountCents` to `accountId`. Returns the new balance. */
  async credit(accountId: UsdAccountId, amountCents: UsdAmountCents): Promise<UsdAmountCents> {
    return this.enqueue(async () => {
      this.assertAccountId(accountId);
      this.assertCents(amountCents);
      const next = (this.snap.accounts[accountId]?.balanceCents ?? 0) + amountCents;
      this.snap.accounts[accountId] = { balanceCents: next };
      await this.persist();
      return next;
    });
  }

  /**
   * Subtract `amountCents` from `accountId`. Returns the new balance.
   * @throws {@link InsufficientFundsError} if the balance would go negative.
   */
  async debit(accountId: UsdAccountId, amountCents: UsdAmountCents): Promise<UsdAmountCents> {
    return this.enqueue(async () => {
      this.assertAccountId(accountId);
      this.assertCents(amountCents);
      const current = this.snap.accounts[accountId]?.balanceCents ?? 0;
      if (current < amountCents) {
        throw new InsufficientFundsError(accountId, amountCents, current);
      }
      const next = current - amountCents;
      this.snap.accounts[accountId] = { balanceCents: next };
      await this.persist();
      return next;
    });
  }

  /**
   * Atomically apply a balance delta and append a ramp event. On debit
   * failure (offramp with insufficient funds), the event is NOT recorded
   * and the balance is unchanged.
   */
  async recordRamp(args: Omit<RampEvent, "id" | "createdAt">): Promise<RampEvent> {
    return this.enqueue(async () => {
      const direction = zRampDirection.parse(args.direction);
      this.assertAccountId(args.accountId);
      this.assertCents(args.amountCents);
      if (typeof args.eusdAmount !== "string" || args.eusdAmount.length === 0) {
        throw new TypeError("recordRamp(): eusdAmount must be a non-empty string");
      }
      if (args.memo !== undefined && typeof args.memo !== "string") {
        throw new TypeError("recordRamp(): memo must be a string when provided");
      }

      const current = this.snap.accounts[args.accountId]?.balanceCents ?? 0;
      let next: number;
      if (direction === "onramp") {
        next = current + args.amountCents;
      } else {
        if (current < args.amountCents) {
          throw new InsufficientFundsError(args.accountId, args.amountCents, current);
        }
        next = current - args.amountCents;
      }

      const event: RampEvent = {
        id: this.idGen(),
        direction,
        accountId: args.accountId,
        amountCents: args.amountCents,
        eusdAmount: args.eusdAmount,
        ...(args.memo !== undefined ? { memo: args.memo } : {}),
        createdAt: this.clock(),
      };

      this.snap.accounts[args.accountId] = { balanceCents: next };
      this.snap.ramps.push(event);
      await this.persist();
      return clone(event);
    });
  }

  /** List ramps, optionally filtered by accountId and/or direction. */
  async listRamps(filter?: {
    accountId?: UsdAccountId;
    direction?: RampDirection;
  }): Promise<RampEvent[]> {
    return this.enqueue(() => {
      const all = this.snap.ramps.filter((r) => {
        if (filter?.accountId !== undefined && r.accountId !== filter.accountId) return false;
        if (filter?.direction !== undefined && r.direction !== filter.direction) return false;
        return true;
      });
      return clone(all);
    });
  }

  /** Synchronous deep clone of the in-memory snapshot. */
  snapshot(): LedgerSnapshot {
    return clone(this.snap);
  }

  /* ---- internals ------------------------------------------------------- */

  private assertCents(amountCents: number): void {
    if (
      typeof amountCents !== "number" ||
      !Number.isInteger(amountCents) ||
      amountCents < 0 ||
      !Number.isSafeInteger(amountCents)
    ) {
      throw new RangeError(
        `amountCents must be a non-negative safe integer, got ${amountCents}`,
      );
    }
  }

  private assertAccountId(accountId: unknown): void {
    if (typeof accountId !== "string" || accountId.length === 0) {
      throw new TypeError("accountId must be a non-empty string");
    }
  }

  /** Atomic write: temp file + rename. */
  private async persist(): Promise<void> {
    const dir = dirname(this.path);
    await fs.mkdir(dir, { recursive: true });
    const tmp = join(dir, `.${randomUUID()}.tmp`);
    const body = JSON.stringify(this.snap, null, 2);
    await fs.writeFile(tmp, body, "utf8");
    await fs.rename(tmp, this.path);
  }

  /**
   * Serialize a unit of work behind any in-flight mutation. Errors are
   * propagated to the caller but do NOT poison the queue for subsequent
   * callers.
   */
  private enqueue<T>(fn: () => T | Promise<T>): Promise<T> {
    const run = this.tail.then(fn, fn);
    // Swallow errors on the chain so future callers are not infected, but
    // still surface them on the per-call promise we return.
    this.tail = run.catch(() => undefined);
    return run;
  }
}
