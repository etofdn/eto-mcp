/**
 * FN-093: PostgresMemoIndex — Postgres-backed implementation of MemoIndex.
 *
 * Mirrors the pattern in postgres-event-source.ts: accepts a pg-compatible
 * query function at construction time so callers can inject their own pool
 * or test double without depending on a live database.
 *
 * Schema (run once via migration or manually):
 *
 *   CREATE TABLE IF NOT EXISTS memo_entries (
 *     signature     TEXT PRIMARY KEY,
 *     slot          BIGINT NOT NULL,
 *     block_time    BIGINT NOT NULL,
 *     signer        TEXT NOT NULL,
 *     accounts      TEXT[] NOT NULL DEFAULT '{}',
 *     program_ids   TEXT[] NOT NULL DEFAULT '{}',
 *     memo_text     TEXT NOT NULL,
 *     schema_name   TEXT,
 *     schema_version TEXT,
 *     payload_jsonb  JSONB
 *   );
 *
 *   CREATE INDEX IF NOT EXISTS idx_memo_signer      ON memo_entries(signer);
 *   CREATE INDEX IF NOT EXISTS idx_memo_schema_name ON memo_entries(schema_name);
 *   CREATE INDEX IF NOT EXISTS idx_memo_block_time  ON memo_entries(block_time DESC);
 *
 * Export the schema string for use in migrations.
 */

import type { MemoEntry, MemoIndex, MemoQuery, MemoQueryResult } from "./memo-index.js";

export const MEMO_ENTRIES_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS memo_entries (
  signature      TEXT PRIMARY KEY,
  slot           BIGINT NOT NULL,
  block_time     BIGINT NOT NULL,
  signer         TEXT NOT NULL,
  accounts       TEXT[] NOT NULL DEFAULT '{}',
  program_ids    TEXT[] NOT NULL DEFAULT '{}',
  memo_text      TEXT NOT NULL,
  schema_name    TEXT,
  schema_version TEXT,
  payload_jsonb  JSONB
);

CREATE INDEX IF NOT EXISTS idx_memo_signer
  ON memo_entries(signer);
CREATE INDEX IF NOT EXISTS idx_memo_schema_name
  ON memo_entries(schema_name);
CREATE INDEX IF NOT EXISTS idx_memo_block_time
  ON memo_entries(block_time DESC);
`.trim();

/** Minimal pg-compatible query interface so callers inject their own pool. */
export interface PgQueryFn {
  (sql: string, values?: any[]): Promise<{ rows: any[] }>;
}

export interface PostgresMemoIndexInit {
  query: PgQueryFn;
}

export class PostgresMemoIndex implements MemoIndex {
  private query: PgQueryFn;

  constructor(init: PostgresMemoIndexInit) {
    this.query = init.query;
  }

  async ingest(entry: MemoEntry): Promise<void> {
    await this.query(
      `INSERT INTO memo_entries
         (signature, slot, block_time, signer, accounts, program_ids,
          memo_text, schema_name, schema_version, payload_jsonb)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
       ON CONFLICT (signature) DO NOTHING`,
      [
        entry.signature,
        entry.slot,
        entry.block_time,
        entry.signer,
        entry.accounts,
        entry.program_ids,
        entry.memo_text,
        entry.schema_name ?? null,
        entry.schema_version ?? null,
        entry.payload_jsonb ? JSON.stringify(entry.payload_jsonb) : null,
      ],
    );
  }

  async ingestBatch(entries: MemoEntry[]): Promise<void> {
    // Sequential upsert — production callers should wrap in a transaction.
    for (const e of entries) {
      await this.ingest(e);
    }
  }

  async query(q: MemoQuery): Promise<MemoQueryResult> {
    const limit = (q.limit ?? 50) + 1; // fetch one extra to detect next page
    const conditions: string[] = [];
    const values: any[] = [];
    let idx = 1;

    if (q.signers && q.signers.length > 0) {
      conditions.push(`signer = ANY($${idx++})`);
      values.push(q.signers);
    }
    if (q.schemas && q.schemas.length > 0) {
      conditions.push(`schema_name = ANY($${idx++})`);
      values.push(q.schemas);
    }
    if (q.programIds && q.programIds.length > 0) {
      conditions.push(`program_ids && $${idx++}`);
      values.push(q.programIds);
    }
    if (q.since != null) {
      conditions.push(`block_time >= $${idx++}`);
      values.push(q.since);
    }
    if (q.until != null) {
      conditions.push(`block_time <= $${idx++}`);
      values.push(q.until);
    }
    if (q.cursor) {
      // Cursor is the last seen signature; use keyset pagination on
      // (block_time DESC, signature ASC) to match the in-memory sort.
      conditions.push(
        `(block_time, signature) < (
          SELECT block_time, signature FROM memo_entries WHERE signature = $${idx++}
        )`,
      );
      values.push(q.cursor);
    }

    const where =
      conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
    const sql = `
      SELECT signature, slot, block_time, signer, accounts, program_ids,
             memo_text, schema_name, schema_version, payload_jsonb
      FROM memo_entries
      ${where}
      ORDER BY block_time DESC, signature ASC
      LIMIT $${idx}
    `;
    values.push(limit);

    const { rows } = await this.query(sql, values);

    const pageLimit = (q.limit ?? 50);
    const hasMore = rows.length > pageLimit;
    const page = hasMore ? rows.slice(0, pageLimit) : rows;

    const entries: MemoEntry[] = page.map((r) => ({
      signature: r.signature,
      slot: Number(r.slot),
      block_time: Number(r.block_time),
      signer: r.signer,
      accounts: r.accounts ?? [],
      program_ids: r.program_ids ?? [],
      memo_text: r.memo_text,
      schema_name: r.schema_name ?? undefined,
      schema_version: r.schema_version ?? undefined,
      payload_jsonb: r.payload_jsonb ?? undefined,
    }));

    const nextCursor = hasMore ? page[page.length - 1].signature : undefined;
    return { entries, nextCursor };
  }
}
