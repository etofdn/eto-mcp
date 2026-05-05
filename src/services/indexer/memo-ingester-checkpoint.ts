/**
 * FN-105: Checkpoint store for MemoBlockIngester.
 *
 * Persists the highest fully-flushed slot so a restarted ingester can
 * resume without re-processing already-ingested slots.
 *
 * Mirrors the PostgresMemoIndex constructor pattern: one of `pool` or
 * `connectionString` is required; `pool` injection is preferred for tests.
 */

import { Pool } from "pg";

// ---------------------------------------------------------------------------
// Error
// ---------------------------------------------------------------------------

export class MemoIngesterError extends Error {
  constructor(
    public readonly code: "INVALID_CHECKPOINT" | "RPC_FAILURE" | "WS_FAILURE",
    message: string,
  ) {
    super(message);
    this.name = "MemoIngesterError";
  }
}

// ---------------------------------------------------------------------------
// Interface
// ---------------------------------------------------------------------------

export interface MemoIngesterCheckpointStore {
  load(id: string): Promise<{ lastSlot: number } | null>;
  save(id: string, lastSlot: number): Promise<void>;
  close(): Promise<void>;
}

// ---------------------------------------------------------------------------
// InMemoryCheckpointStore
// ---------------------------------------------------------------------------

export class InMemoryCheckpointStore implements MemoIngesterCheckpointStore {
  private store: Map<string, number> = new Map();

  async load(id: string): Promise<{ lastSlot: number } | null> {
    const v = this.store.get(id);
    return v !== undefined ? { lastSlot: v } : null;
  }

  async save(id: string, lastSlot: number): Promise<void> {
    this.store.set(id, lastSlot);
  }

  async close(): Promise<void> {
    // no-op
  }
}

// ---------------------------------------------------------------------------
// PostgresCheckpointStore
// ---------------------------------------------------------------------------

export interface PostgresCheckpointStoreInit {
  pool?: Pool;
  connectionString?: string;
}

export class PostgresCheckpointStore implements MemoIngesterCheckpointStore {
  private readonly pool: Pool;
  private readonly ownsPool: boolean;

  constructor(init: PostgresCheckpointStoreInit) {
    if (init.pool) {
      this.pool = init.pool;
      this.ownsPool = false;
    } else if (init.connectionString) {
      this.pool = new Pool({ connectionString: init.connectionString });
      this.ownsPool = true;
    } else {
      throw new MemoIngesterError(
        "INVALID_CHECKPOINT",
        "PostgresCheckpointStore requires pool or connectionString",
      );
    }
  }

  async load(id: string): Promise<{ lastSlot: number } | null> {
    const { rows } = await this.pool.query(
      "SELECT last_slot FROM memo_ingester_checkpoint WHERE id = $1",
      [id],
    );
    if (rows.length === 0) return null;
    return { lastSlot: Number(rows[0].last_slot) };
  }

  async save(id: string, lastSlot: number): Promise<void> {
    if (!Number.isInteger(lastSlot) || lastSlot < 0) {
      throw new MemoIngesterError(
        "INVALID_CHECKPOINT",
        `lastSlot must be a non-negative integer, got ${lastSlot}`,
      );
    }
    await this.pool.query(
      `INSERT INTO memo_ingester_checkpoint (id, last_slot)
       VALUES ($1, $2)
       ON CONFLICT (id) DO UPDATE SET last_slot = EXCLUDED.last_slot, updated_at = NOW()`,
      [id, lastSlot],
    );
  }

  async close(): Promise<void> {
    if (this.ownsPool) await this.pool.end();
  }
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createCheckpointStoreFromEnv(
  env: Record<string, string | undefined> = process.env as Record<string, string | undefined>,
): MemoIngesterCheckpointStore {
  const url = env["MEMO_INGESTER_DB_URL"] ?? env["AUDIT_DB_URL"];
  if (url) {
    return new PostgresCheckpointStore({ connectionString: url });
  }
  return new InMemoryCheckpointStore();
}
