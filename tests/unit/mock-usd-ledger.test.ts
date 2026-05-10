/**
 * Unit tests for the mock USD ledger (FN-110, T-3.10.2.5).
 *
 * Covers: open-empty / open-existing, credit/debit/getBalance, recordRamp
 * onramp + offramp happy paths, offramp rollback on insufficient funds,
 * listRamps filter combinations, snapshot immutability, and atomic
 * write durability across reopen.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  InsufficientFundsError,
  LedgerCorruptError,
  MockUsdLedger,
  usd,
  zLedgerSnapshot,
} from "../../keeper/bpps/bank/mock-usd-ledger.js";

/* -------------------------------------------------------------------------- */
/* Fixtures                                                                   */
/* -------------------------------------------------------------------------- */

let workDir: string;
let ledgerPath: string;

beforeEach(async () => {
  workDir = await fs.mkdtemp(join(tmpdir(), "mock-usd-ledger-"));
  ledgerPath = join(workDir, "ledger.json");
});

afterEach(async () => {
  await fs.rm(workDir, { recursive: true, force: true });
});

function fixedClock(t: number): () => number {
  return () => t;
}

function counterIdGen(prefix = "evt"): () => string {
  let n = 0;
  return () => `${prefix}_${++n}`;
}

/* -------------------------------------------------------------------------- */
/* usd() helper                                                                */
/* -------------------------------------------------------------------------- */

describe("usd() helper", () => {
  it("converts dollars to cents and rounds to nearest cent", () => {
    expect(usd(0)).toBe(0);
    expect(usd(1)).toBe(100);
    expect(usd(12.34)).toBe(1234);
    expect(usd(0.1 + 0.2)).toBe(30); // 0.30 — must not drift to 29
  });

  it("rejects negative or non-finite inputs", () => {
    expect(() => usd(-1)).toThrow(RangeError);
    expect(() => usd(Number.NaN)).toThrow(TypeError);
    expect(() => usd(Number.POSITIVE_INFINITY)).toThrow(TypeError);
  });
});

/* -------------------------------------------------------------------------- */
/* open()                                                                      */
/* -------------------------------------------------------------------------- */

describe("MockUsdLedger.open", () => {
  it("creates an empty snapshot when the file does not exist", async () => {
    const ledger = await MockUsdLedger.open({ path: ledgerPath });
    expect(ledger.snapshot()).toEqual({ version: 1, accounts: {}, ramps: [] });

    // File was written to disk on creation.
    const raw = await fs.readFile(ledgerPath, "utf8");
    expect(zLedgerSnapshot.parse(JSON.parse(raw))).toEqual({
      version: 1,
      accounts: {},
      ramps: [],
    });
  });

  it("loads an existing snapshot", async () => {
    const seed = {
      version: 1,
      accounts: { "acct_a": { balanceCents: 500 } },
      ramps: [
        {
          id: "evt_1",
          direction: "onramp",
          accountId: "acct_a",
          amountCents: 500,
          eusdAmount: "5.00",
          createdAt: 1700000000,
        },
      ],
    };
    await fs.writeFile(ledgerPath, JSON.stringify(seed), "utf8");

    const ledger = await MockUsdLedger.open({ path: ledgerPath });
    expect(await ledger.getBalance("acct_a")).toBe(500);
    expect(await ledger.listRamps()).toEqual(seed.ramps);
  });

  it("creates parent directories on first open", async () => {
    const nested = join(workDir, "a", "b", "c", "ledger.json");
    const ledger = await MockUsdLedger.open({ path: nested });
    expect(ledger.snapshot()).toEqual({ version: 1, accounts: {}, ramps: [] });
    expect((await fs.stat(nested)).isFile()).toBe(true);
  });

  it("throws LedgerCorruptError on invalid JSON", async () => {
    await fs.writeFile(ledgerPath, "{ not json", "utf8");
    await expect(MockUsdLedger.open({ path: ledgerPath })).rejects.toBeInstanceOf(
      LedgerCorruptError,
    );
  });

  it("throws LedgerCorruptError on schema mismatch", async () => {
    await fs.writeFile(
      ledgerPath,
      JSON.stringify({ version: 1, accounts: { a: { balanceCents: -5 } }, ramps: [] }),
      "utf8",
    );
    await expect(MockUsdLedger.open({ path: ledgerPath })).rejects.toBeInstanceOf(
      LedgerCorruptError,
    );
  });
});

/* -------------------------------------------------------------------------- */
/* credit / debit / getBalance                                                */
/* -------------------------------------------------------------------------- */

