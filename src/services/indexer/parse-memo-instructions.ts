/**
 * FN-105: Pure memo-instruction parser.
 *
 * Extracts MemoEntry records from a confirmed Solana transaction JSON-RPC
 * response. All logic is side-effect-free; the ingester (memo-ingester.ts)
 * owns the I/O.
 */

import bs58 from "bs58";
import type { MemoEntry } from "./memo-index.js";

// matches src/wasm/index.ts:30
export const MEMO_PROGRAM_ID = "MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr";

// ---------------------------------------------------------------------------
// Minimal Solana JSON-RPC transaction shape (only the fields we read)
// ---------------------------------------------------------------------------

export interface ConfirmedTxLike {
  transaction: {
    signatures: readonly string[];
    message: {
      accountKeys: readonly string[];
      instructions: readonly {
        programIdIndex: number;
        accounts: readonly number[];
        data: string;
      }[];
      header: {
        numRequiredSignatures: number;
        numReadonlySignedAccounts: number;
        numReadonlyUnsignedAccounts: number;
      };
    };
  };
  meta: { err: unknown } | null;
}

// ---------------------------------------------------------------------------
// tryParseMemoEnvelope
// ---------------------------------------------------------------------------

/**
 * Attempt to parse a memo text as a typed envelope per docs/memo-schema-registry.md.
 *
 * Rules:
 * - JSON.parse failure → all null.
 * - Non-object / array → all null (payload null too).
 * - Object without non-empty string `schema` AND `version` → payload kept, names null.
 * - Object with both `schema` and `version` → full population.
 */
export function tryParseMemoEnvelope(memoText: string): {
  schema_name: string | null;
  schema_version: string | null;
  payload: Record<string, unknown> | null;
} {
  let parsed: unknown;
  try {
    parsed = JSON.parse(memoText);
  } catch {
    return { schema_name: null, schema_version: null, payload: null };
  }

  if (
    typeof parsed !== "object" ||
    parsed === null ||
    Array.isArray(parsed)
  ) {
    return { schema_name: null, schema_version: null, payload: null };
  }

  const obj = parsed as Record<string, unknown>;
  const schema = obj["schema"];
  const version = obj["version"];

  if (typeof schema === "string" && schema.length > 0 &&
      typeof version === "string" && version.length > 0) {
    return {
      schema_name: schema,
      schema_version: version,
      payload: obj,
    };
  }

  return {
    schema_name: null,
    schema_version: null,
    payload: obj,
  };
}

// ---------------------------------------------------------------------------
// extractMemoEntries
// ---------------------------------------------------------------------------

/**
 * Extract zero or more MemoEntry records from a confirmed transaction.
 *
 * Returns [] for failed transactions (meta.err != null).
 * Throws for instructions that produce an invalid entry (empty signer).
 */
export function extractMemoEntries(
  tx: ConfirmedTxLike,
  slot: number,
  blockTime: number | null,
  signature: string,
): MemoEntry[] {
  // Skip failed transactions
  if (tx.meta?.err != null) return [];

  const { accountKeys, instructions } = tx.transaction.message;
  const signer = accountKeys[0];

  if (!signer) {
    throw new Error(
      `INVALID_MEMO_RECORD: empty signer for signature=${signature}`,
    );
  }

  // All program IDs present in this transaction (deduped, preserving order)
  const programIdSet = new Set<string>();
  for (const ix of instructions) {
    const pid = accountKeys[ix.programIdIndex];
    if (pid) programIdSet.add(pid);
  }
  const program_ids = Array.from(programIdSet);

  // Full account list (already unique within a Solana message)
  const accounts = Array.from(accountKeys);

  const results: MemoEntry[] = [];

  for (const ix of instructions) {
    const programId = accountKeys[ix.programIdIndex];
    if (programId !== MEMO_PROGRAM_ID) continue;

    // Decode memo data: try bs58 → utf8, fall back to treating data as raw UTF-8.
    let memoText: string;
    try {
      const decoded = bs58.decode(ix.data);
      const candidate = new TextDecoder("utf-8", { fatal: false }).decode(decoded);
      // Accept the decoded string only if it has no replacement characters
      if (!candidate.includes("�")) {
        memoText = candidate;
      } else {
        memoText = ix.data;
      }
    } catch {
      memoText = ix.data;
    }

    const { schema_name, schema_version, payload_jsonb } = (() => {
      const e = tryParseMemoEnvelope(memoText);
      return {
        schema_name: e.schema_name ?? undefined,
        schema_version: e.schema_version ?? undefined,
        payload_jsonb: e.payload ?? undefined,
      };
    })();

    const entry: MemoEntry = {
      signature,
      slot,
      block_time: blockTime ?? 0,
      signer,
      accounts,
      program_ids,
      memo_text: memoText,
      schema_name,
      schema_version,
      payload_jsonb,
    };

    results.push(entry);
  }

  return results;
}
