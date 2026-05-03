// PostgresKytEventSource — durable Postgres-backed KytEventSource (FN-083).
//
// Implements the `KytEventSource` interface from `audit-trail.ts` using a
// Postgres pool.  Large result windows are streamed via a server-side cursor
// so the process never buffers an unbounded result set.
//
// Ingest methods (`ingestTrace`, `ingestRevocation`) are concrete-class API
// (not part of the `KytEventSource` interface) and use ON CONFLICT DO NOTHING
// for idempotent upserts.
//
// Factory: `createKytEventSourceFromEnv` reads `process.env.AUDIT_DB_URL`.
//   - Set  → PostgresKytEventSource (production)
//   - Unset → InMemoryKytEventSource({ traces: [] }) (test / dev fallback)

import { type PoolClient, Pool } from "pg";

import {
  AuditTrailIndexerError,
  InMemoryKytEventSource,
  type KytEventSource,
  type KytEventSourceQueryOpts,
} from "./audit-trail.js";
import {
  type KytTraceEvent,
  type RevocationRootUpdatedEvent,
  kytTraceEventSchema,
  revocationRootUpdatedEventSchema,
} from "./audit-trail.types.js";

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/** Number of rows to fetch per cursor FETCH round-trip. */
const CURSOR_BATCH = 500;

/** Unique cursor name per query to avoid collisions under concurrent use. */
let _cursorSeq = 0;
function nextCursorName(): string {
  return `_kyt_cur_${Date.now()}_${++_cursorSeq}`;
}

// ---------------------------------------------------------------------------
// PostgresKytEventSource
// ---------------------------------------------------------------------------

export interface PostgresKytEventSourceInit {
  /**
   * An existing `Pool` to borrow.  The pool will NOT be closed when
   * `close()` is called — the caller retains ownership.
   */
  pool?: Pool;
  /** Connection string used to construct a new, owned `Pool`. */
  connectionString?: string;
}

/**
 * Postgres-backed implementation of `KytEventSource`.
 *
 * Pass either an existing `pool` (for tests / shared pools) or a
 * `connectionString` to let the class own its pool.  When the class owns
 * the pool, `close()` drains it; otherwise `close()` is a no-op.
 */
export class PostgresKytEventSource implements KytEventSource {
  private readonly pool: Pool;
  private readonly ownsPool: boolean;

  public constructor(init: PostgresKytEventSourceInit) {
    if (init.pool) {
      this.pool = init.pool;
      this.ownsPool = false;
    } else if (init.connectionString) {
      this.pool = new Pool({ connectionString: init.connectionString });
      this.ownsPool = true;
    } else {
      throw new Error(
        "PostgresKytEventSource: either `pool` or `connectionString` must be provided",
      );
    }
  }

  // -------------------------------------------------------------------------
  // KytEventSource — tracesForAuthority
  // -------------------------------------------------------------------------

  /**
   * Yield every `KytTraceEvent` involving `authority` (in either BAP or BPP
   * slot) within the requested slot window, in ascending `(slot, tx_signature)`
   * order.  Uses a server-side cursor to stream large windows without buffering.
   */
  public async *tracesForAuthority(
    authority: string,
    opts?: KytEventSourceQueryOpts,
  ): AsyncIterable<KytTraceEvent> {
    if (!authority) {
      throw new AuditTrailIndexerError(
        "INVALID_AUTHORITY",
        "authority must be a non-empty base58 string",
      );
    }

    const client = await this.pool.connect();
    const cursorName = nextCursorName();

    try {
      // Build parameterised query.
      const params: (string | number)[] = [authority];
      let slotClause = "";
      if (opts?.sinceSlot !== undefined) {
        params.push(opts.sinceSlot);
        slotClause += ` AND slot >= $${params.length}`;
      }
      if (opts?.untilSlot !== undefined) {
        params.push(opts.untilSlot);
        slotClause += ` AND slot < $${params.length}`;
      }

      const selectSql = `
        SELECT
          stage,
          tx_signature,
          slot,
          chain_timestamp  AS "timestamp",
          bap_authority,
          bpp_authority,
          bap_cred_pointers,
          bpp_cred_pointers
        FROM kyt_events
        WHERE (bap_authority = $1 OR bpp_authority = $1)
        ${slotClause}
        ORDER BY slot ASC, tx_signature ASC
      `;

      await client.query("BEGIN");
      await client.query(
        `DECLARE ${cursorName} NO SCROLL CURSOR FOR ${selectSql}`,
        params,
      );

      yield* this._fetchTraceCursor(client, cursorName, authority);

      await client.query("COMMIT");
    } catch (err) {
      await this._safeRollback(client);
      throw err;
    } finally {
      client.release();
    }
  }

