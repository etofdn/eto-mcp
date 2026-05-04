/**
 * FN-093: Memo indexer for SPL Memo Program v2 instruction data.
 *
 * Ingests confirmed ETO block/transaction memo data into a queryable store.
 * Schema per spec:
 *   (signature, slot, block_time, signer, accounts[], program_ids[],
 *    memo_text, schema_name, schema_version, payload_jsonb)
 *
 * `InMemoryMemoIndex` is the test/dev implementation.
 * `PostgresMemoIndex` is provided in memo-index.postgres.ts.
 * Required prerequisite for FN-061.
 */

export interface MemoEntry {
  /** Transaction signature (base58) */
  signature: string;
  /** Slot number */
  slot: number;
  /** Unix timestamp of the block (seconds) */
  block_time: number;
  /** Primary signer pubkey */
  signer: string;
  /** All account pubkeys referenced in the memo instruction */
  accounts: string[];
  /** Program IDs involved in the transaction */
  program_ids: string[];
  /** Raw decoded memo text */
  memo_text: string;
  /** Optional schema identifier embedded in the memo (e.g. "eto.vc.1") */
  schema_name?: string;
  /** Optional schema version string */
  schema_version?: string;
  /** Optional structured payload parsed from the memo text */
  payload_jsonb?: Record<string, unknown>;
}

export interface MemoQuery {
  /** Filter by one or more signer pubkeys (OR match) */
  signers?: string[];
  /** Filter by schema_name (exact match) */
  schemas?: string[];
  /** Filter by program_id (OR match) */
  programIds?: string[];
  /** Lower bound block_time (inclusive, unix seconds) */
  since?: number;
  /** Upper bound block_time (inclusive, unix seconds) */
  until?: number;
  /** Max results to return (default: 50) */
  limit?: number;
  /** Opaque cursor for pagination (last seen signature) */
  cursor?: string;
}

export interface MemoQueryResult {
  entries: MemoEntry[];
  /** Cursor to pass for the next page; undefined when no more results */
  nextCursor?: string;
}

/**
 * MemoIndex — pluggable interface for memo storage implementations.
 */
export interface MemoIndex {
  /** Ingest a single memo entry. Idempotent on signature. */
  ingest(entry: MemoEntry): Promise<void>;
  /** Ingest multiple entries atomically where supported. */
  ingestBatch(entries: MemoEntry[]): Promise<void>;
  /** Query stored memos with optional filters, limit, and cursor. */
  query(q: MemoQuery): Promise<MemoQueryResult>;
}

// ─── InMemoryMemoIndex ─────────────────────────────────────────────────────

/**
 * In-memory implementation of MemoIndex for tests and local dev.
 * Entries are stored sorted by (block_time DESC, signature ASC).
 */
export class InMemoryMemoIndex implements MemoIndex {
  private store: Map<string, MemoEntry> = new Map();

  async ingest(entry: MemoEntry): Promise<void> {
    this.store.set(entry.signature, entry);
  }

  async ingestBatch(entries: MemoEntry[]): Promise<void> {
    for (const e of entries) {
      this.store.set(e.signature, e);
    }
  }

  async query(q: MemoQuery): Promise<MemoQueryResult> {
    const limit = q.limit ?? 50;

    // Sort by block_time desc, then signature asc for stable ordering.
    let sorted = Array.from(this.store.values()).sort((a, b) => {
      if (b.block_time !== a.block_time) return b.block_time - a.block_time;
      return a.signature.localeCompare(b.signature);
    });

    // Apply filters
    if (q.signers && q.signers.length > 0) {
      const set = new Set(q.signers);
      sorted = sorted.filter((e) => set.has(e.signer));
    }
    if (q.schemas && q.schemas.length > 0) {
      const set = new Set(q.schemas);
      sorted = sorted.filter((e) => e.schema_name != null && set.has(e.schema_name));
    }
    if (q.programIds && q.programIds.length > 0) {
      const set = new Set(q.programIds);
      sorted = sorted.filter((e) => e.program_ids.some((p) => set.has(p)));
    }
    if (q.since != null) {
      sorted = sorted.filter((e) => e.block_time >= q.since!);
    }
    if (q.until != null) {
      sorted = sorted.filter((e) => e.block_time <= q.until!);
    }

    // Cursor: skip until we find the cursor signature, then take from there.
    if (q.cursor) {
      const idx = sorted.findIndex((e) => e.signature === q.cursor);
      if (idx !== -1) {
        sorted = sorted.slice(idx + 1);
      }
    }

    const page = sorted.slice(0, limit);
    const nextCursor =
      sorted.length > limit ? sorted[limit - 1].signature : undefined;

    return { entries: page, nextCursor };
  }
}
