// Integration tests for PostgresKytEventSource (FN-083).
// These tests require a live Postgres instance.
//
// Run with:
//   TEST_PG_URL=postgres://user:pass@localhost/dbname pnpm test tests/indexer/postgres-event-source.test.ts
//
// When TEST_PG_URL is not set the entire suite is silently skipped.

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "fs";
import path from "path";
import { Pool } from "pg";
import { PostgresKytEventSource } from "../../src/services/indexer/postgres-event-source.js";
import { AuditTrailIndexerError } from "../../src/services/indexer/audit-trail.js";
import type { KytTraceEvent, RevocationRootUpdatedEvent } from "../../src/services/indexer/audit-trail.types.js";

const PG_URL = process.env["TEST_PG_URL"];

// ---------------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------------

/** Generate a deterministic base58-like authority string for tests. */
function authority(label: string): string {
  // Use a fixed prefix + label to create base58-alphabet-only strings.
  const BASE58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
  const padded = label.padEnd(8, "1");
  return padded
    .split("")
    .map((c, i) => BASE58[((c.charCodeAt(0) + i) % BASE58.length)]!)
    .join("") + "Authority";
}

/** Create a valid lowercase 64-char hex cred pointer. */
function credPointer(seed: number): string {
  return seed.toString(16).padStart(64, "0");
}

/** Make a KytTraceEvent fixture. */
function makeTrace(
  opts: {
    txSig: string;
    slot: number;
    stage?: KytTraceEvent["stage"];
    bap?: string;
    bpp?: string;
    timestamp?: number;
  },
): KytTraceEvent {
  return {
    tx_signature: opts.txSig,
    slot: opts.slot,
    stage: opts.stage ?? "init",
    timestamp: opts.timestamp ?? 1_700_000_000 + opts.slot,
    parties: [
      {
        party: "bap",
        authority: opts.bap ?? authority("Alice"),
        cred_pointers: [credPointer(1)],
      },
      {
        party: "bpp",
        authority: opts.bpp ?? authority("Bob"),
        cred_pointers: [credPointer(2)],
      },
    ],
  };
}

