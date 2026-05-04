// Integration tests for PostgresKytEventSource (FN-083).
//
// These tests require a real Postgres database.  They are gated behind the
// TEST_PG_URL environment variable and silently skipped when it is not set,
// so CI never fails due to a missing database.
//
// To run locally:
//   TEST_PG_URL=postgres://user:pass@localhost/dbname npx vitest run tests/indexer/postgres-event-source.test.ts

import * as fs from "node:fs";
import * as path from "node:path";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { AuditTrailIndexerError } from "../../src/services/indexer/audit-trail.js";
import { PostgresKytEventSource } from "../../src/services/indexer/postgres-event-source.js";
import type {
  KytTraceEvent,
  RevocationRootUpdatedEvent,
} from "../../src/services/indexer/audit-trail.types.js";

// ---------------------------------------------------------------------------
// Base58-safe fixture strings
// Base58 alphabet: 123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz
// Excluded chars:  0 (digit zero), O (capital oh), I (capital I), l (lowercase L)
// ---------------------------------------------------------------------------

/** Pad a distinctive prefix to a valid base58 string of length 88. */
function b58pad(prefix: string): string {
  const safe = prefix.replace(/[0OIl]/g, "A");
  return safe.padEnd(88, "A").slice(0, 88);
}

// Distinct authorities — all base58-safe (no 0, O, I, l).
const AUTH_A = "AuthAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const AUTH_B = "AuthBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB";
const AUTH_C = "AuthCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC";
const AUTH_WIN = "WndAuthorityAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const AUTH_WIN_BPP = "WndBppAuthorityAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const AUTH_DUP_BAP = "DupBapAuthorityAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const AUTH_DUP_BPP = "DupBppAuthorityAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const AUTH_BAD_BAP = "BadBapAuthorityAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const AUTH_BAD_BPP = "BadBppAuthorityAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const ORACLE_A = "RevAuthorityAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";

// Distinct tx_signatures for each test (must be valid base58).
const SIG_T1 = b58pad("RoundTripSigAAA1");   // test 1, trace 1
const SIG_T2 = b58pad("RoundTripSigAAA2");   // test 1, trace 2
const SIG_T3 = b58pad("RoundTripSigAAA3");   // test 1, trace 3
const SIG_DUP = b58pad("DuplicateSigAAAA");  // test 2 (idempotency)
const SIG_W1 = b58pad("WinSigSSSSSSlAA1");  // test 3 slot 10 — no invalid chars
const SIG_W2 = b58pad("WinSigSSSSSSlAA2");  // test 3 slot 20
const SIG_W3 = b58pad("WinSigSSSSSSlAA3");  // test 3 slot 30
const SIG_W4 = b58pad("WinSigSSSSSSlAA4");  // test 3 slot 40
const SIG_W5 = b58pad("WinSigSSSSSSlAA5");  // test 3 slot 50
const SIG_BAD = b58pad("BadCredsTestAAA1"); // test 5 (validation)

// ---------------------------------------------------------------------------
// Helpers — fixture factories
// ---------------------------------------------------------------------------

function makeTrace(
  tx_signature: string,
  slot: number,
  bapAuthority: string,
  bppAuthority: string,
  stage: KytTraceEvent["stage"] = "init",
  timestamp = 1700000000,
): KytTraceEvent {
  return {
    stage,
    tx_signature,
    slot,
    timestamp,
    parties: [
      { party: "bap", authority: bapAuthority, cred_pointers: [] },
      { party: "bpp", authority: bppAuthority, cred_pointers: [] },
    ],
  };
}

