// Barrel re-export for the audit-trail indexer (T-3.13.1.1, FN-130),
// the travel-rule report generator (T-3.13.1.4, FN-133),
// and the SPL Memo Program v2 indexer (FN-093).

export * from "./audit-trail.js";
export * from "./travel-rule.js";

// FN-093: Memo indexer interface + in-memory and Postgres adapters.
export type {
  MemoEntry,
  MemoQuery,
  MemoQueryResult,
  MemoIndex,
} from "./memo-index.js";
export { InMemoryMemoIndex } from "./memo-index.js";
export type {
  PgQueryFn,
  PostgresMemoIndexInit,
} from "./memo-index.postgres.js";
export {
  MEMO_ENTRIES_SCHEMA_SQL,
  PostgresMemoIndex,
} from "./memo-index.postgres.js";

// FN-105: Memo block ingester — logsSubscribe → ingestBatch pipeline.
export { MemoBlockIngester, createMemoBlockIngesterFromEnv } from "./memo-ingester.js";
export type { MemoBlockIngesterDeps, IngesterStats } from "./memo-ingester.js";
export { extractMemoEntries, tryParseMemoEnvelope, MEMO_PROGRAM_ID } from "./parse-memo-instructions.js";
export type { ConfirmedTxLike } from "./parse-memo-instructions.js";
export {
  InMemoryCheckpointStore,
  PostgresCheckpointStore,
  createCheckpointStoreFromEnv,
  MemoIngesterError,
} from "./memo-ingester-checkpoint.js";
export type {
  MemoIngesterCheckpointStore,
  PostgresCheckpointStoreInit,
} from "./memo-ingester-checkpoint.js";

// FN-084: VC signer abstractions for `Ed25519Signature2020` proof blocks
// over the audit-trail and travel-rule JSON-LD documents.
export {
  DEFAULT_UNSIGNED_DID,
  Ed25519VcSigner,
  NoOpVcSigner,
  base64UrlEncode,
  canonicalizeJcs,
  createVcSignerFromEnv,
} from "./vc-signer.js";
export type {
  CreateVcSignerFromEnvOpts,
  Ed25519Signature2020Proof,
  Ed25519VcSignerFromKeyFileOpts,
  Ed25519VcSignerInit,
  VcSigner,
} from "./vc-signer.js";