describe("credit / debit / getBalance", () => {
  it("treats unknown accounts as zero balance", async () => {
    const ledger = await MockUsdLedger.open({ path: ledgerPath });
    expect(await ledger.getBalance("acct_missing")).toBe(0);
  });

  it("credits and debits accumulate correctly", async () => {
    const ledger = await MockUsdLedger.open({ path: ledgerPath });
    expect(await ledger.credit("acct_a", 1000)).toBe(1000);
    expect(await ledger.credit("acct_a", 250)).toBe(1250);
    expect(await ledger.debit("acct_a", 500)).toBe(750);
    expect(await ledger.getBalance("acct_a")).toBe(750);
  });

  it("rejects non-integer or negative amounts", async () => {
    const ledger = await MockUsdLedger.open({ path: ledgerPath });
    await expect(ledger.credit("acct_a", -1)).rejects.toBeInstanceOf(RangeError);
    await expect(ledger.credit("acct_a", 1.5)).rejects.toBeInstanceOf(RangeError);
    await expect(ledger.debit("acct_a", -1)).rejects.toBeInstanceOf(RangeError);
  });

  it("debit throws InsufficientFundsError without mutating state", async () => {
    const ledger = await MockUsdLedger.open({ path: ledgerPath });
    await ledger.credit("acct_a", 100);
    await expect(ledger.debit("acct_a", 200)).rejects.toBeInstanceOf(InsufficientFundsError);
    expect(await ledger.getBalance("acct_a")).toBe(100);
  });
});

/* -------------------------------------------------------------------------- */
/* recordRamp                                                                  */
/* -------------------------------------------------------------------------- */

describe("recordRamp", () => {
  it("onramp credits and appends a ramp event", async () => {
    const ledger = await MockUsdLedger.open({
      path: ledgerPath,
      clock: fixedClock(1_700_000_000),
      idGen: counterIdGen(),
    });
    const event = await ledger.recordRamp({
      direction: "onramp",
      accountId: "acct_a",
      amountCents: 5000,
      eusdAmount: "50.00",
      memo: "wire-in",
    });
    expect(event).toEqual({
      id: "evt_1",
      direction: "onramp",
      accountId: "acct_a",
      amountCents: 5000,
      eusdAmount: "50.00",
      memo: "wire-in",
      createdAt: 1_700_000_000,
    });
    expect(await ledger.getBalance("acct_a")).toBe(5000);
    expect(await ledger.listRamps()).toHaveLength(1);
  });

  it("offramp debits and appends a ramp event", async () => {
    const ledger = await MockUsdLedger.open({
      path: ledgerPath,
      clock: fixedClock(1_700_000_000),
      idGen: counterIdGen(),
    });
    await ledger.credit("acct_a", 10_000);
    const event = await ledger.recordRamp({
      direction: "offramp",
      accountId: "acct_a",
      amountCents: 4_000,
      eusdAmount: "40.00",
    });
    expect(event.id).toBe("evt_1");
    expect(event.memo).toBeUndefined();
    expect(await ledger.getBalance("acct_a")).toBe(6_000);
  });

  it("offramp rollback: insufficient funds does NOT append event or mutate balance", async () => {
    const ledger = await MockUsdLedger.open({
      path: ledgerPath,
      idGen: counterIdGen(),
    });
    await ledger.credit("acct_a", 100);
    await expect(
      ledger.recordRamp({
        direction: "offramp",
        accountId: "acct_a",
        amountCents: 500,
        eusdAmount: "5.00",
      }),
    ).rejects.toBeInstanceOf(InsufficientFundsError);
    expect(await ledger.getBalance("acct_a")).toBe(100);
    expect(await ledger.listRamps()).toEqual([]);

    // Subsequent calls still work — error did not poison the queue.
    const ok = await ledger.recordRamp({
      direction: "onramp",
      accountId: "acct_a",
      amountCents: 50,
      eusdAmount: "0.50",
    });
    expect(ok.id).toBe("evt_1");
    expect(await ledger.getBalance("acct_a")).toBe(150);
  });

  it("rejects an unknown direction", async () => {
    const ledger = await MockUsdLedger.open({ path: ledgerPath });
    await expect(
      ledger.recordRamp({
        // @ts-expect-error — invalid direction
        direction: "sideways",
        accountId: "acct_a",
        amountCents: 100,
        eusdAmount: "1.00",
      }),
    ).rejects.toThrow();
  });
});

/* -------------------------------------------------------------------------- */
/* listRamps filters                                                          */
/* -------------------------------------------------------------------------- */