  private async *_fetchTraceCursor(
    client: PoolClient,
    cursorName: string,
    authority: string,
  ): AsyncIterable<KytTraceEvent> {
    while (true) {
      const result = await client.query<{
        stage: string;
        tx_signature: string;
        slot: string;
        timestamp: string;
        bap_authority: string;
        bpp_authority: string;
        bap_cred_pointers: string[];
        bpp_cred_pointers: string[];
      }>(`FETCH FORWARD ${CURSOR_BATCH} FROM ${cursorName}`);

      if (result.rows.length === 0) break;

      for (const row of result.rows) {
        const raw = {
          stage: row.stage,
          tx_signature: row.tx_signature,
          slot: Number(row.slot),
          timestamp: Number(row.timestamp),
          parties: [
            {
              party: "bap" as const,
              authority: row.bap_authority,
              cred_pointers: row.bap_cred_pointers ?? [],
            },
            {
              party: "bpp" as const,
              authority: row.bpp_authority,
              cred_pointers: row.bpp_cred_pointers ?? [],
            },
          ] as [
            { party: "bap"; authority: string; cred_pointers: string[] },
            { party: "bpp"; authority: string; cred_pointers: string[] },
          ],
        };

        const parsed = kytTraceEventSchema.safeParse(raw);
        if (!parsed.success) {
          throw new AuditTrailIndexerError(
            "INVALID_KYT_EVENT",
            `postgres: stored row failed schema validation: ${parsed.error.message}`,
            parsed.error.issues,
          );
        }
        yield parsed.data;
      }

      if (result.rows.length < CURSOR_BATCH) break;
    }
  }

  // -------------------------------------------------------------------------
  // KytEventSource — revocationsForCredentialIssuers
  // -------------------------------------------------------------------------

  /**
   * Yield every `RevocationRootUpdatedEvent` whose `oracle` is in `issuers`
   * (or all events when `issuers` is empty) within the requested slot window,
   * in ascending `(slot, oracle, root)` order.  Uses a server-side cursor.
   */
  public async *revocationsForCredentialIssuers(
    issuers: readonly string[],
    opts?: KytEventSourceQueryOpts,
  ): AsyncIterable<RevocationRootUpdatedEvent> {
    const client = await this.pool.connect();
    const cursorName = nextCursorName();

    try {
      // Build WHERE clause and params.
      const whereFragments: string[] = [];
      const freshParams: (string | string[] | number)[] = [];

      if (issuers.length > 0) {
        freshParams.push([...issuers]);
        whereFragments.push(`oracle = ANY($${freshParams.length})`);
      }
      if (opts?.sinceSlot !== undefined) {
        freshParams.push(opts.sinceSlot);
        whereFragments.push(`slot >= $${freshParams.length}`);
      }
      if (opts?.untilSlot !== undefined) {
        freshParams.push(opts.untilSlot);
        whereFragments.push(`slot < $${freshParams.length}`);
      }

      const whereClause =
        whereFragments.length > 0
          ? `WHERE ${whereFragments.join(" AND ")}`
          : "";

      const selectSql = `
        SELECT oracle, network, root, leaves, slot
        FROM revocation_events
        ${whereClause}
        ORDER BY slot ASC, oracle ASC, root ASC
      `;

      await client.query("BEGIN");
      await client.query(
        `DECLARE ${cursorName} NO SCROLL CURSOR FOR ${selectSql}`,
        freshParams,
      );

      yield* this._fetchRevocationCursor(client, cursorName);

      await client.query("COMMIT");
    } catch (err) {
      await this._safeRollback(client);
      throw err;
    } finally {
      client.release();
    }
  }

  private async *_fetchRevocationCursor(
    client: PoolClient,
    cursorName: string,
  ): AsyncIterable<RevocationRootUpdatedEvent> {
    while (true) {
      const result = await client.query<{
        oracle: string;
        network: string;
        root: string;
        leaves: string;
        slot: string;
      }>(`FETCH FORWARD ${CURSOR_BATCH} FROM ${cursorName}`);

      if (result.rows.length === 0) break;

      for (const row of result.rows) {
        const raw = {
          oracle: row.oracle,
          network: row.network,
          root: row.root,
          leaves: Number(row.leaves),
          slot: Number(row.slot),
        };

        const parsed = revocationRootUpdatedEventSchema.safeParse(raw);
        if (!parsed.success) {
          throw new AuditTrailIndexerError(
            "INVALID_REVOCATION_EVENT",
            `postgres: stored row failed schema validation: ${parsed.error.message}`,
            parsed.error.issues,
          );
        }
        yield parsed.data;
      }

      if (result.rows.length < CURSOR_BATCH) break;
    }
  }