/** Make a RevocationRootUpdatedEvent fixture. */
function makeRevocation(
  opts: {
    oracle: string;
    slot: number;
    root?: string;
  },
): RevocationRootUpdatedEvent {
  return {
    oracle: opts.oracle,
    network: "devnet",
    root: opts.root ?? credPointer(opts.slot),
    leaves: 100,
    slot: opts.slot,
  };
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describe.skipIf(!PG_URL)("PostgresKytEventSource integration", () => {
  let pool: Pool;
  let src: PostgresKytEventSource;

  beforeAll(async () => {
    pool = new Pool({ connectionString: PG_URL });
    src = new PostgresKytEventSource({ pool });

    // Apply the migration (idempotent).
    const migrationPath = path.resolve(
      __dirname,
      "../../scripts/migrations/001_kyt_events.sql",
    );
    const sql = fs.readFileSync(migrationPath, "utf-8");
    await pool.query(sql);

    // Truncate for a clean slate.
    await pool.query("TRUNCATE kyt_events, revocation_events");
  });

  afterAll(async () => {
    await pool.query("DROP TABLE IF EXISTS kyt_events, revocation_events");
    await pool.end();
    // src does NOT own the pool, so close() is a no-op — but call it
    // to exercise the code path.
    await src.close();
  });

  // -----------------------------------------------------------------------
  // Test 1: Round-trip — ingest 3 traces, query by authority
  // -----------------------------------------------------------------------
  it("round-trip: ingest 3 traces, tracesForAuthority returns only matching events in (slot, tx_sig) order", async () => {
    const alice = authority("Alice");
    const bob = authority("Bob");
    const carol = authority("Carol");

    const t1 = makeTrace({ txSig: "RoundTripSig1", slot: 100, bap: alice, bpp: bob });
    const t2 = makeTrace({ txSig: "RoundTripSig2", slot: 200, bap: carol, bpp: alice });
    const t3 = makeTrace({ txSig: "RoundTripSig3", slot: 300, bap: carol, bpp: bob });

    await src.ingestTrace(t1);
    await src.ingestTrace(t2);
    await src.ingestTrace(t3);

    const results: KytTraceEvent[] = [];
    for await (const ev of src.tracesForAuthority(alice)) {
      results.push(ev);
    }

    // t1 (alice=bap, slot=100) and t2 (alice=bpp, slot=200) involve alice.
    // t3 does NOT involve alice.
    expect(results).toHaveLength(2);
    expect(results[0]?.tx_signature).toBe("RoundTripSig1");
    expect(results[1]?.tx_signature).toBe("RoundTripSig2");
    // Slots are in ascending order.
    expect(results[0]?.slot).toBe(100);
    expect(results[1]?.slot).toBe(200);
  });

  // -----------------------------------------------------------------------
  // Test 2: Idempotency — ingest same trace twice
  // -----------------------------------------------------------------------
  it("idempotency: duplicate ingestTrace returns { inserted: false }, table has exactly one row", async () => {
    const trace = makeTrace({ txSig: "IdempotentSig1", slot: 999 });

    const first = await src.ingestTrace(trace);
    const second = await src.ingestTrace(trace);

    expect(first.inserted).toBe(true);
    expect(second.inserted).toBe(false);

    const res = await pool.query(
      "SELECT COUNT(*) AS cnt FROM kyt_events WHERE tx_signature = $1",
      ["IdempotentSig1"],
    );
    expect(Number(res.rows[0]?.cnt)).toBe(1);
  });

  // -----------------------------------------------------------------------
  // Test 3: Slot-window filtering (inclusive lower, exclusive upper)
  // -----------------------------------------------------------------------
  it("slot-window: sinceSlot=20 untilSlot=40 yields slots 20 and 30 (inclusive lower, exclusive upper)", async () => {
    const auth = authority("WindowTest");

    await src.ingestTrace(makeTrace({ txSig: "WinSig10", slot: 10, bap: auth }));
    await src.ingestTrace(makeTrace({ txSig: "WinSig20", slot: 20, bap: auth }));
    await src.ingestTrace(makeTrace({ txSig: "WinSig30", slot: 30, bap: auth }));
    await src.ingestTrace(makeTrace({ txSig: "WinSig40", slot: 40, bap: auth }));
    await src.ingestTrace(makeTrace({ txSig: "WinSig50", slot: 50, bap: auth }));

    const results: KytTraceEvent[] = [];
    for await (const ev of src.tracesForAuthority(auth, {
      sinceSlot: 20,
      untilSlot: 40,
    })) {
      results.push(ev);
    }

    expect(results.map((r) => r.slot)).toEqual([20, 30]);
  });

  // -----------------------------------------------------------------------
  // Test 4: Revocation round-trip + idempotency
  // -----------------------------------------------------------------------
  it("revocation: round-trip and idempotency on (oracle, root, slot)", async () => {
    const oracle = authority("Oracle");
    const rev1 = makeRevocation({ oracle, slot: 500 });
    const rev2 = makeRevocation({ oracle, slot: 600 });

    const ins1a = await src.ingestRevocation(rev1);
    const ins1b = await src.ingestRevocation(rev1); // duplicate
    const ins2 = await src.ingestRevocation(rev2);

    expect(ins1a.inserted).toBe(true);
    expect(ins1b.inserted).toBe(false); // idempotent
    expect(ins2.inserted).toBe(true);

    const results: RevocationRootUpdatedEvent[] = [];
    for await (const ev of src.revocationsForCredentialIssuers([oracle])) {
      results.push(ev);
    }

    // Should get rev1 and rev2 in ascending slot order.
    expect(results).toHaveLength(2);
    expect(results[0]?.slot).toBe(500);
    expect(results[1]?.slot).toBe(600);
    expect(results[0]?.oracle).toBe(oracle);
  });

  // -----------------------------------------------------------------------
  // Test 5: Validation — ingestTrace with invalid cred_pointer (uppercase)
  // -----------------------------------------------------------------------
  it("validation: ingestTrace with uppercase cred_pointer throws AuditTrailIndexerError(INVALID_KYT_EVENT)", async () => {
    const bad: KytTraceEvent = {
      tx_signature: "ValidSigButBadCreds",
      slot: 1,
      stage: "init",
      timestamp: 1_700_000_001,
      parties: [
        {
          party: "bap",
          authority: authority("BadAlice"),
          // Uppercase hex — should fail the credPointerHex validator.
          cred_pointers: ["AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"],
        },
        {
          party: "bpp",
          authority: authority("BadBob"),
          cred_pointers: [credPointer(99)],
        },
      ],
    };

    await expect(src.ingestTrace(bad)).rejects.toSatisfy((err: unknown) => {
      return (
        err instanceof AuditTrailIndexerError &&
        err.code === "INVALID_KYT_EVENT"
      );
    });
  });
});