describe("listRamps", () => {
  async function seedLedger(): Promise<MockUsdLedger> {
    const ledger = await MockUsdLedger.open({
      path: ledgerPath,
      idGen: counterIdGen(),
    });
    await ledger.recordRamp({
      direction: "onramp",
      accountId: "acct_a",
      amountCents: 1000,
      eusdAmount: "10.00",
    });
    await ledger.recordRamp({
      direction: "onramp",
      accountId: "acct_b",
      amountCents: 2000,
      eusdAmount: "20.00",
    });
    await ledger.recordRamp({
      direction: "offramp",
      accountId: "acct_a",
      amountCents: 500,
      eusdAmount: "5.00",
    });
    return ledger;
  }

  it("returns all events when no filter is provided", async () => {
    const ledger = await seedLedger();
    expect(await ledger.listRamps()).toHaveLength(3);
  });

  it("filters by accountId", async () => {
    const ledger = await seedLedger();
    const events = await ledger.listRamps({ accountId: "acct_a" });
    expect(events.map((e) => e.id)).toEqual(["evt_1", "evt_3"]);
  });

  it("filters by direction", async () => {
    const ledger = await seedLedger();
    const events = await ledger.listRamps({ direction: "offramp" });
    expect(events.map((e) => e.id)).toEqual(["evt_3"]);
  });

  it("combines filters (AND semantics)", async () => {
    const ledger = await seedLedger();
    const events = await ledger.listRamps({ accountId: "acct_b", direction: "offramp" });
    expect(events).toEqual([]);
  });
});

/* -------------------------------------------------------------------------- */
/* snapshot immutability                                                      */
/* -------------------------------------------------------------------------- */

describe("snapshot immutability", () => {
  it("snapshot() returns a deep clone — mutating it does not affect the ledger", async () => {
    const ledger = await MockUsdLedger.open({ path: ledgerPath });
    await ledger.credit("acct_a", 100);

    const snap = ledger.snapshot();
    snap.accounts["acct_a"] = { balanceCents: 999_999 };
    snap.ramps.push({
      id: "fake",
      direction: "onramp",
      accountId: "acct_a",
      amountCents: 1,
      eusdAmount: "0.01",
      createdAt: 0,
    });

    expect(await ledger.getBalance("acct_a")).toBe(100);
    expect(await ledger.listRamps()).toEqual([]);
  });

  it("listRamps() returns a deep clone", async () => {
    const ledger = await MockUsdLedger.open({
      path: ledgerPath,
      idGen: counterIdGen(),
    });
    await ledger.recordRamp({
      direction: "onramp",
      accountId: "acct_a",
      amountCents: 100,
      eusdAmount: "1.00",
    });
    const events = await ledger.listRamps();
    events[0]!.amountCents = 99_999;
    const fresh = await ledger.listRamps();
    expect(fresh[0]!.amountCents).toBe(100);
  });
});

/* -------------------------------------------------------------------------- */
/* atomic-write durability                                                    */
/* -------------------------------------------------------------------------- */

describe("atomic-write durability", () => {
  it("re-opening picks up the latest persisted state", async () => {
    {
      const ledger = await MockUsdLedger.open({
        path: ledgerPath,
        clock: fixedClock(42),
        idGen: counterIdGen("first"),
      });
      await ledger.credit("acct_a", 1_000);
      await ledger.recordRamp({
        direction: "onramp",
        accountId: "acct_a",
        amountCents: 500,
        eusdAmount: "5.00",
      });
    }
    {
      const reopened = await MockUsdLedger.open({ path: ledgerPath });
      expect(await reopened.getBalance("acct_a")).toBe(1_500);
      const events = await reopened.listRamps();
      expect(events).toHaveLength(1);
      expect(events[0]!.id).toBe("first_1");
      expect(events[0]!.createdAt).toBe(42);
    }
  });

  it("does not leave stray .tmp files after writes succeed", async () => {
    const ledger = await MockUsdLedger.open({ path: ledgerPath });
    await ledger.credit("acct_a", 10);
    await ledger.credit("acct_a", 10);
    const entries = await fs.readdir(workDir);
    expect(entries.filter((e) => e.endsWith(".tmp"))).toEqual([]);
  });

  it("serializes concurrent writes — final balance is the sum, no lost updates", async () => {
    const ledger = await MockUsdLedger.open({ path: ledgerPath });
    const N = 25;
    await Promise.all(
      Array.from({ length: N }, () => ledger.credit("acct_a", 4)),
    );
    expect(await ledger.getBalance("acct_a")).toBe(N * 4);

    const reopened = await MockUsdLedger.open({ path: ledgerPath });
    expect(await reopened.getBalance("acct_a")).toBe(N * 4);
  });
});