  // -------------------------------------------------------------------------
  // Concrete-class ingest API (not on KytEventSource interface)
  // -------------------------------------------------------------------------

  /**
   * Persist a single `KytTraceEvent`.  Validates via zod schema before
   * inserting.  On duplicate `tx_signature` the row is silently skipped
   * (`inserted: false`).
   */
  public async ingestTrace(
    trace: KytTraceEvent,
  ): Promise<{ inserted: boolean }> {
    const parsed = kytTraceEventSchema.safeParse(trace);
    if (!parsed.success) {
      throw new AuditTrailIndexerError(
        "INVALID_KYT_EVENT",
        `ingestTrace: invalid KytTraceEvent: ${parsed.error.message}`,
        parsed.error.issues,
      );
    }
    const ev = parsed.data;
    const [bap, bpp] = ev.parties;

    const result = await this.pool.query<{ id: string }>(
      `INSERT INTO kyt_events
         (tx_signature, slot, stage, chain_timestamp,
          bap_authority, bpp_authority,
          bap_cred_pointers, bpp_cred_pointers)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       ON CONFLICT (tx_signature) DO NOTHING
       RETURNING id`,
      [
        ev.tx_signature,
        ev.slot,
        ev.stage,
        ev.timestamp,
        bap!.authority,
        bpp!.authority,
        bap!.cred_pointers,
        bpp!.cred_pointers,
      ],
    );

    return { inserted: result.rowCount != null && result.rowCount > 0 };
  }

  /**
   * Persist a single `RevocationRootUpdatedEvent`.  Validates via zod schema.
   * On duplicate `(oracle, root, slot)` the row is silently skipped
   * (`inserted: false`).
   */
  public async ingestRevocation(
    event: RevocationRootUpdatedEvent,
  ): Promise<{ inserted: boolean }> {
    const parsed = revocationRootUpdatedEventSchema.safeParse(event);
    if (!parsed.success) {
      throw new AuditTrailIndexerError(
        "INVALID_REVOCATION_EVENT",
        `ingestRevocation: invalid RevocationRootUpdatedEvent: ${parsed.error.message}`,
        parsed.error.issues,
      );
    }
    const ev = parsed.data;

    const result = await this.pool.query<{ id: string }>(
      `INSERT INTO revocation_events
         (oracle, network, root, leaves, slot)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (oracle, root, slot) DO NOTHING
       RETURNING id`,
      [ev.oracle, ev.network, ev.root, ev.leaves, ev.slot],
    );

    return { inserted: result.rowCount != null && result.rowCount > 0 };
  }

  // -------------------------------------------------------------------------
  // Lifecycle
  // -------------------------------------------------------------------------

  /**
   * Drain the connection pool.  Only called when this class constructed the
   * pool from a connection string; borrowed pools are NOT ended.
   */
  public async close(): Promise<void> {
    if (this.ownsPool) {
      await this.pool.end();
    }
  }

  // -------------------------------------------------------------------------
  // Internal utilities
  // -------------------------------------------------------------------------

  private async _safeRollback(client: PoolClient): Promise<void> {
    try {
      await client.query("ROLLBACK");
    } catch {
      // Ignore rollback errors — the connection may already be in an error
      // state; the important thing is we release it below.
    }
  }
}

// ---------------------------------------------------------------------------
// Environment-driven factory
// ---------------------------------------------------------------------------

/**
 * Create a `KytEventSource` driven by environment variables.
 *
 * - `AUDIT_DB_URL` set to a non-empty string → returns a new
 *   `PostgresKytEventSource` connected to that URL.
 * - `AUDIT_DB_URL` absent or empty → returns an empty
 *   `InMemoryKytEventSource` (suitable for local dev / tests that do not
 *   require durable storage).
 *
 * @param env  Defaults to `process.env`.  Override in tests to avoid touching
 *   the real process environment.
 *
 * @remarks
 * Callers that need a pre-seeded in-memory source (e.g. unit tests with
 * fixture events) should construct `InMemoryKytEventSource` directly rather
 * than relying on this factory.
 */
export function createKytEventSourceFromEnv(
  env: Record<string, string | undefined> = process.env,
): KytEventSource {
  const url = env["AUDIT_DB_URL"];
  if (typeof url === "string" && url.length > 0) {
    return new PostgresKytEventSource({ connectionString: url });
  }
  return new InMemoryKytEventSource({ traces: [] });
}