function makeRevocation(overrides: Partial<RevocationRootUpdatedEvent>): RevocationRootUpdatedEvent {
  return {
    oracle: ORACLE_A,
    network: "testnet",
    root: "a".repeat(64),
    leaves: 10,
    slot: 200,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Suite — gated on TEST_PG_URL
// ---------------------------------------------------------------------------

const PG_URL = process.env["TEST_PG_URL"];

describe.skipIf(!PG_URL)("PostgresKytEventSource integration", () => {
  let pool: Pool;
  let source: PostgresKytEventSource;

  const MIGRATION_PATH = path.resolve(
    __dirname,
    "../../scripts/migrations/001_kyt_events.sql",
  );

  beforeAll(async () => {
    pool = new Pool({ connectionString: PG_URL! });
    source = new PostgresKytEventSource({ pool });

    // Apply migration (idempotent) then truncate for a clean slate.
    const migrationSql = fs.readFileSync(MIGRATION_PATH, "utf8");
    await pool.query(migrationSql);
    await pool.query("TRUNCATE kyt_events, revocation_events");
  });

  afterAll(async () => {
    try {
      await pool.query("DROP TABLE IF EXISTS kyt_events");
      await pool.query("DROP TABLE IF EXISTS revocation_events");
    } finally {
      await pool.end();
    }
  });

  // -------------------------------------------------------------------------
  // 1. Round-trip: ingest 3 traces, query by authority
  // -------------------------------------------------------------------------
  it("round-trip: ingest 3 traces and retrieve by authority", async () => {
    await pool.query("TRUNCATE kyt_events, revocation_events");

    // t1 and t2 involve AUTH_A; t3 does not.
    const t1 = makeTrace(SIG_T1, 10, AUTH_A, AUTH_B);
    const t2 = makeTrace(SIG_T2, 20, AUTH_A, AUTH_C);
    const t3 = makeTrace(SIG_T3, 30, AUTH_B, AUTH_C);

    await source.ingestTrace(t1);
    await source.ingestTrace(t2);
    await source.ingestTrace(t3);

    const results: KytTraceEvent[] = [];
    for await (const ev of source.tracesForAuthority(AUTH_A)) {
      results.push(ev);
    }

    expect(results).toHaveLength(2);
    expect(results[0]!.tx_signature).toBe(SIG_T1);
    expect(results[1]!.tx_signature).toBe(SIG_T2);
    // Ascending slot order
    expect(results[0]!.slot).toBeLessThan(results[1]!.slot);
  });

  // -------------------------------------------------------------------------
  // 2. Idempotency: duplicate ingest returns inserted: false
  // -------------------------------------------------------------------------
  it("idempotency: duplicate trace ingest returns { inserted: false }", async () => {
    await pool.query("TRUNCATE kyt_events, revocation_events");

    const t = makeTrace(SIG_DUP, 50, AUTH_DUP_BAP, AUTH_DUP_BPP);

    const first = await source.ingestTrace(t);
    const second = await source.ingestTrace(t);

    expect(first.inserted).toBe(true);
    expect(second.inserted).toBe(false);

    const { rows } = await pool.query<{ count: string }>(
      "SELECT COUNT(*) AS count FROM kyt_events WHERE tx_signature = $1",
      [SIG_DUP],
    );
    expect(Number(rows[0]!.count)).toBe(1);
  });

  // -------------------------------------------------------------------------
  // 3. Slot-window filtering: sinceSlot inclusive, untilSlot exclusive
  // -------------------------------------------------------------------------
  it("slot-window: sinceSlot=20 untilSlot=40 yields exactly slots 20 and 30", async () => {
    await pool.query("TRUNCATE kyt_events, revocation_events");

    const traces = [
      makeTrace(SIG_W1, 10, AUTH_WIN, AUTH_WIN_BPP),
      makeTrace(SIG_W2, 20, AUTH_WIN, AUTH_WIN_BPP),
      makeTrace(SIG_W3, 30, AUTH_WIN, AUTH_WIN_BPP),
      makeTrace(SIG_W4, 40, AUTH_WIN, AUTH_WIN_BPP),
      makeTrace(SIG_W5, 50, AUTH_WIN, AUTH_WIN_BPP),
    ];
    for (const t of traces) {
      await source.ingestTrace(t);
    }

    const results: KytTraceEvent[] = [];
    for await (const ev of source.tracesForAuthority(AUTH_WIN, {
      sinceSlot: 20,
      untilSlot: 40,
    })) {
      results.push(ev);
    }

    // sinceSlot=20 inclusive, untilSlot=40 exclusive → slots 20 and 30 only
    expect(results).toHaveLength(2);
    expect(results[0]!.slot).toBe(20);
    expect(results[1]!.slot).toBe(30);
  });

  // -------------------------------------------------------------------------
  // 4. Revocation round-trip + idempotency
  // -------------------------------------------------------------------------
  it("revocation: round-trip and idempotency on (oracle, root, slot)", async () => {
    await pool.query("TRUNCATE kyt_events, revocation_events");

    const rev = makeRevocation({
      oracle: ORACLE_A,
      root: "b".repeat(64),
      slot: 500,
    });

    const first = await source.ingestRevocation(rev);
    const second = await source.ingestRevocation(rev);

    expect(first.inserted).toBe(true);
    expect(second.inserted).toBe(false);

    const results: RevocationRootUpdatedEvent[] = [];
    for await (const ev of source.revocationsForCredentialIssuers([ORACLE_A])) {
      results.push(ev);
    }

    expect(results).toHaveLength(1);
    expect(results[0]!.oracle).toBe(ORACLE_A);
    expect(results[0]!.root).toBe("b".repeat(64));
    expect(results[0]!.slot).toBe(500);
  });

  // -------------------------------------------------------------------------
  // 5. Validation: ingestTrace rejects invalid cred_pointer (uppercase hex)
  // -------------------------------------------------------------------------
  it("validation: ingestTrace with uppercase cred_pointer throws INVALID_KYT_EVENT", async () => {
    // Build an otherwise-valid trace but with an uppercase (invalid) cred_pointer.
    // credPointerHex validator: /^[0-9a-f]{64}$/ — uppercase A..F fails.
    const invalid: KytTraceEvent = {
      stage: "init",
      tx_signature: SIG_BAD,
      slot: 999,
      timestamp: 1700000001,
      parties: [
        {
          party: "bap",
          authority: AUTH_BAD_BAP,
          // Uppercase hex — must be rejected by credPointerHex validator.
          cred_pointers: ["A".repeat(64) as string],
        },
        {
          party: "bpp",
          authority: AUTH_BAD_BPP,
          cred_pointers: [],
        },
      ],
    };

    await expect(source.ingestTrace(invalid)).rejects.toSatisfy(
      (err: unknown) =>
        err instanceof AuditTrailIndexerError && err.code === "INVALID_KYT_EVENT",
    );
  });
});
