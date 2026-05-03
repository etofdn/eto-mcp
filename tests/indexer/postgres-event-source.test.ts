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
// Helpers — fixture factories
// ---------------------------------------------------------------------------

/** Build a minimal valid KytTraceEvent. */
function makeTrace(
  overrides: Partial<KytTraceEvent> & { tx_signature: string } & {
    bapAuthority?: string;
    bppAuthority?: string;
  },
): KytTraceEvent {
  const bap = overrides.bapAuthority ?? "BapAuthority1111111111111111111111111111111";
  const bpp = overrides.bppAuthority ?? "BppAuthority1111111111111111111111111111111";
  return {
    stage: "init",
    tx_signature: overrides.tx_signature,
    slot: overrides.slot ?? 100,
    timestamp: overrides.timestamp ?? 1700000000,
    parties: [
      { party: "bap", authority: bap, cred_pointers: [] },
      { party: "bpp", authority: bpp, cred_pointers: [] },
    ],
    ...("stage" in overrides ? { stage: overrides.stage as KytTraceEvent["stage"] } : {}),
  };
}

/** Build a minimal valid RevocationRootUpdatedEvent. */
function makeRevocation(
  overrides: Partial<RevocationRootUpdatedEvent>,
): RevocationRootUpdatedEvent {
  return {
    oracle: overrides.oracle ?? "OracleAuthority111111111111111111111111111",
    network: overrides.network ?? "testnet",
    root: overrides.root ?? "a".repeat(64),
    leaves: overrides.leaves ?? 10,
    slot: overrides.slot ?? 200,
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

    const authorityA = "AuthorityAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
    const authorityB = "AuthorityBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB";
    const authorityC = "AuthorityCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC";

    const t1 = makeTrace({
      tx_signature: "Sig1111111111111111111111111111111111111111111111111111111111111111111111111111111111",
      slot: 10,
      bapAuthority: authorityA,
      bppAuthority: authorityB,
    });
    const t2 = makeTrace({
      tx_signature: "Sig2222222222222222222222222222222222222222222222222222222222222222222222222222222222",
      slot: 20,
      bapAuthority: authorityA,
      bppAuthority: authorityC,
    });
    const t3 = makeTrace({
      tx_signature: "Sig3333333333333333333333333333333333333333333333333333333333333333333333333333333333",
      slot: 30,
      bapAuthority: authorityB,
      bppAuthority: authorityC,
    });

    await source.ingestTrace(t1);
    await source.ingestTrace(t2);
    await source.ingestTrace(t3);

    const results: KytTraceEvent[] = [];
    for await (const ev of source.tracesForAuthority(authorityA)) {
      results.push(ev);
    }

    expect(results).toHaveLength(2);
    expect(results[0]!.tx_signature).toBe(t1.tx_signature);
    expect(results[1]!.tx_signature).toBe(t2.tx_signature);
    // Verify ordering: ascending slot
    expect(results[0]!.slot).toBeLessThan(results[1]!.slot);
  });

  // -------------------------------------------------------------------------
  // 2. Idempotency: duplicate ingest returns inserted: false
  // -------------------------------------------------------------------------
  it("idempotency: duplicate trace ingest returns { inserted: false }", async () => {
    await pool.query("TRUNCATE kyt_events, revocation_events");

    const t = makeTrace({
      tx_signature: "IdempotencySig111111111111111111111111111111111111111111111111111111111111111111111",
      slot: 50,
    });

    const first = await source.ingestTrace(t);
    const second = await source.ingestTrace(t);

    expect(first.inserted).toBe(true);
    expect(second.inserted).toBe(false);

    // Verify only one row in DB
    const { rows } = await pool.query<{ count: string }>(
      "SELECT COUNT(*) AS count FROM kyt_events WHERE tx_signature = $1",
      [t.tx_signature],
    );
    expect(Number(rows[0]!.count)).toBe(1);
  });

  // -------------------------------------------------------------------------
  // 3. Slot-window filtering
  // -------------------------------------------------------------------------
  it("slot-window: sinceSlot inclusive, untilSlot exclusive", async () => {
    await pool.query("TRUNCATE kyt_events, revocation_events");

    const authority = "WindowAuthority1111111111111111111111111111";
    const slots = [10, 20, 30, 40, 50];

    for (let i = 0; i < slots.length; i++) {
      await source.ingestTrace(
        makeTrace({
          tx_signature: `WindowSig${i}${i}${i}${i}${i}${i}${i}${i}${i}${i}${i}${i}${i}${i}${i}${i}${i}${i}${i}${i}${i}${i}${i}${i}${i}${i}${i}${i}${i}${i}${i}${i}${i}${i}${i}${i}${i}${i}${i}${i}${i}${i}${i}${i}${i}${i}${i}${i}${i}${i}${i}${i}${i}${i}${i}${i}${i}${i}${i}${i}${i}${i}${i}${i}${i}${i}${i}${i}${i}${i}${i}${i}${i}${i}${i}${i}${i}${i}${i}${i}${i}${i}${i}${i}${i}`,
          slot: slots[i]!,
          bapAuthority: authority,
          bppAuthority: "BppWindowAuth1111111111111111111111111111111",
        }),
      );
    }

    const results: KytTraceEvent[] = [];
    for await (const ev of source.tracesForAuthority(authority, {
      sinceSlot: 20,
      untilSlot: 40,
    })) {
      results.push(ev);
    }

    // Inclusive lower (20), exclusive upper (40) → slots 20 and 30
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
      oracle: "OracleRoundTrip11111111111111111111111111111",
      root: "b".repeat(64),
      slot: 500,
    });

    const first = await source.ingestRevocation(rev);
    const second = await source.ingestRevocation(rev);

    expect(first.inserted).toBe(true);
    expect(second.inserted).toBe(false);

    const results: RevocationRootUpdatedEvent[] = [];
    for await (const ev of source.revocationsForCredentialIssuers([rev.oracle])) {
      results.push(ev);
    }

    expect(results).toHaveLength(1);
    expect(results[0]!.oracle).toBe(rev.oracle);
    expect(results[0]!.root).toBe(rev.root);
    expect(results[0]!.slot).toBe(rev.slot);
  });

  // -------------------------------------------------------------------------
  // 5. Validation: ingestTrace rejects invalid cred_pointer (uppercase)
  // -------------------------------------------------------------------------
  it("validation: ingestTrace with uppercase cred_pointer throws AuditTrailIndexerError", async () => {
    const invalid: KytTraceEvent = {
      stage: "init",
      tx_signature: "ValidationSig11111111111111111111111111111111111111111111111111111111111111111111111",
      slot: 999,
      timestamp: 1700000001,
      parties: [
        {
          party: "bap",
          authority: "BapAuthority1111111111111111111111111111111",
          // uppercase hex — must be rejected by credPointerHex validator
          cred_pointers: ["A".repeat(64) as string],
        },
        {
          party: "bpp",
          authority: "BppAuthority1111111111111111111111111111111",
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
